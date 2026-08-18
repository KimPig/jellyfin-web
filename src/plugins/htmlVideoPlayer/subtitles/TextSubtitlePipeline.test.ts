import { describe, expect, it, vi } from 'vitest';

import { TextSubtitlePipeline } from './TextSubtitlePipeline';
import type { SubtitleLoadRequest, SubtitleRenderer } from './types';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function createRenderer() {
    return {
        activate: vi.fn(),
        update: vi.fn(),
        setOffset: vi.fn(),
        dispose: vi.fn()
    } satisfies SubtitleRenderer;
}

function createPipeline() {
    return new TextSubtitlePipeline(document.createElement('video'));
}

describe('TextSubtitlePipeline', () => {
    it('keeps the active subtitle visible until its replacement is ready', async () => {
        const pipeline = createPipeline();
        const first = createRenderer();
        const second = createRenderer();
        const pending = deferred<SubtitleRenderer>();

        await pipeline.select(0, 1, async () => first);
        const replacement = pipeline.select(0, 2, () => pending.promise);

        expect(first.dispose).not.toHaveBeenCalled();
        expect(pipeline.getActiveTrackIndex(0)).toBe(1);

        pending.resolve(second);
        await replacement;

        expect(second.activate).toHaveBeenCalledOnce();
        expect(first.dispose).toHaveBeenCalledOnce();
        expect(pipeline.getActiveTrackIndex(0)).toBe(2);
        pipeline.dispose();
    });

    it('disposes a stale renderer that finishes after a newer selection', async () => {
        const pipeline = createPipeline();
        const stale = createRenderer();
        const current = createRenderer();
        const staleLoad = deferred<SubtitleRenderer>();
        const currentLoad = deferred<SubtitleRenderer>();

        const staleFactory = vi.fn(() => staleLoad.promise);
        const staleSelection = pipeline.select(0, 1, staleFactory);
        await vi.waitFor(() => expect(staleFactory).toHaveBeenCalledOnce());
        const currentSelection = pipeline.select(0, 2, () => currentLoad.promise);
        staleLoad.resolve(stale);
        await staleSelection;

        expect(stale.activate).not.toHaveBeenCalled();
        expect(stale.dispose).toHaveBeenCalledOnce();

        currentLoad.resolve(current);
        await currentSelection;
        expect(current.activate).toHaveBeenCalledOnce();
        expect(pipeline.getActiveTrackIndex(0)).toBe(2);
        pipeline.dispose();
    });
    it('does not start a renderer factory superseded in the same turn', async () => {
        const pipeline = createPipeline();
        const cancelledFactory = vi.fn(async () => createRenderer());
        const current = createRenderer();

        const cancelledSelection = pipeline.select(0, 1, cancelledFactory);
        const currentSelection = pipeline.select(0, 2, async () => current);
        await Promise.all([ cancelledSelection, currentSelection ]);

        expect(cancelledFactory).not.toHaveBeenCalled();
        expect(current.activate).toHaveBeenCalledOnce();
        expect(pipeline.getActiveTrackIndex(0)).toBe(2);
        pipeline.dispose();
    });

    it('cancels a pending replacement when switching back to the active track', async () => {
        const pipeline = createPipeline();
        const active = createRenderer();
        const stale = createRenderer();
        const staleLoad = deferred<SubtitleRenderer>();
        const activeFactory = vi.fn(async () => createRenderer());

        await pipeline.select(0, 1, async () => active);
        const staleFactory = vi.fn(() => staleLoad.promise);
        const staleSelection = pipeline.select(0, 2, staleFactory);
        await vi.waitFor(() => expect(staleFactory).toHaveBeenCalledOnce());
        await pipeline.select(0, 1, activeFactory);

        expect(activeFactory).not.toHaveBeenCalled();
        expect(active.dispose).not.toHaveBeenCalled();
        expect(pipeline.getTrackIndex(0)).toBe(1);

        staleLoad.resolve(stale);
        await staleSelection;
        expect(stale.dispose).toHaveBeenCalledOnce();
        pipeline.dispose();
    });

    it('keeps the previous renderer after a failed replacement and allows retry', async () => {
        const onStateChange = vi.fn();
        const pipeline = new TextSubtitlePipeline(document.createElement('video'), { onStateChange });
        const first = createRenderer();
        const retry = createRenderer();

        await pipeline.select(0, 1, async () => first);
        await pipeline.select(0, 2, async () => {
            throw new Error('network failure');
        });

        expect(first.dispose).not.toHaveBeenCalled();
        expect(pipeline.getActiveTrackIndex(0)).toBe(1);
        expect(pipeline.getTrackIndex(0)).toBe(1);
        expect(onStateChange).toHaveBeenLastCalledWith(expect.objectContaining({
            trackIndex: 2,
            state: 'failed',
            restoredTrackIndex: 1
        }));

        await pipeline.select(0, 2, async () => retry);
        expect(retry.activate).toHaveBeenCalledOnce();
        expect(first.dispose).toHaveBeenCalledOnce();
        pipeline.dispose();
    });

    it('applies an offset set while a renderer is loading', async () => {
        const pipeline = createPipeline();
        const renderer = createRenderer();
        const pending = deferred<SubtitleRenderer>();
        const selection = pipeline.select(0, 4, () => pending.promise);

        pipeline.setOffset(0, 1.25);
        pending.resolve(renderer);
        await selection;

        expect(renderer.setOffset).toHaveBeenCalledWith(1.25);
        pipeline.dispose();
    });

    it('updates active renderers immediately after a seek event', async () => {
        const video = document.createElement('video');
        const pipeline = new TextSubtitlePipeline(video);
        const renderer = createRenderer();

        await pipeline.select(0, 3, async () => renderer);
        renderer.update.mockClear();
        Object.defineProperty(video, 'currentTime', {
            configurable: true,
            value: 42
        });
        video.dispatchEvent(new Event('seeked'));

        expect(renderer.update).toHaveBeenCalledWith(expect.objectContaining({
            currentTime: 42,
            reason: 'seeked'
        }));
        pipeline.dispose();
    });
    it('pauses renderer time while the video is buffering', async () => {
        const video = document.createElement('video');
        const pipeline = new TextSubtitlePipeline(video);
        const renderer = createRenderer();

        await pipeline.select(0, 5, async () => renderer);
        renderer.update.mockClear();
        video.dispatchEvent(new Event('waiting'));

        expect(renderer.update).toHaveBeenCalledWith(expect.objectContaining({
            paused: true,
            reason: 'waiting'
        }));
        pipeline.dispose();
    });

    it('keeps primary and secondary subtitle slots independent', async () => {
        const pipeline = createPipeline();
        const primary = createRenderer();
        const secondary = createRenderer();

        await pipeline.select(0, 1, async () => primary);
        await pipeline.select(1, 2, async () => secondary);
        pipeline.clear(0);

        expect(primary.dispose).toHaveBeenCalledOnce();
        expect(secondary.dispose).not.toHaveBeenCalled();
        expect(pipeline.getActiveTrackIndex(1)).toBe(2);

        pipeline.dispose();
        expect(secondary.dispose).toHaveBeenCalledOnce();
    });
    it('rejects a renderer that reports failure while it is being activated', async () => {
        const pipeline = createPipeline();
        const renderer = createRenderer();

        await pipeline.select(0, 6, async request => {
            request.reportRuntimeError(new Error('failed before activation'));
            return renderer;
        });

        expect(renderer.dispose).toHaveBeenCalledOnce();
        expect(renderer.activate).not.toHaveBeenCalled();
        expect(pipeline.getActiveTrackIndex(0)).toBeUndefined();
        pipeline.dispose();
    });

    it('recreates an active renderer only once after a runtime failure', async () => {
        const pipeline = createPipeline();
        const first = createRenderer();
        const retry = createRenderer();
        let request!: SubtitleLoadRequest;
        const factory = vi.fn(async (nextRequest: SubtitleLoadRequest) => {
            request = nextRequest;
            return factory.mock.calls.length === 1 ? first : retry;
        });

        await pipeline.select(0, 7, factory);
        request.reportRuntimeError(new Error('worker stopped'));
        await vi.waitFor(() => expect(retry.activate).toHaveBeenCalledOnce());

        expect(factory).toHaveBeenCalledTimes(2);
        expect(first.dispose).toHaveBeenCalledOnce();
        expect(pipeline.getActiveTrackIndex(0)).toBe(7);
        pipeline.dispose();
    });

    it('clears a track after the single runtime recovery attempt also fails', async () => {
        const onStateChange = vi.fn();
        const pipeline = new TextSubtitlePipeline(document.createElement('video'), { onStateChange });
        const first = createRenderer();
        const retry = createRenderer();
        let request!: SubtitleLoadRequest;
        const factory = vi.fn(async (nextRequest: SubtitleLoadRequest) => {
            request = nextRequest;
            return factory.mock.calls.length === 1 ? first : retry;
        });

        await pipeline.select(0, 8, factory);
        request.reportRuntimeError(new Error('first worker stopped'));
        await vi.waitFor(() => expect(retry.activate).toHaveBeenCalledOnce());
        request.reportRuntimeError(new Error('replacement worker stopped'));

        expect(factory).toHaveBeenCalledTimes(2);
        expect(pipeline.getTrackIndex(0)).toBeUndefined();
        expect(pipeline.getActiveTrackIndex(0)).toBeUndefined();
        expect(onStateChange).toHaveBeenLastCalledWith(expect.objectContaining({
            state: 'failed',
            restoredTrackIndex: -1
        }));
        pipeline.dispose();
    });

    it('lets a pending replacement finish if the previous renderer fails', async () => {
        const onStateChange = vi.fn();
        const pipeline = new TextSubtitlePipeline(document.createElement('video'), { onStateChange });
        const previous = createRenderer();
        const replacement = createRenderer();
        const replacementLoad = deferred<SubtitleRenderer>();
        let previousRequest!: SubtitleLoadRequest;

        await pipeline.select(0, 9, async request => {
            previousRequest = request;
            return previous;
        });
        const selection = pipeline.select(0, 10, () => replacementLoad.promise);
        previousRequest.reportRuntimeError(new Error('old worker stopped'));

        expect(previous.dispose).toHaveBeenCalledOnce();
        expect(pipeline.getTrackIndex(0)).toBe(10);
        replacementLoad.resolve(replacement);
        await selection;

        expect(replacement.activate).toHaveBeenCalledOnce();
        expect(pipeline.getActiveTrackIndex(0)).toBe(10);
        expect(onStateChange).not.toHaveBeenCalledWith(expect.objectContaining({
            trackIndex: 9,
            state: 'failed'
        }));
        pipeline.dispose();
    });

    it('survives repeated track changes without retaining old renderers', async () => {
        const pipeline = createPipeline();
        const renderers: ReturnType<typeof createRenderer>[] = [];

        for (let index = 0; index < 50; index++) {
            const renderer = createRenderer();
            renderers.push(renderer);
            await pipeline.select(0, index, async () => renderer);
        }

        expect(pipeline.getActiveTrackIndex(0)).toBe(49);
        for (const renderer of renderers.slice(0, -1)) {
            expect(renderer.dispose).toHaveBeenCalledOnce();
        }
        expect(renderers.at(-1)?.dispose).not.toHaveBeenCalled();

        pipeline.dispose();
        expect(renderers.at(-1)?.dispose).toHaveBeenCalledOnce();
    });
    it('detaches an old playback generation before reusing the video element', async () => {
        const video = document.createElement('video');
        const oldPipeline = new TextSubtitlePipeline(video);
        const oldRenderer = createRenderer();
        await oldPipeline.select(0, 8, async () => oldRenderer);
        oldPipeline.dispose();
        oldRenderer.update.mockClear();

        const currentPipeline = new TextSubtitlePipeline(video);
        const currentRenderer = createRenderer();
        await currentPipeline.select(0, 9, async () => currentRenderer);
        currentRenderer.update.mockClear();

        Object.defineProperty(video, 'currentTime', {
            configurable: true,
            value: 0
        });
        video.dispatchEvent(new Event('seeking'));
        video.dispatchEvent(new Event('seeked'));

        expect(oldRenderer.update).not.toHaveBeenCalled();
        expect(currentRenderer.update).toHaveBeenCalledWith(expect.objectContaining({
            currentTime: 0,
            reason: 'seeking'
        }));
        expect(currentRenderer.update).toHaveBeenCalledWith(expect.objectContaining({
            currentTime: 0,
            reason: 'seeked'
        }));
        currentPipeline.dispose();
    });
});
