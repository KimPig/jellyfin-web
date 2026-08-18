import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SubtitleLoadRequest } from '../types';
import {
    computeAssRenderSize,
    createAssRendererAdapter
} from './AssRendererAdapter';

interface MockOctopusOptions extends Record<string, unknown> {
    canvas?: HTMLCanvasElement;
    video?: HTMLVideoElement;
    renderAhead?: number;
    fonts?: string[];
    onReady(): void;
    onError(error: unknown): void;
}

const octopusMock = vi.hoisted(() => ({
    instances: [] as MockOctopus[]
}));

class MockOctopus {
    readonly options: MockOctopusOptions;
    readonly resizeCalls: unknown[][] = [];
    readonly currentTimeCalls: number[] = [];
    readonly pausedCalls: [boolean, number][] = [];
    readonly rateCalls: number[] = [];
    disposed = false;

    constructor(options: MockOctopusOptions) {
        this.options = options;
        octopusMock.instances.push(this);
    }

    resize(...args: unknown[]) {
        this.resizeCalls.push(args);
    }

    setCurrentTime(time: number) {
        this.currentTimeCalls.push(time);
    }

    setIsPaused(paused: boolean, time: number) {
        this.pausedCalls.push([ paused, time ]);
    }

    setRate(rate: number) {
        this.rateCalls.push(rate);
    }

    dispose() {
        this.disposed = true;
    }
}

vi.mock('@jellyfin/libass-wasm', () => ({
    default: MockOctopus
}));

function createRequest() {
    let current = true;
    let cancel: (() => void) | undefined;
    const reportRuntimeError = vi.fn();
    const request: SubtitleLoadRequest = {
        isCurrent: () => current,
        onCancel: callback => {
            cancel = callback;
            return () => {
                if (cancel === callback) cancel = undefined;
            };
        },
        reportRuntimeError
    };

    return {
        request,
        reportRuntimeError,
        cancel: () => cancel?.(),
        invalidate: () => {
            current = false;
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
        offsetHeight: { configurable: true, value: 720 }
    });
    return { parent, video };
}

function createOptions(request: SubtitleLoadRequest, videoElement: HTMLVideoElement) {
    return {
        videoElement,
        subtitleUrl: 'https://example.test/subtitle.ass',
        fonts: [ 'https://example.test/bridge.ttf' ],
        fallbackFonts: [
            'https://example.test/bridge.ttf',
            'https://example.test/embedded.ttf'
        ],
        workerUrl: '/worker.js',
        legacyWorkerUrl: '/worker-legacy.js',
        baseTimeOffsetSeconds: 2,
        targetFps: 24,
        request
    };
}

beforeEach(() => {
    octopusMock.instances = [];
});

afterEach(() => {
    vi.useRealTimers();
});

describe('computeAssRenderSize', () => {
    it('matches libass prescaling for high-DPI and 4K canvases', () => {
        expect(computeAssRenderSize(1920, 1080, 1))
            .toEqual({ width: 1920, height: 1080 });
        expect(computeAssRenderSize(1920, 1080, 2))
            .toEqual({ width: 3072, height: 1728 });
    });
});

describe('AssRendererAdapter', () => {
    it('uses manual canvas mode and follows the shared subtitle clock', async () => {
        const { parent, video } = createVideo();
        const request = createRequest();
        const rendererPromise = createAssRendererAdapter(createOptions(request.request, video));
        await vi.waitFor(() => expect(octopusMock.instances).toHaveLength(1));
        const host = parent.querySelector<HTMLElement>('.subtitle-pipeline-ass');
        expect(host?.style.position).toBe('absolute');
        expect(host?.style.inset).toBe('0px');
        expect(host?.style.width).toBe('100%');
        expect(host?.style.height).toBe('100%');
        expect(host?.style.visibility).toBe('hidden');
        octopusMock.instances[0].options.onReady();
        const renderer = await rendererPromise;
        const octopus = octopusMock.instances[0];

        expect(octopus.options.canvas).toBeInstanceOf(HTMLCanvasElement);
        expect(octopus.options.video).toBeUndefined();
        expect(octopus.options.renderAhead).toBe(0);

        renderer.activate({ currentTime: 3, paused: false, playbackRate: 1.5, reason: 'selection' });
        expect(host?.style.visibility).toBe('visible');
        expect(host?.style.position).toBe('absolute');
        expect(octopus.currentTimeCalls.at(-1)).toBe(5);
        expect(octopus.rateCalls.at(-1)).toBe(1.5);
        expect(octopus.pausedCalls.at(-1)).toEqual([ false, 5 ]);

        renderer.setOffset(1);
        renderer.update({ currentTime: 10, paused: true, playbackRate: 1, reason: 'seeked' });
        expect(octopus.currentTimeCalls.at(-1)).toBe(13);
        expect(octopus.pausedCalls.at(-1)).toEqual([ true, 13 ]);

        renderer.dispose();
        expect(octopus.disposed).toBe(true);
        expect(parent.querySelector('.subtitle-pipeline-ass')).toBeNull();
    });

    it('retries initialization with embedded fallback fonts', async () => {
        vi.useFakeTimers();
        const { video } = createVideo();
        const request = createRequest();
        const rendererPromise = createAssRendererAdapter(createOptions(request.request, video));

        await vi.waitFor(() => expect(octopusMock.instances).toHaveLength(1));
        octopusMock.instances[0].options.onError(new Error('font failure'));
        await vi.runAllTimersAsync();
        await vi.waitFor(() => expect(octopusMock.instances).toHaveLength(2));
        octopusMock.instances[1].options.onReady();
        const renderer = await rendererPromise;

        expect(octopusMock.instances).toHaveLength(2);
        expect(octopusMock.instances[0].options.fonts)
            .toEqual([ 'https://example.test/bridge.ttf' ]);
        expect(octopusMock.instances[1].options.fonts).toEqual([
            'https://example.test/bridge.ttf',
            'https://example.test/embedded.ttf'
        ]);
        renderer.dispose();
    });

    it('reports worker failures that happen after activation', async () => {
        const { video } = createVideo();
        const request = createRequest();
        const onRuntimeFallbackRequested = vi.fn();
        const rendererPromise = createAssRendererAdapter({
            ...createOptions(request.request, video),
            onRuntimeFallbackRequested
        });
        await vi.waitFor(() => expect(octopusMock.instances).toHaveLength(1));
        octopusMock.instances[0].options.onReady();
        const renderer = await rendererPromise;
        const error = new Error('worker stopped');

        octopusMock.instances[0].options.onError(error);
        expect(onRuntimeFallbackRequested).toHaveBeenCalledOnce();
        expect(request.reportRuntimeError).toHaveBeenCalledWith(error);
        renderer.dispose();
    });

    it('cancels an unfinished renderer without leaving a canvas behind', async () => {
        const { parent, video } = createVideo();
        const request = createRequest();
        const rendererPromise = createAssRendererAdapter(createOptions(request.request, video));

        await vi.waitFor(() => expect(octopusMock.instances).toHaveLength(1));
        request.cancel();

        await expect(rendererPromise).rejects.toThrow('cancelled');
        expect(octopusMock.instances[0].disposed).toBe(true);
        expect(parent.querySelector('.subtitle-pipeline-ass')).toBeNull();
    });
    it('clears stale ASS pixels immediately and resynchronizes after seeking', async () => {
        const { parent, video } = createVideo();
        const request = createRequest();
        let scheduledFrame: FrameRequestCallback | undefined;
        const requestFrame = vi.spyOn(window, 'requestAnimationFrame')
            .mockImplementation(callback => {
                scheduledFrame = callback;
                return 41;
            });
        const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame')
            .mockImplementation(() => undefined);

        const rendererPromise = createAssRendererAdapter(createOptions(request.request, video));
        await vi.waitFor(() => expect(octopusMock.instances).toHaveLength(1));
        octopusMock.instances[0].options.onReady();
        const renderer = await rendererPromise;
        renderer.activate({ currentTime: 40, paused: false, playbackRate: 1, reason: 'selection' });

        const canvas = parent.querySelector<HTMLCanvasElement>('.libassjs-canvas');
        expect(canvas).not.toBeNull();
        let canvasWidth = canvas?.width || 0;
        let clearCount = 0;
        Object.defineProperty(canvas, 'width', {
            configurable: true,
            get: () => canvasWidth,
            set: value => {
                clearCount++;
                canvasWidth = value;
            }
        });

        const octopus = octopusMock.instances[0];
        renderer.update({ currentTime: 0, paused: false, playbackRate: 1, reason: 'seeking' });

        expect(clearCount).toBe(1);
        expect(octopus.pausedCalls.at(-1)).toEqual([ true, 2 ]);
        expect(octopus.currentTimeCalls.at(-1)).toBe(2);

        renderer.update({ currentTime: 0, paused: false, playbackRate: 1, reason: 'seeked' });
        expect(requestFrame).toHaveBeenCalledOnce();
        scheduledFrame?.(performance.now());

        expect(octopus.pausedCalls.at(-1)).toEqual([ false, 2 ]);
        expect(octopus.currentTimeCalls.at(-1)).toBe(2);

        renderer.dispose();
        requestFrame.mockRestore();
        cancelFrame.mockRestore();
    });
});
