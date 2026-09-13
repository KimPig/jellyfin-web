import type {
    SubtitleClockSnapshot,
    SubtitleLoadRequest,
    SubtitleRenderer
} from '../types';

const PRESCALE_FACTOR = 0.8;
const PRESCALE_HEIGHT_LIMIT = 1080;
const MAX_RENDER_HEIGHT = 2160;
const RENDERER_READY_TIMEOUT_MS = 30_000;
const FRAME_TIMEOUT_MS = 5_000;

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
    worker: Worker;
    onWorkerMessage(event: MessageEvent): void;
    resize(width?: number, height?: number, top?: number, left?: number): void;
    dispose(): void;
}

type SubtitlesOctopusConstructor = new (
    options: Record<string, unknown>
) => SubtitlesOctopusInstance;

interface AssFrame {
    target: string;
    op?: string;
    iteration: number;
    canvases: Array<{ w: number; h: number; x: number; y: number; buffer: ArrayBuffer }>;
}

interface FrameRequest {
    id: number;
    epoch: number;
    time: number;
}

export class AssRendererAdapter implements SubtitleRenderer {
    readonly videoElement: HTMLVideoElement;
    readonly host: HTMLDivElement;
    readonly canvas: HTMLCanvasElement;
    readonly bufferCanvas = document.createElement('canvas');
    readonly renderer: SubtitlesOctopusInstance;
    readonly worker: Worker;
    readonly options: AssRendererOptions;
    readonly resizeObserver?: ResizeObserver;
    offsetSeconds = 0;
    latestTime?: number;
    lastRenderedTime?: number;
    pending?: FrameRequest;
    nextId = 0;
    epoch = 0;
    frameTimeout?: number;
    activationTimeout?: number;
    activation?: { resolve(): void; reject(error: unknown): void };
    active = false;
    disposed = false;
    failed = false;

    constructor(
        options: AssRendererOptions,
        host: HTMLDivElement,
        canvas: HTMLCanvasElement,
        renderer: SubtitlesOctopusInstance
    ) {
        this.options = options;
        this.videoElement = options.videoElement;
        this.host = host;
        this.canvas = canvas;
        this.renderer = renderer;
        this.worker = renderer.worker;

        // Use libass 4.2.4's existing forced, timestamped oneshot protocol.
        // Octopus' autonomous canvas/cache handlers must not repaint an old
        // frame after a seek or renderer replacement.
        renderer.worker.removeEventListener('message', renderer.onWorkerMessage);
        renderer.worker.addEventListener('message', this.onWorkerMessage);
        if (typeof ResizeObserver !== 'undefined') {
            this.resizeObserver = new ResizeObserver(this.resize);
            this.resizeObserver.observe(this.videoElement);
        }
        window.addEventListener('resize', this.resize);
        document.addEventListener('fullscreenchange', this.resize);
    }

    activate(snapshot: SubtitleClockSnapshot) {
        if (this.disposed) return Promise.reject(new Error('ASS renderer was disposed'));
        this.active = true;
        return new Promise<void>((resolve, reject) => {
            this.activation = { resolve, reject };
            this.update(snapshot);
        });
    }

    update(snapshot: SubtitleClockSnapshot) {
        if (this.disposed || this.failed || !this.active) return;
        this.latestTime = snapshot.currentTime
            + this.options.baseTimeOffsetSeconds
            + this.offsetSeconds;

        if (snapshot.reason !== 'frame') this.invalidate();
        this.resize();
        this.requestFrame();
    }

    setOffset(offsetSeconds: number) {
        if (this.offsetSeconds === offsetSeconds) return;
        this.offsetSeconds = offsetSeconds;
        this.invalidate();
    }

    invalidate() {
        this.epoch++;
        this.lastRenderedTime = undefined;
        this.canvas.getContext('2d')?.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }

    requestFrame() {
        if (this.disposed || this.failed || this.pending || this.latestTime === undefined) return;
        if (!this.videoElement.videoWidth || !this.videoElement.videoHeight
            || !this.videoElement.offsetWidth || !this.videoElement.offsetHeight) return;
        const minimumInterval = 1 / Math.max(1, this.options.targetFps || 24);
        if (
            this.lastRenderedTime !== undefined
            && Math.abs(this.latestTime - this.lastRenderedTime) < minimumInterval
        ) return;

        // Coalesce clock updates behind one request. renderNow forces unchanged
        // and empty frames too, without waiting for a new cue or a user seek.
        const pending = { id: ++this.nextId, epoch: this.epoch, time: this.latestTime };
        this.pending = pending;
        if (this.activation && this.activationTimeout === undefined) {
            this.activationTimeout = window.setTimeout(() => {
                this.fail(new Error('ASS worker did not render a current frame within 10 seconds'));
            }, 10_000);
        }
        this.frameTimeout = window.setTimeout(() => {
            this.fail(new Error('ASS worker did not return a subtitle frame within 5 seconds'));
        }, FRAME_TIMEOUT_MS);
        this.worker.postMessage({
            target: 'oneshot-render',
            iteration: pending.id,
            lastRendered: pending.time,
            renderNow: true
        });
    }

    onWorkerMessage = (event: MessageEvent<AssFrame>) => {
        if (this.disposed || this.failed) return;
        if (event.data.target !== 'canvas') {
            this.renderer.onWorkerMessage(event);
            return;
        }
        if (event.data.op !== 'oneshot-result') return;
        const pending = this.pending;
        if (!pending || pending.id !== event.data.iteration) return;
        this.clearFrameTimeout();
        this.pending = undefined;

        try {
            const current = pending.epoch === this.epoch;
            const fresh = !this.activation
                || Math.abs(pending.time - (this.latestTime ?? pending.time)) < 0.25;
            if (current && fresh) {
                this.paint(event.data);
                this.lastRenderedTime = pending.time;
                this.host.style.visibility = 'visible';
                this.activation?.resolve();
                this.activation = undefined;
                this.clearActivationTimeout();
            }
            this.requestFrame();
        } catch (error) {
            this.fail(error);
        }
    };

    paint(frame: AssFrame) {
        const context = this.canvas.getContext('2d');
        const bufferContext = this.bufferCanvas.getContext('2d');
        if (!context || !bufferContext) throw new Error('Unable to create ASS canvas context');
        context.clearRect(0, 0, this.canvas.width, this.canvas.height);
        for (const part of frame.canvases) {
            this.bufferCanvas.width = part.w;
            this.bufferCanvas.height = part.h;
            const imageData = bufferContext.createImageData(part.w, part.h);
            imageData.data.set(new Uint8ClampedArray(part.buffer));
            bufferContext.putImageData(imageData, 0, 0);
            context.drawImage(this.bufferCanvas, part.x, part.y);
        }
    }

    fail(error: unknown) {
        if (this.disposed || this.failed) return;
        this.failed = true;
        this.clearFrameTimeout();
        this.clearActivationTimeout();
        if (this.activation) {
            this.activation.reject(error);
            this.activation = undefined;
        } else {
            // isCurrent() only describes loading. The pipeline checks the active
            // generation itself, including while a replacement is loading.
            this.options.onRuntimeFallbackRequested?.();
            this.options.request.reportRuntimeError(error);
        }
    }

    clearFrameTimeout() {
        if (this.frameTimeout === undefined) return;
        window.clearTimeout(this.frameTimeout);
        this.frameTimeout = undefined;
    }

    clearActivationTimeout() {
        if (this.activationTimeout === undefined) return;
        window.clearTimeout(this.activationTimeout);
        this.activationTimeout = undefined;
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.active = false;
        this.activation?.reject(new Error('Subtitle load was cancelled'));
        this.activation = undefined;
        this.resizeObserver?.disconnect();
        this.clearFrameTimeout();
        this.clearActivationTimeout();
        this.worker.removeEventListener('message', this.onWorkerMessage);
        window.removeEventListener('resize', this.resize);
        document.removeEventListener('fullscreenchange', this.resize);
        try {
            if (this.renderer.worker) this.renderer.dispose();
        } finally {
            this.host.remove();
        }
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

        const hostOffset = this.host.getBoundingClientRect().top
            - this.videoElement.getBoundingClientRect().top;
        Object.assign(this.canvas.style, {
            display: 'block',
            position: 'absolute',
            width: `${displayWidth}px`,
            height: `${displayHeight}px`,
            top: `${(elementHeight - displayHeight) / 2 - hostOffset}px`,
            left: `${(elementWidth - displayWidth) / 2}px`,
            pointerEvents: 'none'
        });
        const size = computeAssRenderSize(displayWidth, displayHeight, window.devicePixelRatio || 1);
        const width = Math.max(1, Math.floor(size.width));
        const height = Math.max(1, Math.floor(size.height));
        if (this.canvas.width !== width || this.canvas.height !== height) {
            this.renderer.resize(width, height);
            this.invalidate();
            this.requestFrame();
        }
    };
}

export async function createAssRendererAdapter(options: AssRendererOptions): Promise<SubtitleRenderer> {
    const { default: SubtitlesOctopus } = await import('@jellyfin/libass-wasm') as {
        default: SubtitlesOctopusConstructor;
    };
    if (!options.request.isCurrent()) throw new Error('Subtitle load was cancelled');
    const parentElement = options.videoElement.parentElement;
    if (!parentElement) throw new Error('Unable to attach the ASS subtitle renderer');

    const primaryFonts = [ ...new Set(options.fonts) ];
    const fallbackFonts = [ ...new Set(options.fallbackFonts || []) ];
    const fontSets = [ primaryFonts ];
    if (fallbackFonts.length && fallbackFonts.join('\n') !== primaryFonts.join('\n')) {
        fontSets.push(fallbackFonts);
    }

    for (const fonts of fontSets) {
        try {
            return await prepareAssRenderer(SubtitlesOctopus, options, parentElement, fonts);
        } catch (error) {
            if (!options.request.isCurrent() || fonts === fontSets[fontSets.length - 1]) throw error;
        }
    }
    throw new Error('Unable to initialize ASS subtitles');
}

function prepareAssRenderer(
    SubtitlesOctopus: SubtitlesOctopusConstructor,
    options: AssRendererOptions,
    parentElement: HTMLElement,
    fonts: string[]
): Promise<SubtitleRenderer> {
    const host = document.createElement('div');
    host.classList.add('libassjs-canvas-parent', 'subtitle-pipeline-ass');
    Object.assign(host.style, {
        position: 'absolute', inset: '0', width: '100%', height: '100%',
        overflow: 'hidden', pointerEvents: 'none', visibility: 'hidden', zIndex: '1'
    });
    const canvas = document.createElement('canvas');
    canvas.classList.add('libassjs-canvas');
    host.appendChild(canvas);
    parentElement.appendChild(host);

    return new Promise<SubtitleRenderer>((resolve, reject) => {
        let renderer: SubtitlesOctopusInstance | undefined;
        let adapter: AssRendererAdapter | undefined;
        let settled = false;
        let unsubscribeCancel: () => void = () => undefined;
        const timeout = window.setTimeout(() => {
            fail(new Error('ASS renderer did not finish loading subtitles and fonts within 30 seconds'));
        }, RENDERER_READY_TIMEOUT_MS);
        const cleanup = () => {
            window.clearTimeout(timeout);
            renderer?.worker?.removeEventListener('message', onMessage);
        };
        const fail = (error: unknown) => {
            if (adapter) {
                adapter.fail(error);
                return;
            }
            if (settled) return;
            settled = true;
            cleanup();
            unsubscribeCancel();
            try {
                if (renderer?.worker) renderer.dispose();
            } finally {
                host.remove();
                reject(error);
            }
        };
        const onMessage = (event: MessageEvent) => {
            if (settled || !renderer || event.data.target !== 'get-styles') return;
            if (!options.request.isCurrent()) {
                fail(new Error('Subtitle load was cancelled'));
                return;
            }
            adapter = new AssRendererAdapter(options, host, canvas, renderer);
            settled = true;
            cleanup();
            resolve(adapter);
        };
        unsubscribeCancel = options.request.onCancel(() => {
            if (adapter) adapter.dispose();
            else fail(new Error('Subtitle load was cancelled'));
        });
        try {
            if (settled) return;
            renderer = new SubtitlesOctopus({
                canvas, subUrl: options.subtitleUrl, fonts,
                workerUrl: options.workerUrl, legacyWorkerUrl: options.legacyWorkerUrl,
                // Octopus disposes its worker immediately after this callback.
                // Recover in the next microtask to avoid disposing it twice.
                onError: (error: unknown) => { void Promise.resolve().then(() => fail(error)); },
                renderMode: 'wasm-blend', dropAllAnimations: false,
                libassMemoryLimit: 40, libassGlyphLimit: 40,
                targetFps: options.targetFps, renderAhead: 0
            });
            if (settled) {
                if (renderer.worker) renderer.dispose();
                return;
            }
            renderer.worker.addEventListener('message', onMessage);
            // Unlike onReady (the first worker message), this command is queued
            // until WASM, ASS parsing and eager font loading have all completed.
            renderer.worker.postMessage({ target: 'get-styles' });
        } catch (error) {
            fail(error);
        }
    });
}
