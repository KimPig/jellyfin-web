import DOMPurify from 'dompurify';

import {
    SECONDARY_SUBTITLE_SLOT,
    type SubtitleClockSnapshot,
    type SubtitleRenderer,
    type SubtitleSlot,
    type SubtitleTrackEvent
} from '../types';

interface TextEventRendererOptions {
    parentElement: HTMLElement;
    slot: SubtitleSlot;
    trackEvents: SubtitleTrackEvent[];
    baseTimeOffsetSeconds: number;
    secondaryBeforePrimary?: boolean;
    applyAppearance(container: HTMLElement, textElement: HTMLElement): void;
}

export function normalizeTrackEventText(text: string | null | undefined, useHtml: boolean) {
    const result = (text || '')
        .replace(/\\N/gi, '\n')
        .replace(/\r/gi, '')
        .replace(/{\\.*?}/gi, '')
        .split('\n')
        .map(value => `\u200E${value}`)
        .join('\n');

    return useHtml ? result.replace(/\n/gi, '<br>') : result;
}

export class TrackEventIndex {
    readonly events: SubtitleTrackEvent[];
    readonly prefixMaximumEndTicks: number[];
    lastTicks?: number;
    upperBound = 0;

    constructor(trackEvents: SubtitleTrackEvent[]) {
        this.events = [ ...trackEvents ].sort((left, right) => (
            left.StartPositionTicks - right.StartPositionTicks
        ));
        this.prefixMaximumEndTicks = new Array<number>(this.events.length);
        let maximumEndTicks = Number.NEGATIVE_INFINITY;
        for (let index = 0; index < this.events.length; index++) {
            maximumEndTicks = Math.max(maximumEndTicks, this.events[index].EndPositionTicks);
            this.prefixMaximumEndTicks[index] = maximumEndTicks;
        }
    }

    find(ticks: number) {
        if (this.lastTicks === undefined || ticks < this.lastTicks) {
            this.upperBound = this.findUpperBound(ticks);
        } else {
            while (
                this.upperBound < this.events.length
                && this.events[this.upperBound].StartPositionTicks <= ticks
            ) {
                this.upperBound++;
            }
        }
        this.lastTicks = ticks;

        const activeEvents: SubtitleTrackEvent[] = [];
        for (let index = this.upperBound - 1; index >= 0; index--) {
            if (this.prefixMaximumEndTicks[index] < ticks) break;

            const event = this.events[index];
            if (event.EndPositionTicks >= ticks && event.Text) {
                activeEvents.push(event);
            }
        }
        activeEvents.reverse();
        return activeEvents;
    }

    reset() {
        this.lastTicks = undefined;
        this.upperBound = 0;
    }

    findUpperBound(ticks: number) {
        let low = 0;
        let high = this.events.length;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (this.events[middle].StartPositionTicks <= ticks) {
                low = middle + 1;
            } else {
                high = middle;
            }
        }
        return low;
    }
}

export function findActiveTrackEvents(trackEvents: SubtitleTrackEvent[], ticks: number) {
    return new TrackEventIndex(trackEvents).find(ticks);
}

export class TextEventRenderer implements SubtitleRenderer {
    readonly parentElement: HTMLElement;
    readonly slot: SubtitleSlot;
    readonly trackEvents: SubtitleTrackEvent[];
    readonly eventIndex: TrackEventIndex;
    readonly baseTimeOffsetSeconds: number;
    readonly secondaryBeforePrimary: boolean;
    readonly applyAppearance: (container: HTMLElement, textElement: HTMLElement) => void;
    offsetSeconds = 0;
    container?: HTMLElement;
    textElement?: HTMLElement;
    lastHtml?: string;
    disposed = false;

    constructor(options: TextEventRendererOptions) {
        this.parentElement = options.parentElement;
        this.slot = options.slot;
        this.eventIndex = new TrackEventIndex(options.trackEvents);
        this.trackEvents = this.eventIndex.events;
        this.baseTimeOffsetSeconds = options.baseTimeOffsetSeconds;
        this.secondaryBeforePrimary = Boolean(options.secondaryBeforePrimary);
        this.applyAppearance = options.applyAppearance;
    }

    activate(snapshot: SubtitleClockSnapshot) {
        if (this.disposed || this.textElement) return;

        let container = this.parentElement.querySelector<HTMLElement>('.videoSubtitles');
        if (!container) {
            container = document.createElement('div');
            container.classList.add('videoSubtitles');
            this.parentElement.appendChild(container);
        }

        const textElement = document.createElement('div');
        textElement.dataset.subtitleSlot = String(this.slot);
        if (this.slot === SECONDARY_SUBTITLE_SLOT) {
            textElement.classList.add('videoSecondarySubtitlesInner');
            textElement.style.order = this.secondaryBeforePrimary ? '0' : '1';
        } else {
            textElement.classList.add('videoSubtitlesInner');
            textElement.style.order = this.secondaryBeforePrimary ? '1' : '0';
        }

        container.appendChild(textElement);
        this.container = container;
        this.textElement = textElement;
        this.applyAppearance(container, textElement);
        this.update(snapshot);
    }

    update(snapshot: SubtitleClockSnapshot) {
        if (this.disposed || !this.textElement) return;

        const ticks = (
            snapshot.currentTime
            + this.baseTimeOffsetSeconds
            + this.offsetSeconds
        ) * 10_000_000;
        const html = this.eventIndex.find(ticks)
            .map(event => normalizeTrackEventText(event.Text || '', true))
            .join('<br>');

        if (html === this.lastHtml) return;
        this.lastHtml = html;

        if (html) {
            this.textElement.innerHTML = DOMPurify.sanitize(html);
            this.textElement.classList.remove('hide');
        } else {
            this.textElement.innerHTML = '';
            this.textElement.classList.add('hide');
        }
    }

    setOffset(offsetSeconds: number) {
        this.offsetSeconds = offsetSeconds;
        this.lastHtml = undefined;
        this.eventIndex.reset();
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.textElement?.remove();

        if (this.container && this.container.childElementCount === 0) {
            this.container.remove();
        }

        this.textElement = undefined;
        this.container = undefined;
    }
}
