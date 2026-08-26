import { describe, expect, it, vi } from 'vitest';

import {
    TextEventRenderer,
    TrackEventIndex,
    findActiveTrackEvents,
    normalizeTrackEventText
} from './TextEventRenderer';

const snapshot = (currentTime: number) => ({
    currentTime,
    paused: false,
    playbackRate: 1,
    reason: 'frame' as const
});

describe('TextEventRenderer', () => {
    it('normalizes line breaks, strips ASS overrides, and tolerates empty text', () => {
        expect(normalizeTrackEventText('{\\i1}One\\NTwo\r', false))
            .toBe('\u200EOne\n\u200ETwo');
        expect(normalizeTrackEventText(undefined, true)).toBe('\u200E');
    });

    it('returns every overlapping event at the requested time', () => {
        const events = [
            { StartPositionTicks: 0, EndPositionTicks: 20, Text: 'one' },
            { StartPositionTicks: 10, EndPositionTicks: 30, Text: 'two' },
            { StartPositionTicks: 31, EndPositionTicks: 40, Text: 'three' }
        ];

        expect(findActiveTrackEvents(events, 15).map(event => event.Text))
            .toEqual([ 'one', 'two' ]);
    });

    it('uses an index for large tracks and remains correct after a backward seek', () => {
        let endReads = 0;
        const events = Array.from({ length: 20_000 }, (_, index) => ({
            StartPositionTicks: index * 100,
            get EndPositionTicks() {
                endReads++;
                return index * 100 + 50;
            },
            Text: String(index)
        }));
        const index = new TrackEventIndex(events);

        endReads = 0;
        expect(index.find(1_999_925).map(event => event.Text)).toEqual([ '19999' ]);
        expect(endReads).toBeLessThan(10);

        endReads = 0;
        expect(index.find(1_025).map(event => event.Text)).toEqual([ '10' ]);
        expect(endReads).toBeLessThan(10);
    });

    it('preserves overlapping cue order when a long cue spans many short cues', () => {
        const index = new TrackEventIndex([
            { StartPositionTicks: 0, EndPositionTicks: 1_000, Text: 'long' },
            { StartPositionTicks: 100, EndPositionTicks: 150, Text: 'short-1' },
            { StartPositionTicks: 200, EndPositionTicks: 250, Text: 'short-2' }
        ]);

        expect(index.find(125).map(event => event.Text)).toEqual([ 'long', 'short-1' ]);
        expect(index.find(225).map(event => event.Text)).toEqual([ 'long', 'short-2' ]);
        expect(index.find(50).map(event => event.Text)).toEqual([ 'long' ]);
    });

    it('updates immediately on seek and removes only its own slot on dispose', () => {
        const parent = document.createElement('div');
        const applyAppearance = vi.fn();
        const first = new TextEventRenderer({
            parentElement: parent,
            slot: 0,
            trackEvents: [
                { StartPositionTicks: 10_000_000, EndPositionTicks: 20_000_000, Text: 'First' },
                { StartPositionTicks: 50_000_000, EndPositionTicks: 60_000_000, Text: 'Later' }
            ],
            baseTimeOffsetSeconds: 0,
            applyAppearance
        });
        const second = new TextEventRenderer({
            parentElement: parent,
            slot: 1,
            trackEvents: [
                { StartPositionTicks: 10_000_000, EndPositionTicks: 20_000_000, Text: 'Secondary' }
            ],
            baseTimeOffsetSeconds: 0,
            secondaryBeforePrimary: true,
            applyAppearance
        });

        first.activate(snapshot(1.5));
        second.activate(snapshot(1.5));
        expect(parent.textContent).toContain('First');
        expect(parent.textContent).toContain('Secondary');

        first.update({ ...snapshot(5.5), reason: 'seeked' });
        expect(first.textElement?.textContent).toContain('Later');

        first.dispose();
        expect(parent.querySelector('[data-subtitle-slot="0"]')).toBeNull();
        expect(parent.querySelector('[data-subtitle-slot="1"]')).not.toBeNull();

        second.dispose();
        expect(parent.querySelector('.videoSubtitles')).toBeNull();
    });

    it('applies subtitle offset without mutating track event timestamps', () => {
        const parent = document.createElement('div');
        const event = { StartPositionTicks: 20_000_000, EndPositionTicks: 30_000_000, Text: 'Offset' };
        const renderer = new TextEventRenderer({
            parentElement: parent,
            slot: 0,
            trackEvents: [ event ],
            baseTimeOffsetSeconds: 0,
            applyAppearance: () => undefined
        });

        renderer.activate(snapshot(1));
        expect(renderer.textElement?.classList.contains('hide')).toBe(true);
        renderer.setOffset(1);
        renderer.update({ ...snapshot(1), reason: 'manual' });

        expect(renderer.textElement?.textContent).toContain('Offset');
        expect(event.StartPositionTicks).toBe(20_000_000);
        renderer.dispose();
    });
});
