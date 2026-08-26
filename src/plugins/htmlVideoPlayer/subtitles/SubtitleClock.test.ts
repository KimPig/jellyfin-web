import { describe, expect, it, vi } from 'vitest';

import { SubtitleClock } from './SubtitleClock';

function createVideoFrameHarness() {
    const video = document.createElement('video');
    const callbacks = new Map<number, VideoFrameRequestCallback>();
    let nextHandle = 0;
    const requestVideoFrameCallback = vi.fn((callback: VideoFrameRequestCallback) => {
        const handle = ++nextHandle;
        callbacks.set(handle, callback);
        return handle;
    });
    const cancelVideoFrameCallback = vi.fn((handle: number) => {
        callbacks.delete(handle);
    });

    Object.defineProperties(video, {
        paused: { configurable: true, value: false },
        ended: { configurable: true, value: false },
        requestVideoFrameCallback: {
            configurable: true,
            value: requestVideoFrameCallback
        },
        cancelVideoFrameCallback: {
            configurable: true,
            value: cancelVideoFrameCallback
        }
    });

    return {
        video,
        callbacks,
        requestVideoFrameCallback,
        cancelVideoFrameCallback
    };
}

describe('SubtitleClock', () => {
    it('cancels and rearms video-frame callbacks across repeated media sources', () => {
        const harness = createVideoFrameHarness();
        const clock = new SubtitleClock(harness.video);

        expect(harness.requestVideoFrameCallback).toHaveBeenCalledTimes(1);
        for (let source = 0; source < 20; source++) {
            harness.video.dispatchEvent(new Event('loadstart'));
            harness.video.dispatchEvent(new Event('loadedmetadata'));
            harness.video.dispatchEvent(new Event('playing'));
            expect(harness.callbacks.size).toBe(1);
        }

        expect(harness.cancelVideoFrameCallback).toHaveBeenCalledTimes(60);
        expect(harness.requestVideoFrameCallback).toHaveBeenCalledTimes(61);

        clock.dispose();
        expect(harness.callbacks.size).toBe(0);
        expect(harness.cancelVideoFrameCallback).toHaveBeenCalledTimes(61);
    });

    it('keeps the clock paused after seeking until playback actually resumes', () => {
        const harness = createVideoFrameHarness();
        const clock = new SubtitleClock(harness.video);
        const listener = vi.fn();
        clock.subscribe(listener);

        Object.defineProperty(harness.video, 'currentTime', {
            configurable: true,
            value: 0
        });
        harness.video.dispatchEvent(new Event('seeking'));
        harness.video.dispatchEvent(new Event('seeked'));

        expect(listener).toHaveBeenNthCalledWith(1, expect.objectContaining({
            currentTime: 0,
            paused: true,
            reason: 'seeking'
        }));
        expect(listener).toHaveBeenNthCalledWith(2, expect.objectContaining({
            currentTime: 0,
            paused: true,
            reason: 'seeked'
        }));

        harness.video.dispatchEvent(new Event('playing'));
        expect(listener).toHaveBeenNthCalledWith(3, expect.objectContaining({
            currentTime: 0,
            paused: false,
            reason: 'playing'
        }));

        clock.dispose();
    });

    it('does not resume subtitle time from canplay while media is still buffering', () => {
        const harness = createVideoFrameHarness();
        const clock = new SubtitleClock(harness.video);
        const listener = vi.fn();
        clock.subscribe(listener);

        harness.video.dispatchEvent(new Event('waiting'));
        harness.video.dispatchEvent(new Event('canplay'));
        harness.video.dispatchEvent(new Event('playing'));

        expect(listener).toHaveBeenNthCalledWith(1, expect.objectContaining({
            paused: true,
            reason: 'waiting'
        }));
        expect(listener).toHaveBeenNthCalledWith(2, expect.objectContaining({
            paused: true,
            reason: 'canplay'
        }));
        expect(listener).toHaveBeenNthCalledWith(3, expect.objectContaining({
            paused: false,
            reason: 'playing'
        }));

        clock.dispose();
    });

    it('pauses for encrypted-media waits and low-buffer stalls', () => {
        const harness = createVideoFrameHarness();
        const clock = new SubtitleClock(harness.video);
        const listener = vi.fn();
        clock.subscribe(listener);

        Object.defineProperty(harness.video, 'readyState', {
            configurable: true,
            value: HTMLMediaElement.HAVE_CURRENT_DATA
        });
        harness.video.dispatchEvent(new Event('stalled'));
        harness.video.dispatchEvent(new Event('playing'));
        harness.video.dispatchEvent(new Event('waitingforkey'));

        expect(listener).toHaveBeenNthCalledWith(1, expect.objectContaining({
            paused: true,
            reason: 'stalled'
        }));
        expect(listener).toHaveBeenNthCalledWith(3, expect.objectContaining({
            paused: true,
            reason: 'waitingforkey'
        }));

        clock.dispose();
    });
});
