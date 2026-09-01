import type {
    SubtitleClockSnapshot,
    SubtitleLoadRequest,
    SubtitleRenderer
} from '../types';

const PRESCALE_FACTOR = 0.8;
const PRESCALE_HEIGHT_LIMIT = 1080;
const MAX_RENDER_HEIGHT = 2160;
const RENDERER_READY_TIMEOUT_MS = 10_000;

export function computeAssRenderSize(width: number, height: number, pixelRatio: number) {
    const sourceWidth = width * pixelRatio;
    const sourceHeight = height * pixelRatio;
    let renderHeight = sourceHeight;
    const direction = PRESCALE_FACTOR < 1 ? -1 : 1;

    if (direction * renderHeight * PRESCALE_FACTOR <= direction * PRESCALE_HEIGHT_LIMIT) {
        renderHeight *= PRESCALE_FACTOR;
    } else if (direction * renderHeight < direction * PRESCALE_HEIGHT_LIMIT) {
        renderHeight = PRESCALE_HEIGHT_LIMIT;
    }

    if (MAX_RENDER_HEIGHT > 0 && renderHeight > MAX_RENDER_HEIGHT) {
        renderHeight = MAX_RENDER_HEIGHT;
    }

    return {
        width: sourceWidth * renderHeight / sourceHeight,
        height: renderHeight
    };
}

interface AssRendererOptions {
    videoElement: HTMLVideoElement;
    subtitleUrl: string;
    fonts: string[];
    fallbackFonts?: string[];
    workerUrl: string;
    legacyWorkerUrl: string;
    baseTimeOffsetSeconds: number;
    targetFps: number;
    request: SubtitleLoadRequest;
    onRuntimeFallbackRequested?(): void;
}

interface SubtitlesOctopusInstance {
    resize(width?: number, height?: number, top?: number, left?: number): void;
    setCurrentTime(time: number): void;
    setIsPaused(paused: boolean, time: number): void;
    setRate(rate: number): void;
    dispose(): void;
}

type SubtitlesOctopusConstructor = new (
    options: Record<string, unknown>
) => SubtitlesOctopusInstance;

export class AssRendererAdapter implements SubtitleRenderer {
    readonly videoElement: HTMLVideoElement;
    readonly host: HTMLDivElement;
    readonly canvas: HTMLCanvasElement;
    readonly renderer: SubtitlesOctopusInstance;
    readonly baseTimeOffsetSeconds: number;
    readonly targetFps: number;
    readonly resizeObserver?: ResizeObserver;
    offsetSeconds = 0;
    lastRate?: number;
    lastPaused?: boolean;
    lastRenderedTime?: number;
    resyncFrameHandle?: number;
    active = false;
    disposed = false;

    constructor(
        options: AssRendererOptions,
        host: HTMLDivElement,
        canvas: HTMLCanvasElement,
        renderer: SubtitlesOctopusInstance
    ) {
        this.videoElement = options.videoElement;
        this.host = host;
        this.canvas = canvas;
        this.renderer = renderer;
        this.baseTimeOffsetSeconds = options.baseTimeOffsetSeconds;
        this.targetFps = Math.max(1, options.targetFps || 24);

        if (typeof ResizeObserver !== 'undefined') {
            this.resizeObserver = new ResizeObserver(this.resize);
            this.resizeObserver.observe(this.videoElement);
        }
        window.addEventListener('resize', this.resize);
        document.addEventListener('fullscreenchange', this.resize);
    }

    activate(snapshot: SubtitleClockSnapshot) {
        if (this.disposed) return;
        this.active = true;
        this.resize();
        this.clearCanvas();
        this.update(snapshot);
        // The canvas starts hidden and is only exposed after its final size and
        // clock state are applied. This avoids briefly painting libass' default
        // canvas size while switching from a text renderer.
        this.host.style.visibility = 'visible';
    }

    update(snapshot: SubtitleClockSnapshot) {
        if (this.disposed || !this.active) return;

        const effectiveTime = snapshot.currentTime
            + this.baseTimeOffsetSeconds
            + this.offsetSeconds;
        const force = snapshot.reason !== 'frame';
        const discontinuity = snapshot.reason === 'loadstart'
            || snapshot.reason === 'emptied'
            || snapshot.reason === 'seeking';
        const rendererPaused = snapshot.paused || discontinuity;

        if (discontinuity) {
            this.cancelResync();
            this.clearCanvas();
            this.lastRenderedTime = undefined;
        }

        if (force || this.lastRate !== snapshot.playbackRate) {
            this.lastRate = snapshot.playbackRate;
            this.renderer.setRate(snapshot.playbackRate);
        }
        if (force || this.lastPaused !== rendererPaused) {
            this.lastPaused = rendererPaused;
            this.renderer.setIsPaused(rendererPaused, effectiveTime);
        }

        const minimumInterval = 1 / this.targetFps;
        if (
            force
            || this.lastRenderedTime === undefined
            || Math.abs(effectiveTime - this.lastRenderedTime) >= minimumInterval
        ) {
            this.lastRenderedTime = effectiveTime;
            this.renderer.setCurrentTime(effectiveTime);
        }

        if (
            snapshot.reason === 'loadedmetadata'
            || snapshot.reason === 'playing'
            || snapshot.reason === 'seeked'
        ) {
            this.scheduleResync(snapshot, effectiveTime);
        }
    }

    setOffset(offsetSeconds: number) {
        this.offsetSeconds = offsetSeconds;
        this.lastRenderedTime = undefined;
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.active = false;
        this.resizeObserver?.disconnect();
        this.cancelResync();
        window.removeEventListener('resize', this.resize);
        document.removeEventListener('fullscreenchange', this.resize);

        try {
            this.renderer.dispose();
        } finally {
            this.host.remove();
        }
    }

    clearCanvas() {
        // Resetting the bitmap dimensions clears every previously painted ASS
        // frame even when libass has not produced a replacement frame yet.
        const { width, height } = this.canvas;
        this.canvas.width = width;
        this.canvas.height = height;
    }

    cancelResync() {
        if (this.resyncFrameHandle === undefined) return;
        cancelAnimationFrame(this.resyncFrameHandle);
        this.resyncFrameHandle = undefined;
    }

    scheduleResync(snapshot: SubtitleClockSnapshot, effectiveTime: number) {
        this.cancelResync();
        this.resyncFrameHandle = requestAnimationFrame(() => {
            this.resyncFrameHandle = undefined;
            if (this.disposed || !this.active) return;

            this.lastRate = snapshot.playbackRate;
            this.lastPaused = snapshot.paused;
            this.lastRenderedTime = effectiveTime;
            this.renderer.setRate(snapshot.playbackRate);
            this.renderer.setIsPaused(snapshot.paused, effectiveTime);
            this.renderer.setCurrentTime(effectiveTime);
        });
    }

    resize = () => {
        if (this.disposed || !this.active) return;

        const videoWidth = this.videoElement.videoWidth;
        const videoHeight = this.videoElement.videoHeight;
        const elementWidth = this.videoElement.offsetWidth;
        const elementHeight = this.videoElement.offsetHeight;
        if (!videoWidth || !videoHeight || !elementWidth || !elementHeight) return;

        const videoRatio = videoWidth / videoHeight;
        const elementRatio = elementWidth / elementHeight;
        let displayWidth = elementWidth;
        let displayHeight = elementHeight;
        if (elementRatio > videoRatio) {
            displayWidth = Math.floor(elementHeight * videoRatio);
        } else {
            displayHeight = Math.floor(elementWidth / videoRatio);
        }

        const x = (elementWidth - displayWidth) / 2;
        const y = (elementHeight - displayHeight) / 2;
        const hostOffset = this.host.getBoundingClientRect().top
            - this.videoElement.getBoundingClientRect().top;
        const pixelRatio = window.devicePixelRatio || 1;

        this.canvas.style.display = 'block';
        this.canvas.style.position = 'absolute';
        this.canvas.style.width = `${displayWidth}px`;
        this.canvas.style.height = `${displayHeight}px`;
        this.canvas.style.top = `${y - hostOffset}px`;
        this.canvas.style.left = `${x}px`;
        this.canvas.style.pointerEvents = 'none';
        const renderSize = computeAssRenderSize(displayWidth, displayHeight, pixelRatio);
        this.renderer.resize(renderSize.width, renderSize.height);
    };
}

export async function createAssRendererAdapter(options: AssRendererOptions) {
    const { default: SubtitlesOctopus } = await import('@jellyfin/libass-wasm') as {
        default: SubtitlesOctopusConstructor;
    };

    if (!options.request.isCurrent()) {
        throw new Error('Subtitle load was cancelled');
    }

    const parentElement = options.videoElement.parentElement;
    if (!parentElement) {
        throw new Error('Unable to attach the ASS subtitle renderer');
    }

    const host = document.createElement('div');
    host.classList.add('libassjs-canvas-parent', 'subtitle-pipeline-ass');
    Object.assign(host.style, {
        position: 'absolute',
        inset: '0',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        pointerEvents: 'none',
        visibility: 'hidden',
        zIndex: '1'
    });
    const canvas = document.createElement('canvas');
    canvas.classList.add('libassjs-canvas');
    host.appendChild(canvas);
    parentElement.appendChild(host);

    return new Promise<SubtitleRenderer>((resolve, reject) => {
        const primaryFonts = [ ...new Set(options.fonts) ];
        const fallbackFonts = [ ...new Set(options.fallbackFonts || []) ];
        const fontSets = [ primaryFonts ];
        if (fallbackFonts.length > 0 && fallbackFonts.join('\n') !== primaryFonts.join('\n')) {
            fontSets.push(fallbackFonts);
        }

        let renderer: SubtitlesOctopusInstance | undefined;
        let fontSetIndex = 0;
        let settled = false;
        let readyTimeout: number | undefined;
        let unsubscribeCancel: () => void = () => undefined;

        const clearReadyTimeout = () => {
            if (readyTimeout === undefined) return;
            window.clearTimeout(readyTimeout);
            readyTimeout = undefined;
        };

        const disposePending = () => {
            try {
                renderer?.dispose();
            } catch (error) {
                console.debug('Unable to dispose pending ASS renderer', error);
            }
            renderer = undefined;
        };
        const rejectOnce = (error: unknown) => {
            if (settled) return;
            settled = true;
            clearReadyTimeout();
            unsubscribeCancel();
            disposePending();
            host.remove();
            reject(error);
        };
        const onReady = () => {
            void Promise.resolve().then(() => {
                if (settled || !renderer || !options.request.isCurrent()) return;

                const adapter = new AssRendererAdapter(options, host, canvas, renderer);
                settled = true;
                clearReadyTimeout();
                unsubscribeCancel();
                resolve(adapter);
            });
        };
        const onError = (error: unknown) => {
            if (!options.request.isCurrent()) return;
            if (settled) {
                options.onRuntimeFallbackRequested?.();
                options.request.reportRuntimeError(error);
                return;
            }

            disposePending();
            clearReadyTimeout();
            fontSetIndex++;
            if (fontSetIndex < fontSets.length) {
                setTimeout(createRenderer, 0);
            } else {
                rejectOnce(error instanceof Error ? error : new Error('Unable to initialize ASS subtitles'));
            }
        };
        const createRenderer = () => {
            if (settled || !options.request.isCurrent()) return;

            try {
                renderer = new SubtitlesOctopus({
                    canvas,
                    subUrl: options.subtitleUrl,
                    fonts: fontSets[fontSetIndex] || [],
                    workerUrl: options.workerUrl,
                    legacyWorkerUrl: options.legacyWorkerUrl,
                    onReady,
                    onError,
                    renderMode: 'wasm-blend',
                    dropAllAnimations: false,
                    libassMemoryLimit: 40,
                    libassGlyphLimit: 40,
                    targetFps: options.targetFps,
                    prescaleFactor: PRESCALE_FACTOR,
                    prescaleHeightLimit: PRESCALE_HEIGHT_LIMIT,
                    maxRenderHeight: MAX_RENDER_HEIGHT,
                    resizeVariation: 0.2,
                    renderAhead: 0
                });
                readyTimeout = window.setTimeout(() => {
                    rejectOnce(new Error(`ASS renderer did not become ready within ${RENDERER_READY_TIMEOUT_MS / 1000} seconds.`));
                }, RENDERER_READY_TIMEOUT_MS);
            } catch (error) {
                rejectOnce(error);
            }
        };

        unsubscribeCancel = options.request.onCancel(() => {
            rejectOnce(new Error('Subtitle load was cancelled'));
        });
        createRenderer();
    });
}
