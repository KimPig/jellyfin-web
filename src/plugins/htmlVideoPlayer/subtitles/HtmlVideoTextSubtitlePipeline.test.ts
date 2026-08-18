import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('lib/jellyfin-apiclient', () => ({
    ServerConnections: {
        getApiClient: vi.fn()
    }
}));
vi.mock('../../../components/router/appRouter', () => ({
    appRouter: {
        baseUrl: () => ''
    }
}));
vi.mock('../subtitleFontBridgeResolver', () => ({
    resolveSubtitleFontBridge: vi.fn()
}));
vi.mock('./renderers/AssRendererAdapter', () => ({
    createAssRendererAdapter: vi.fn()
}));

import { ServerConnections } from 'lib/jellyfin-apiclient';

import { resolveSubtitleFontBridge } from '../subtitleFontBridgeResolver';
import { HtmlVideoTextSubtitlePipeline } from './HtmlVideoTextSubtitlePipeline';
import { createAssRendererAdapter } from './renderers/AssRendererAdapter';
import type { SubtitleRenderer } from './types';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(resolvePromise => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

function createRenderer() {
    return {
        activate: vi.fn(),
        update: vi.fn(),
        setOffset: vi.fn(),
        dispose: vi.fn()
    } satisfies SubtitleRenderer;
}

function createPipeline(
    fetchSubtitleData: (signal?: AbortSignal) => Promise<{ TrackEvents?: [] }>,
    onStateChange = vi.fn()
) {
    const parent = document.createElement('div');
    const video = document.createElement('video');
    parent.appendChild(video);

    return new HtmlVideoTextSubtitlePipeline({
        videoElement: video,
        onStateChange,
        getPlaybackOptions: () => ({
            item: { Id: 'item', ServerId: 'server' },
            mediaSource: { Id: 'source', MediaStreams: [] }
        }),
        getSubtitleUrl: () => '/subtitle',
        fetchSubtitleData: (_track, _item, signal) => fetchSubtitleData(signal),
        resolveUrl: async url => url,
        applyAppearance: () => undefined,
        secondaryBeforePrimary: () => false,
        onAssError: () => undefined
    });
}

afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.restoreAllMocks();
});

describe('HtmlVideoTextSubtitlePipeline', () => {
    it('aborts an unfinished text-subtitle request when the slot is cleared', async () => {
        let requestSignal: AbortSignal | undefined;
        const fetchSubtitleData = vi.fn((signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
            requestSignal = signal;
            signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }));
        const pipeline = createPipeline(fetchSubtitleData);

        const selection = pipeline.select(0, { Index: 2, Codec: 'srt' });
        await vi.waitFor(() => expect(requestSignal).toBeDefined());
        pipeline.clear(0);
        await selection;

        expect(requestSignal?.aborted).toBe(true);
        expect(pipeline.getTrackIndex(0)).toBeUndefined();
        pipeline.dispose();
    });

    it('aborts and reports a text-subtitle request that exceeds the timeout', async () => {
        vi.useFakeTimers();
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        let requestSignal: AbortSignal | undefined;
        const onStateChange = vi.fn();
        const fetchSubtitleData = vi.fn((signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
            requestSignal = signal;
            signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }));
        const pipeline = createPipeline(fetchSubtitleData, onStateChange);

        const selection = pipeline.select(0, { Index: 3, Codec: 'srt' });
        for (let index = 0; index < 4 && !requestSignal; index++) {
            await Promise.resolve();
        }
        expect(requestSignal).toBeDefined();

        await vi.advanceTimersByTimeAsync(30_000);
        await selection;

        expect(requestSignal?.aborted).toBe(true);
        expect(onStateChange).toHaveBeenLastCalledWith(expect.objectContaining({
            trackIndex: 3,
            state: 'failed',
            restoredTrackIndex: -1,
            error: expect.objectContaining({
                message: 'Subtitle request timed out after 30 seconds.'
            })
        }));
        pipeline.dispose();
    });

    it('shares ASS preflight requests across cancelled and repeated selections', async () => {
        const bridge = deferred<{ fontUrls: string[]; fullyResolved: boolean }>();
        const getNamedConfiguration = vi.fn().mockResolvedValue({ EnableFallbackFont: true });
        const getJSON = vi.fn().mockResolvedValue([ { Name: 'fallback.ttf' } ]);
        const apiClient = {
            accessToken: vi.fn(() => 'token'),
            getJSON,
            getNamedConfiguration,
            getUrl: vi.fn((path: string) => `https://example.test/${path.startsWith('/') ? path.slice(1) : path}`)
        };
        vi.mocked(ServerConnections.getApiClient).mockReturnValue(apiClient as never);
        vi.mocked(resolveSubtitleFontBridge).mockReturnValue(bridge.promise);
        vi.mocked(createAssRendererAdapter).mockImplementation(async () => createRenderer());
        const pipeline = createPipeline(async () => ({ TrackEvents: [] }));

        const staleAssSelection = pipeline.select(0, { Index: 2, Codec: 'ass' });
        await vi.waitFor(() => expect(resolveSubtitleFontBridge).toHaveBeenCalledOnce());
        await pipeline.select(0, { Index: 3, Codec: 'srt' });
        const currentAssSelection = pipeline.select(0, { Index: 2, Codec: 'ass' });

        expect(resolveSubtitleFontBridge).toHaveBeenCalledOnce();
        expect(getNamedConfiguration).toHaveBeenCalledOnce();
        bridge.resolve({
            fontUrls: [ 'https://example.test/bridge.ttf' ],
            fullyResolved: true
        });
        await Promise.all([ staleAssSelection, currentAssSelection ]);

        expect(resolveSubtitleFontBridge).toHaveBeenCalledOnce();
        expect(getNamedConfiguration).toHaveBeenCalledOnce();
        expect(getJSON).toHaveBeenCalledOnce();
        expect(createAssRendererAdapter).toHaveBeenCalledOnce();
        expect(pipeline.getTrackIndex(0)).toBe(2);
        pipeline.dispose();
    });

    it('reuses an in-flight ASS preflight after subtitles are turned off', async () => {
        const bridge = deferred<{ fontUrls: string[]; fullyResolved: boolean }>();
        const getNamedConfiguration = vi.fn().mockResolvedValue({ EnableFallbackFont: false });
        const apiClient = {
            accessToken: vi.fn(() => 'token'),
            getJSON: vi.fn(),
            getNamedConfiguration,
            getUrl: vi.fn((path: string) => `https://example.test/${path.startsWith('/') ? path.slice(1) : path}`)
        };
        vi.mocked(ServerConnections.getApiClient).mockReturnValue(apiClient as never);
        vi.mocked(resolveSubtitleFontBridge).mockReturnValue(bridge.promise);
        vi.mocked(createAssRendererAdapter).mockImplementation(async () => createRenderer());
        const pipeline = createPipeline(async () => ({ TrackEvents: [] }));

        const staleSelection = pipeline.select(0, { Index: 2, Codec: 'ass' });
        await vi.waitFor(() => expect(resolveSubtitleFontBridge).toHaveBeenCalledOnce());
        pipeline.clear(0);
        const restoredSelection = pipeline.select(0, { Index: 2, Codec: 'ass' });
        bridge.resolve({ fontUrls: [], fullyResolved: false });
        await Promise.all([ staleSelection, restoredSelection ]);

        expect(resolveSubtitleFontBridge).toHaveBeenCalledOnce();
        expect(getNamedConfiguration).toHaveBeenCalledOnce();
        expect(createAssRendererAdapter).toHaveBeenCalledOnce();
        expect(pipeline.getTrackIndex(0)).toBe(2);
        pipeline.dispose();
    });
});
