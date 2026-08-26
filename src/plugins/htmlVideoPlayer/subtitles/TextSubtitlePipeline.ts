import { SubtitleClock } from './SubtitleClock';
import type {
    SubtitleClockSnapshot,
    SubtitleLoadRequest,
    SubtitlePipelineStateChange,
    SubtitleRenderer,
    SubtitleRendererFactory,
    SubtitleSlot
} from './types';

interface ActiveRendererState {
    generation: symbol;
    trackIndex: number;
    factory: SubtitleRendererFactory;
    renderer: SubtitleRenderer;
}

interface LoadingRendererState {
    generation: symbol;
    trackIndex: number;
    cancel(): void;
    promise: Promise<void>;
}

interface SubtitleSlotState {
    desiredTrackIndex?: number;
    offsetSeconds: number;
    runtimeRetries: number;
    factory?: SubtitleRendererFactory;
    active?: ActiveRendererState;
    loading?: LoadingRendererState;
}

interface TextSubtitlePipelineOptions {
    onStateChange?: (change: SubtitlePipelineStateChange) => void;
}

const MAX_RUNTIME_RETRIES = 1;

export class TextSubtitlePipeline {
    readonly videoElement: HTMLVideoElement;
    readonly clock: SubtitleClock;
    readonly slots = new Map<SubtitleSlot, SubtitleSlotState>();
    readonly onStateChange?: (change: SubtitlePipelineStateChange) => void;
    readonly unsubscribeClock: () => void;
    disposed = false;

    constructor(videoElement: HTMLVideoElement, options: TextSubtitlePipelineOptions = {}) {
        this.videoElement = videoElement;
        this.clock = new SubtitleClock(videoElement);
        this.onStateChange = options.onStateChange;
        this.unsubscribeClock = this.clock.subscribe(this.onClock);
    }

    getTrackIndex(slot: SubtitleSlot) {
        return this.slots.get(slot)?.desiredTrackIndex;
    }

    getActiveTrackIndex(slot: SubtitleSlot) {
        return this.slots.get(slot)?.active?.trackIndex;
    }

    async select(slot: SubtitleSlot, trackIndex: number, factory: SubtitleRendererFactory) {
        if (this.disposed) return;

        const state = this.getOrCreateSlot(slot);
        const active = state.active;
        const sameTrackIsActive = active?.trackIndex === trackIndex;
        const sameTrackIsLoading = state.loading?.trackIndex === trackIndex;
        if (state.desiredTrackIndex === trackIndex && sameTrackIsLoading) {
            return state.loading?.promise;
        }
        if (sameTrackIsActive) {
            state.desiredTrackIndex = trackIndex;
            state.factory = factory;
            active.factory = factory;
            state.runtimeRetries = 0;
            state.loading?.cancel();
            state.loading = undefined;
            try {
                active.renderer.update(this.clock.snapshot('selection'));
            } catch (error) {
                this.handleRuntimeError(slot, active.generation, error);
            }
            return;
        }

        state.desiredTrackIndex = trackIndex;
        state.factory = factory;
        state.runtimeRetries = 0;
        return this.prepare(slot, state, trackIndex, factory);
    }

    setOffset(slot: SubtitleSlot, offsetSeconds: number) {
        const state = this.getOrCreateSlot(slot);
        state.offsetSeconds = offsetSeconds;

        if (!state.active) return;
        try {
            state.active.renderer.setOffset(offsetSeconds);
            state.active.renderer.update(this.clock.snapshot('manual'));
        } catch (error) {
            this.handleRuntimeError(slot, state.active.generation, error);
        }
    }

    sync() {
        this.clock.pulse('manual');
    }

    clear(slot?: SubtitleSlot) {
        const targetSlots = slot === undefined ? [ ...this.slots.keys() ] : [ slot ];
        for (const targetSlot of targetSlots) {
            const state = this.slots.get(targetSlot);
            if (!state) continue;

            state.desiredTrackIndex = undefined;
            state.factory = undefined;
            state.runtimeRetries = 0;
            state.loading?.cancel();
            state.loading = undefined;

            const active = state.active;
            state.active = undefined;
            this.safeDispose(active?.renderer);
            if (active) {
                this.onStateChange?.({
                    slot: targetSlot,
                    trackIndex: active.trackIndex,
                    state: 'disposed'
                });
            }

            this.slots.delete(targetSlot);
        }
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.clear();
        this.unsubscribeClock();
        this.clock.dispose();
    }

    getOrCreateSlot(slot: SubtitleSlot) {
        let state = this.slots.get(slot);
        if (!state) {
            state = {
                offsetSeconds: 0,
                runtimeRetries: 0
            };
            this.slots.set(slot, state);
        }
        return state;
    }

    prepare(
        slot: SubtitleSlot,
        state: SubtitleSlotState,
        trackIndex: number,
        factory: SubtitleRendererFactory
    ) {
        state.loading?.cancel();

        const generation = Symbol(String(trackIndex));
        const cancellationCallbacks = new Set<() => void>();
        let cancelled = false;
        let preparationError: unknown;
        const cancel = () => {
            if (cancelled) return;
            cancelled = true;
            for (const callback of cancellationCallbacks) {
                try {
                    callback();
                } catch (error) {
                    console.debug('Unable to cancel subtitle loading', error);
                }
            }
            cancellationCallbacks.clear();
        };
        const isCurrent = () => !this.disposed
            && !cancelled
            && this.slots.get(slot) === state
            && state.desiredTrackIndex === trackIndex
            && state.loading?.generation === generation;
        const request: SubtitleLoadRequest = {
            isCurrent,
            onCancel: (callback) => {
                if (cancelled) {
                    callback();
                    return () => undefined;
                }
                cancellationCallbacks.add(callback);
                return () => cancellationCallbacks.delete(callback);
            },
            reportRuntimeError: (error) => {
                if (state.active?.generation === generation) {
                    this.handleRuntimeError(slot, generation, error);
                } else if (state.loading?.generation === generation) {
                    preparationError = error;
                }
            }
        };

        const promise = Promise.resolve().then(async () => {
            let renderer: SubtitleRenderer | undefined;
            try {
                if (!isCurrent()) return;
                renderer = await factory(request);
                if (preparationError) throw preparationError;
                if (!isCurrent()) {
                    this.safeDispose(renderer);
                    return;
                }

                renderer.setOffset(state.offsetSeconds);
                const snapshot = this.clock.snapshot('selection');
                renderer.activate(snapshot);
                renderer.update(snapshot);
                if (preparationError) throw preparationError;

                if (!isCurrent()) {
                    this.safeDispose(renderer);
                    return;
                }

                const previous = state.active;
                state.active = {
                    generation,
                    trackIndex,
                    factory,
                    renderer
                };
                state.loading = undefined;
                this.safeDispose(previous?.renderer);
                this.onStateChange?.({ slot, trackIndex, state: 'active' });
            } catch (error) {
                this.safeDispose(renderer);
                if (!isCurrent()) return;

                state.loading = undefined;
                this.restoreAfterSelectionFailure(slot, state, trackIndex, error);
            } finally {
                cancellationCallbacks.clear();
            }
        });

        state.loading = {
            generation,
            trackIndex,
            cancel,
            promise
        };
        this.onStateChange?.({ slot, trackIndex, state: 'loading' });
        return promise;
    }

    handleRuntimeError(slot: SubtitleSlot, generation: symbol, error: unknown) {
        const state = this.slots.get(slot);
        const active = state?.active;
        if (!state || !active || active.generation !== generation) return;

        state.active = undefined;
        this.safeDispose(active.renderer);

        // A replacement may already be loading while the previous renderer
        // fails. Keep that newer selection authoritative instead of clearing
        // or restarting it with the old track's factory.
        if (
            state.loading
            && state.desiredTrackIndex !== active.trackIndex
        ) {
            return;
        }

        if (
            state.desiredTrackIndex === active.trackIndex
            && state.factory
            && state.runtimeRetries < MAX_RUNTIME_RETRIES
        ) {
            state.runtimeRetries++;
            void this.prepare(slot, state, active.trackIndex, state.factory);
            return;
        }

        state.desiredTrackIndex = undefined;
        state.factory = undefined;
        this.onStateChange?.({
            slot,
            trackIndex: active.trackIndex,
            state: 'failed',
            error,
            restoredTrackIndex: -1
        });
    }

    restoreAfterSelectionFailure(
        slot: SubtitleSlot,
        state: SubtitleSlotState,
        trackIndex: number,
        error: unknown
    ) {
        const previous = state.active;
        const restoredTrackIndex = previous?.trackIndex ?? -1;
        state.desiredTrackIndex = previous?.trackIndex;
        state.factory = previous?.factory;
        state.runtimeRetries = 0;
        this.onStateChange?.({
            slot,
            trackIndex,
            state: 'failed',
            error,
            restoredTrackIndex
        });
    }

    safeDispose(renderer?: SubtitleRenderer) {
        if (!renderer) return;
        try {
            renderer.dispose();
        } catch (error) {
            console.debug('Unable to dispose subtitle renderer', error);
        }
    }

    onClock = (snapshot: SubtitleClockSnapshot) => {
        for (const [ slot, state ] of this.slots) {
            const active = state.active;
            if (!active) continue;

            try {
                active.renderer.update(snapshot);
            } catch (error) {
                this.handleRuntimeError(slot, active.generation, error);
            }
        }
    };
}
