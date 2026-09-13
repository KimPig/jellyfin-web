import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TextSubtitlePipeline } from '../TextSubtitlePipeline';
import type { SubtitleLoadRequest, SubtitleRenderer } from '../types';
import { computeAssRenderSize, createAssRendererAdapter } from './AssRendererAdapter';

interface MockOptions extends Record<string, unknown> {
    canvas: HTMLCanvasElement;
    fonts: string[];
    onError(error: unknown): void;
}

interface RenderMessage {
    target: string;
    iteration?: number;
    lastRendered?: number;
    renderNow?: boolean;
}

class MockWorker extends EventTarget {
    messages: RenderMessage[] = [];
    postMessage(message: RenderMessage) {
        this.messages.push(message);
    }
    emit(data: unknown) {
        this.dispatchEvent(new MessageEvent('message', { data }));
    }
    ready() {
        this.emit({ target: 'get-styles', styles: [] });
    }
    frame(message = this.messages.filter(m => m.target === 'oneshot-render').at(-1)) {
        this.emit({ target: 'canvas', op: 'oneshot-result', iteration: message?.iteration, canvases: [] });
    }
}

const octopusMock = vi.hoisted(() => ({ instances: [] as MockOctopus[] }));
class MockOctopus {
    readonly worker = new MockWorker();
    readonly onWorkerMessage = vi.fn();
    disposed = false;
    constructor(readonly options: MockOptions) {
        octopusMock.instances.push(this);
        this.worker.addEventListener('message', this.onWorkerMessage);
    }
    resize(width: number, height: number) {
        this.options.canvas.width = width;
        this.options.canvas.height = height;
    }
    dispose() {
        this.disposed = true;
    }
}

vi.mock('@jellyfin/libass-wasm', () => ({ default: MockOctopus }));

const renderers: SubtitleRenderer[] = [];
const pipelines: TextSubtitlePipeline[] = [];
const clearRect = vi.fn();

function createRequest() {
    let current = true;
    let cancel: (() => void) | undefined;
    const request: SubtitleLoadRequest = {
        isCurrent: () => current,
        onCancel: callback => {
            cancel = callback;
            return () => {
                cancel = undefined;
            };
        },
        reportRuntimeError: vi.fn()
    };
    return {
        request,
        invalidate: () => { current = false; },
        cancel: () => {
            current = false;
            cancel?.();
        }
    };
}

function createVideo() {
    const parent = document.createElement('div');
    const video = document.createElement('video');
    parent.appendChild(video);
    Object.defineProperties(video, {
        videoWidth: { configurable: true, value: 1920 },
        videoHeight: { configurable: true, value: 1080 },
        offsetWidth: { configurable: true, value: 1280 },
        offsetHeight: { configurable: true, value: 720 },
        currentTime: { configurable: true, writable: true, value: 3 }
    });
    return { parent, video };
}

function createOptions(request: SubtitleLoadRequest, videoElement: HTMLVideoElement) {
    return {
        videoElement,
        subtitleUrl: 'https://example.test/subtitle.ass',
        fonts: [ 'https://example.test/bridge.ttf' ],
        fallbackFonts: [ 'https://example.test/bridge.ttf', 'https://example.test/embedded.ttf' ],
        workerUrl: '/worker.js',
        legacyWorkerUrl: '/worker-legacy.js',
        baseTimeOffsetSeconds: 2,
        targetFps: 24,
        request
    };
}

const snapshot = (currentTime: number, reason: 'selection' | 'frame' | 'seeking' | 'seeked' | 'loadedmetadata' = 'frame') => (
    { currentTime, paused: false, playbackRate: 1, reason }
);

async function loadRenderer() {
    const { parent, video } = createVideo();
    const request = createRequest();
    const promise = createAssRendererAdapter(createOptions(request.request, video));
    await vi.waitFor(() => expect(octopusMock.instances).toHaveLength(1));
    const octopus = octopusMock.instances[0];
    octopus.worker.ready();
    const renderer = await promise;
    renderers.push(renderer);
    return { parent, video, request, renderer, octopus };
}

beforeEach(() => {
    octopusMock.instances = [];
    clearRect.mockClear();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
        clearRect,
        createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: vi.fn(),
        drawImage: vi.fn()
    } as unknown as CanvasRenderingContext2D);
});

afterEach(() => {
    pipelines.splice(0).forEach(p => {
        p.dispose();
    });
    renderers.splice(0).forEach(r => {
        r.dispose();
    });
    vi.useRealTimers();
});

describe('ASS worker lifecycle', () => {
    it('matches libass prescaling for high-DPI and 4K canvases', () => {
        expect(computeAssRenderSize(1920, 1080, 1)).toEqual({ width: 1920, height: 1080 });
        expect(computeAssRenderSize(1920, 1080, 2)).toEqual({ width: 3072, height: 1728 });
    });

    it('ignores early worker messages and waits for the initialized track', async () => {
        const { video } = createVideo();
        const { request } = createRequest();
        let resolved = false;
        const promise = createAssRendererAdapter(createOptions(request, video)).then(renderer => {
            resolved = true;
            renderers.push(renderer);
        });
        await vi.waitFor(() => expect(octopusMock.instances).toHaveLength(1));
        const octopus = octopusMock.instances[0];
        expect(octopus.worker.messages).toContainEqual({ target: 'get-styles' });
        octopus.worker.emit({ target: 'ready' });
        octopus.worker.emit({ target: 'stdout', content: 'loading fonts' });
        await Promise.resolve();
        expect(resolved).toBe(false);
        octopus.worker.ready();
        await promise;
        expect(resolved).toBe(true);
    });

    it('keeps the old track until the first ASS frame, including an empty frame', async () => {
        const { video, parent } = createVideo();
        const pipeline = new TextSubtitlePipeline(video);
        pipelines.push(pipeline);
        const previous = { activate: vi.fn(), update: vi.fn(), setOffset: vi.fn(), dispose: vi.fn() };
        await pipeline.select(0, 1, async () => previous);
        const selection = pipeline.select(0, 2, request => createAssRendererAdapter(createOptions(request, video)));
        await vi.waitFor(() => expect(octopusMock.instances).toHaveLength(1));
        const octopus = octopusMock.instances[0];
        octopus.worker.ready();
        await vi.waitFor(() => expect(octopus.worker.messages.at(-1)?.target).toBe('oneshot-render'));
        expect(previous.dispose).not.toHaveBeenCalled();
        expect(pipeline.getActiveTrackIndex(0)).toBe(1);
        expect(parent.querySelector<HTMLElement>('.subtitle-pipeline-ass')?.style.visibility).toBe('hidden');
        octopus.worker.frame();
        await selection;
        expect(previous.dispose).toHaveBeenCalledOnce();
        expect(pipeline.getActiveTrackIndex(0)).toBe(2);
        expect(parent.querySelector<HTMLElement>('.subtitle-pipeline-ass')?.style.visibility).toBe('visible');
    });

    it('coalesces delayed frames and discards pre-seek responses', async () => {
        const { renderer, octopus, parent } = await loadRenderer();
        const activation = renderer.activate(snapshot(40, 'selection'));
        const stale = octopus.worker.messages.at(-1);
        renderer.update(snapshot(0, 'seeking'));
        renderer.update(snapshot(0, 'seeked'));
        expect(octopus.worker.messages.filter(m => m.target === 'oneshot-render')).toHaveLength(1);
        octopus.worker.frame(stale);
        expect(parent.querySelector<HTMLElement>('.subtitle-pipeline-ass')?.style.visibility).toBe('hidden');
        expect(octopus.worker.messages.at(-1)).toMatchObject({ lastRendered: 2, renderNow: true });
        octopus.worker.frame();
        await activation;
        const clears = clearRect.mock.calls.length;
        octopus.worker.frame(stale);
        expect(clearRect).toHaveBeenCalledTimes(clears);
        renderer.update(snapshot(0));
        expect(octopus.worker.messages.filter(m => m.target === 'oneshot-render')).toHaveLength(2);
    });

    it('refreshes a stale first frame to the latest playback time', async () => {
        const { renderer, octopus } = await loadRenderer();
        const activation = renderer.activate(snapshot(1, 'selection'));
        renderer.update(snapshot(10));
        octopus.worker.frame();
        expect(octopus.worker.messages.at(-1)?.lastRendered).toBe(12);
        octopus.worker.frame();
        await activation;
    });

    it('resizes when metadata arrives even without a layout change', async () => {
        const { renderer, video, octopus } = await loadRenderer();
        Object.defineProperty(video, 'videoWidth', { configurable: true, value: 0 });
        const activation = renderer.activate(snapshot(3, 'selection'));
        expect(octopus.worker.messages.filter(m => m.target === 'oneshot-render')).toHaveLength(0);
        Object.defineProperty(video, 'videoWidth', { configurable: true, value: 1920 });
        renderer.update(snapshot(3, 'loadedmetadata'));
        expect(octopus.options.canvas.width).toBe(1280);
        octopus.worker.frame();
        await activation;
    });

    it('recovers real pipeline runtime errors after loading is no longer current', async () => {
        const { video } = createVideo();
        const changes = vi.fn();
        const pipeline = new TextSubtitlePipeline(video, { onStateChange: changes });
        pipelines.push(pipeline);
        let activeRequest: SubtitleLoadRequest | undefined;
        const factory = (request: SubtitleLoadRequest) => {
            activeRequest = request;
            return createAssRendererAdapter(createOptions(request, video));
        };
        const selection = pipeline.select(0, 2, factory);
        await vi.waitFor(() => expect(octopusMock.instances).toHaveLength(1));
        octopusMock.instances[0].worker.ready();
        await vi.waitFor(() => expect(octopusMock.instances[0].worker.messages.at(-1)?.target).toBe('oneshot-render'));
        octopusMock.instances[0].worker.frame();
        await selection;
        expect(activeRequest?.isCurrent()).toBe(false);
        octopusMock.instances[0].options.onError(new Error('worker stopped'));
        await vi.waitFor(() => expect(octopusMock.instances).toHaveLength(2));
        octopusMock.instances[1].worker.ready();
        await vi.waitFor(() => expect(octopusMock.instances[1].worker.messages.at(-1)?.target).toBe('oneshot-render'));
        octopusMock.instances[1].worker.frame();
        await vi.waitFor(() => expect(pipeline.getActiveTrackIndex(0)).toBe(2));
        octopusMock.instances[1].options.onError(new Error('worker stopped again'));
        await Promise.resolve();
        expect(changes).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'failed' }));
        expect(octopusMock.instances).toHaveLength(2);
    });

    it('retries with embedded fonts and ignores callbacks from a retired attempt', async () => {
        const { video } = createVideo();
        const { request } = createRequest();
        const promise = createAssRendererAdapter(createOptions(request, video));
        await vi.waitFor(() => expect(octopusMock.instances).toHaveLength(1));
        const retired = octopusMock.instances[0];
        retired.options.onError(new Error('font failure'));
        await vi.waitFor(() => expect(octopusMock.instances).toHaveLength(2));
        retired.worker.ready();
        retired.options.onError(new Error('late failure'));
        expect(octopusMock.instances[1].disposed).toBe(false);
        expect(octopusMock.instances[1].options.fonts).toHaveLength(2);
        octopusMock.instances[1].worker.ready();
        renderers.push(await promise);
    });

    it('cancels activation without exposing a late frame', async () => {
        const { renderer, request, octopus, parent } = await loadRenderer();
        const activation = renderer.activate(snapshot(3, 'selection'));
        const rejection = expect(activation).rejects.toThrow('cancelled');
        request.cancel();
        octopus.worker.frame();
        await rejection;
        expect(parent.querySelector('.subtitle-pipeline-ass')).toBeNull();
    });

    it('times out actual track readiness even after an early ready message', async () => {
        vi.useFakeTimers();
        const { video } = createVideo();
        const { request } = createRequest();
        const promise = createAssRendererAdapter({ ...createOptions(request, video), fallbackFonts: [] });
        const rejection = expect(promise).rejects.toThrow('within 30 seconds');
        await vi.waitFor(() => expect(octopusMock.instances).toHaveLength(1));
        octopusMock.instances[0].worker.emit({ target: 'ready' });
        await vi.advanceTimersByTimeAsync(30_000);
        await rejection;
        expect(octopusMock.instances[0].disposed).toBe(true);
    });

    it('rejects a first frame that never arrives', async () => {
        vi.useFakeTimers();
        const { renderer } = await loadRenderer();
        const rejection = expect(renderer.activate(snapshot(3, 'selection'))).rejects.toThrow('within 5 seconds');
        await vi.advanceTimersByTimeAsync(5_000);
        await rejection;
    });

    it('bounds activation even when a slow worker keeps returning obsolete frames', async () => {
        vi.useFakeTimers();
        const { renderer, octopus } = await loadRenderer();
        const rejection = expect(renderer.activate(snapshot(0, 'selection'))).rejects.toThrow('within 10 seconds');
        for (let time = 1; time <= 9; time++) {
            await vi.advanceTimersByTimeAsync(1_000);
            renderer.update(snapshot(time));
            octopus.worker.frame();
        }
        await vi.advanceTimersByTimeAsync(1_000);
        await rejection;
    });
});
