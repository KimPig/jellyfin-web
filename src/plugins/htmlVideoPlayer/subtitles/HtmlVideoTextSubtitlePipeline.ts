import { ServerConnections } from 'lib/jellyfin-apiclient';

import { appRouter } from '../../../components/router/appRouter';
import { resolveSubtitleFontBridge } from '../subtitleFontBridgeResolver';
import { TextSubtitlePipeline } from './TextSubtitlePipeline';
import { createAssRendererAdapter } from './renderers/AssRendererAdapter';
import { TextEventRenderer } from './renderers/TextEventRenderer';
import type {
    SubtitleLoadRequest,
    SubtitlePipelineStateChange,
    SubtitleRenderer,
    SubtitleSlot,
    SubtitleTrackEvent
} from './types';

const ASS_SUBTITLE_CODECS = [ 'ssa', 'ass' ];
const SUBTITLE_DATA_TIMEOUT_MS = 30_000;
const ASS_RESOURCE_TIMEOUT_MS = 5_000;
const SUPPORTED_FONT_MIME_TYPES = [
    'application/vnd.ms-opentype',
    'application/x-truetype-font',
    'font/otf',
    'font/ttf',
    'font/woff',
    'font/woff2'
];

interface SubtitleTrack {
    Index: number;
    Codec?: string | null;
}

interface MediaAttachment {
    MimeType?: string | null;
    DeliveryUrl: string;
}

interface MediaStream {
    Type?: string | null;
    ReferenceFrameRate?: number | null;
}

interface MediaSource {
    Id: string;
    MediaAttachments?: MediaAttachment[] | null;
    MediaStreams: MediaStream[];
}

interface PlaybackItem {
    Id: string;
    ServerId: string;
}

interface PlaybackOptions {
    item: PlaybackItem;
    mediaSource: MediaSource;
    transcodingOffsetTicks?: number | null;
}

interface SubtitleData {
    TrackEvents?: SubtitleTrackEvent[] | null;
}

interface HtmlVideoTextSubtitlePipelineOptions {
    videoElement: HTMLVideoElement;
    onStateChange?(change: SubtitlePipelineStateChange): void;
    getPlaybackOptions(): PlaybackOptions;
    getSubtitleUrl(track: SubtitleTrack, item: PlaybackItem): string;
    fetchSubtitleData(track: SubtitleTrack, item: PlaybackItem, signal?: AbortSignal): Promise<SubtitleData>;
    resolveUrl(url: string): Promise<string>;
    applyAppearance(container: HTMLElement, textElement: HTMLElement): void;
    secondaryBeforePrimary(): boolean;
    onAssError(error: unknown): void;
}

interface RendererAttemptState {
    useAssFallbackFonts: boolean;
}

interface EncodingConfiguration {
    EnableFallbackFont?: boolean;
}

interface AssRendererResources {
    bridgeFontUrls: string[];
    combinedFontUrls: string[];
    bridgeFullyResolved: boolean;
    workerUrl: string;
    legacyWorkerUrl: string;
}

async function resolveWithFallback<T>(
    promise: Promise<T>,
    fallback: T,
    description: string
) {
    let timeout: number | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_resolve, reject) => {
                timeout = window.setTimeout(() => {
                    reject(new Error(`${description} timed out.`));
                }, ASS_RESOURCE_TIMEOUT_MS);
            })
        ]);
    } catch (error) {
        console.debug(`${description} is unavailable; continuing without it.`, error instanceof Error ? error.message : error);
        return fallback;
    } finally {
        if (timeout !== undefined) window.clearTimeout(timeout);
    }
}

export class HtmlVideoTextSubtitlePipeline {
    readonly options: HtmlVideoTextSubtitlePipelineOptions;
    readonly pipeline: TextSubtitlePipeline;
    readonly assResourcePromises = new Map<number, Promise<AssRendererResources>>();

    constructor(options: HtmlVideoTextSubtitlePipelineOptions) {
        this.options = options;
        this.pipeline = new TextSubtitlePipeline(options.videoElement, {
            onStateChange: change => {
                const { trackIndex, state, error } = change;
                if (state === 'failed') {
                    console.error(`Failed to load subtitle track ${trackIndex}`, error);
                }
                this.options.onStateChange?.(change);
            }
        });
    }

    get videoElement() {
        return this.pipeline.videoElement;
    }

    getTrackIndex(slot: SubtitleSlot) {
        return this.pipeline.getTrackIndex(slot);
    }

    select(slot: SubtitleSlot, track: SubtitleTrack) {
        const playbackOptions = this.options.getPlaybackOptions();
        const attemptState: RendererAttemptState = {
            useAssFallbackFonts: false
        };
        return this.pipeline.select(slot, track.Index, request => (
            this.createRenderer(slot, track, playbackOptions, request, attemptState)
        ));
    }

    setOffset(slot: SubtitleSlot, offsetSeconds: number) {
        this.pipeline.setOffset(slot, offsetSeconds);
    }

    sync() {
        this.pipeline.sync();
    }

    clear(slot?: SubtitleSlot) {
        this.pipeline.clear(slot);
    }

    dispose() {
        this.assResourcePromises.clear();
        this.pipeline.dispose();
    }

    async createRenderer(
        slot: SubtitleSlot,
        track: SubtitleTrack,
        playbackOptions: PlaybackOptions,
        request: SubtitleLoadRequest,
        attemptState: RendererAttemptState
    ) {
        const format = (track.Codec || '').toLowerCase();
        if (ASS_SUBTITLE_CODECS.includes(format)) {
            return this.createAssRenderer(track, playbackOptions, request, attemptState);
        }

        // Jellyfin's legacy entry point installs abortcontroller-polyfill.
        // eslint-disable-next-line compat/compat
        const controller = new AbortController();
        let timedOut = false;
        const timeout = window.setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, SUBTITLE_DATA_TIMEOUT_MS);
        const unsubscribeCancel = request.onCancel(() => controller.abort());
        let subtitleData: SubtitleData;
        try {
            subtitleData = await this.options.fetchSubtitleData(
                track,
                playbackOptions.item,
                controller.signal
            );
        } catch (error) {
            if (timedOut) {
                throw new Error(`Subtitle request timed out after ${SUBTITLE_DATA_TIMEOUT_MS / 1000} seconds.`);
            }
            throw error;
        } finally {
            window.clearTimeout(timeout);
            unsubscribeCancel();
        }
        if (!request.isCurrent()) {
            throw new Error('Subtitle load was cancelled');
        }

        const parentElement = this.videoElement.parentElement;
        if (!parentElement) {
            throw new Error('Unable to attach the text subtitle renderer');
        }

        return new TextEventRenderer({
            parentElement,
            slot,
            trackEvents: subtitleData.TrackEvents || [],
            baseTimeOffsetSeconds: (playbackOptions.transcodingOffsetTicks || 0) / 10_000_000,
            secondaryBeforePrimary: this.options.secondaryBeforePrimary(),
            applyAppearance: this.options.applyAppearance
        });
    }

    async createAssRenderer(
        track: SubtitleTrack,
        playbackOptions: PlaybackOptions,
        request: SubtitleLoadRequest,
        attemptState: RendererAttemptState
    ): Promise<SubtitleRenderer> {
        const { item, mediaSource } = playbackOptions;
        const apiClient = ServerConnections.getApiClient(item.ServerId);
        if (!apiClient) {
            throw new Error('Unable to resolve the Jellyfin API client');
        }
        const videoStream = mediaSource.MediaStreams.find(stream => stream.Type === 'Video');
        const resources = await this.getAssRendererResources(track, playbackOptions, apiClient);

        if (!request.isCurrent()) {
            throw new Error('Subtitle load was cancelled');
        }
        const useBridgeFonts = resources.bridgeFullyResolved && !attemptState.useAssFallbackFonts;
        try {
            return await createAssRendererAdapter({
                videoElement: this.videoElement,
                subtitleUrl: this.options.getSubtitleUrl(track, item),
                fonts: useBridgeFonts ? resources.bridgeFontUrls : resources.combinedFontUrls,
                fallbackFonts: useBridgeFonts ? resources.combinedFontUrls : undefined,
                onRuntimeFallbackRequested: () => {
                    attemptState.useAssFallbackFonts = true;
                },
                workerUrl: resources.workerUrl,
                legacyWorkerUrl: resources.legacyWorkerUrl,
                baseTimeOffsetSeconds: (playbackOptions.transcodingOffsetTicks || 0) / 10_000_000,
                targetFps: videoStream?.ReferenceFrameRate || 24,
                request
            });
        } catch (error) {
            if (request.isCurrent()) {
                this.options.onAssError(error);
            }
            throw error;
        }
    }

    getAssRendererResources(
        track: SubtitleTrack,
        playbackOptions: PlaybackOptions,
        apiClient: NonNullable<ReturnType<typeof ServerConnections.getApiClient>>
    ) {
        const cached = this.assResourcePromises.get(track.Index);
        if (cached) return cached;

        const resources = this.loadAssRendererResources(track, playbackOptions, apiClient);
        this.assResourcePromises.set(track.Index, resources);
        void resources.catch(() => {
            if (this.assResourcePromises.get(track.Index) === resources) {
                this.assResourcePromises.delete(track.Index);
            }
        });
        return resources;
    }

    async loadAssRendererResources(
        track: SubtitleTrack,
        playbackOptions: PlaybackOptions,
        apiClient: NonNullable<ReturnType<typeof ServerConnections.getApiClient>>
    ): Promise<AssRendererResources> {
        const { item, mediaSource } = playbackOptions;
        const embeddedFonts = (mediaSource.MediaAttachments || [])
            .filter(attachment => attachment.MimeType && SUPPORTED_FONT_MIME_TYPES.includes(attachment.MimeType))
            .map(attachment => apiClient.getUrl(attachment.DeliveryUrl));
        const workerUrl = `${appRouter.baseUrl()}/libraries/subtitles-octopus-worker.js`;
        const legacyWorkerUrl = `${appRouter.baseUrl()}/libraries/subtitles-octopus-worker-legacy.js`;
        const [ config, resolvedWorkerUrl, resolvedLegacyWorkerUrl, bridge ] = await Promise.all([
            resolveWithFallback(
                apiClient.getNamedConfiguration('encoding') as Promise<EncodingConfiguration>,
                {},
                'Jellyfin encoding configuration request'
            ),
            this.options.resolveUrl(workerUrl),
            this.options.resolveUrl(legacyWorkerUrl),
            resolveSubtitleFontBridge(apiClient, item.Id, mediaSource.Id, track.Index)
        ]);

        const resolvedFonts = [ ...bridge.fontUrls ];
        if (config.EnableFallbackFont) {
            const fallbackFontList = apiClient.getUrl('/FallbackFont/Fonts', {
                ApiKey: apiClient.accessToken()
            });
            const fontFiles = await resolveWithFallback<Array<{ Name: string }>>(
                apiClient.getJSON(fallbackFontList),
                [],
                'Jellyfin fallback font list request'
            );
            for (const font of fontFiles) {
                resolvedFonts.push(apiClient.getUrl(`/FallbackFont/Fonts/${encodeURIComponent(font.Name)}`, {
                    ApiKey: apiClient.accessToken()
                }));
            }
        }

        const bridgeFontUrls = [ ...new Set(resolvedFonts) ];
        return {
            bridgeFontUrls,
            combinedFontUrls: [ ...new Set([ ...embeddedFonts, ...bridgeFontUrls ]) ],
            bridgeFullyResolved: bridge.fullyResolved,
            workerUrl: resolvedWorkerUrl,
            legacyWorkerUrl: resolvedLegacyWorkerUrl
        };
    }
}
