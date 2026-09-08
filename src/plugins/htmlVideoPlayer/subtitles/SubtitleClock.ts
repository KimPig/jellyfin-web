import type {
    SubtitleClockReason,
    SubtitleClockSnapshot
} from './types';

type SubtitleClockListener = (snapshot: SubtitleClockSnapshot) => void;

const VIDEO_EVENTS = [
    'loadstart',
    'emptied',
    'loadedmetadata',
    'loadeddata',
    'canplay',
    'playing',
    'pause',
    'waiting',
    'stalled',
    'waitingforkey',
    'seeking',
    'seeked',
    'ratechange'
] as const;

const FRAME_LOOP_RESET_EVENTS = new Set<SubtitleClockReason>([
    'loadstart',
    'emptied',
    'loadedmetadata',
    'playing',
    'waiting',
    'stalled',
    'waitingforkey',
    'seeking',
    'seeked'
]);

export class SubtitleClock {
    readonly videoElement: HTMLVideoElement;
    readonly listeners = new Set<SubtitleClockListener>();
    disposed = false;
    buffering = false;
    videoFrameHandle?: number;
    animationFrameHandle?: number;

    constructor(videoElement: HTMLVideoElement) {
        this.videoElement = videoElement;

        for (const eventName of VIDEO_EVENTS) {
            videoElement.addEventListener(eventName, this.onVideoEvent);
        }

        videoElement.addEventListener('timeupdate', this.onTimeUpdate);
        this.scheduleFrame();
    }

    subscribe(listener: SubtitleClockListener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    snapshot(reason: SubtitleClockReason = 'manual'): SubtitleClockSnapshot {
        return {
            currentTime: Number.isFinite(this.videoElement.currentTime) ? this.videoElement.currentTime : 0,
            paused: this.videoElement.paused || this.videoElement.seeking || this.buffering,
            playbackRate: this.videoElement.playbackRate || 1,
            reason
        };
    }

    pulse(reason: SubtitleClockReason = 'manual') {
        if (this.disposed) return;

        const snapshot = this.snapshot(reason);
        for (const listener of this.listeners) {
            listener(snapshot);
        }
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;

        for (const eventName of VIDEO_EVENTS) {
            this.videoElement.removeEventListener(eventName, this.onVideoEvent);
        }
        this.videoElement.removeEventListener('timeupdate', this.onTimeUpdate);
        this.cancelScheduledFrame();
        this.listeners.clear();
    }

    onVideoEvent = (event: Event) => {
        const reason = event.type as SubtitleClockReason;
        if (
            reason === 'loadstart'
            || reason === 'emptied'
            || reason === 'waiting'
            || reason === 'waitingforkey'
            || reason === 'seeking'
            || (reason === 'stalled' && this.videoElement.readyState < HTMLMediaElement.HAVE_FUTURE_DATA)
        ) {
            this.buffering = true;
        } else if (reason === 'playing') {
            this.buffering = false;
        }

        if (FRAME_LOOP_RESET_EVENTS.has(reason)) {
            this.cancelScheduledFrame();
        }

        this.pulse(reason);
        this.scheduleFrame();
    };

    onTimeUpdate = () => {
        // timeupdate is a fallback heartbeat for browsers and WebViews that
        // do not reliably deliver video-frame callbacks.
        this.pulse('frame');
        this.scheduleFrame();
    };

    onVideoFrame: VideoFrameRequestCallback = () => {
        this.videoFrameHandle = undefined;
        this.pulse('frame');
        this.scheduleFrame();
    };

    onAnimationFrame = () => {
        this.animationFrameHandle = undefined;
        if (!this.videoElement.paused && !this.videoElement.ended && !this.buffering) {
            this.pulse('frame');
        }
        this.scheduleFrame();
    };

    cancelScheduledFrame() {
        if (this.videoFrameHandle !== undefined) {
            this.videoElement.cancelVideoFrameCallback?.(this.videoFrameHandle);
            this.videoFrameHandle = undefined;
        }
        if (this.animationFrameHandle !== undefined) {
            cancelAnimationFrame(this.animationFrameHandle);
            this.animationFrameHandle = undefined;
        }
    }

    scheduleFrame() {
        if (this.disposed) return;

        if (this.videoElement.requestVideoFrameCallback) {
            if (this.videoFrameHandle === undefined) {
                this.videoFrameHandle = this.videoElement.requestVideoFrameCallback(this.onVideoFrame);
            }
            return;
        }

        if (this.videoElement.paused || this.videoElement.ended || this.buffering) return;

        if (this.animationFrameHandle === undefined) {
            this.animationFrameHandle = requestAnimationFrame(this.onAnimationFrame);
        }
    }
}
