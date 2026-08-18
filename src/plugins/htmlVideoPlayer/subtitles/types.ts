export const PRIMARY_SUBTITLE_SLOT = 0;
export const SECONDARY_SUBTITLE_SLOT = 1;

export type SubtitleSlot = typeof PRIMARY_SUBTITLE_SLOT | typeof SECONDARY_SUBTITLE_SLOT;

export type SubtitleClockReason =
    | 'frame'
    | 'selection'
    | 'manual'
    | 'playing'
    | 'pause'
    | 'waiting'
    | 'stalled'
    | 'waitingforkey'
    | 'seeking'
    | 'seeked'
    | 'ratechange'
    | 'loadstart'
    | 'emptied'
    | 'loadeddata'
    | 'canplay'
    | 'loadedmetadata';

export interface SubtitleClockSnapshot {
    currentTime: number;
    paused: boolean;
    playbackRate: number;
    reason: SubtitleClockReason;
}

export interface SubtitleRenderer {
    activate(snapshot: SubtitleClockSnapshot): void;
    update(snapshot: SubtitleClockSnapshot): void;
    setOffset(offsetSeconds: number): void;
    dispose(): void;
}

export interface SubtitleLoadRequest {
    isCurrent(): boolean;
    onCancel(callback: () => void): () => void;
    reportRuntimeError(error: unknown): void;
}

export type SubtitleRendererFactory = (
    request: SubtitleLoadRequest
) => Promise<SubtitleRenderer>;

export interface SubtitlePipelineStateChange {
    slot: SubtitleSlot;
    trackIndex: number;
    state: 'loading' | 'active' | 'failed' | 'disposed';
    error?: unknown;
    restoredTrackIndex?: number;
}

export interface SubtitleTrackEvent {
    StartPositionTicks: number;
    EndPositionTicks: number;
    Text?: string | null;
}
