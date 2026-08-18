import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('lib/jellyfin-apiclient', () => ({
    ServerConnections: {
        getApiClient: vi.fn()
    }
}));
vi.mock('../../../components/router/appRouter', () => ({
    appRouter: {
        baseUrl: () => ''
    }
}));
vi.mock('../subtitleFontBridgeResolver', () => ({
    resolveSubtitleFontBridge: vi.fn()
}));

import { HtmlVideoTextSubtitlePipeline } from './HtmlVideoTextSubtitlePipeline';

function createPipeline(
    fetchSubtitleData: (signal?: AbortSignal) => Promise<never>,
    onStateChange = vi.fn()
) {
    const parent = document.createElement('div');
    const video = document.createElement('video');
    parent.appendChild(video);

    return new HtmlVideoTextSubtitlePipeline({
        videoElement: video,
        onStateChange,
        getPlaybackOptions: () => ({
            item: { Id: 'item', ServerId: 'server' },
            mediaSource: { Id: 'source', MediaStreams: [] }
        }),
        getSubtitleUrl: () => '/subtitle',
        fetchSubtitleData: (_track, _item, signal) => fetchSubtitleData(signal),
        resolveUrl: async url => url,
        applyAppearance: () => undefined,
        secondaryBeforePrimary: () => false,
        onAssError: () => undefined
    });
}

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('HtmlVideoTextSubtitlePipeline', () => {
    it('aborts an unfinished text-subtitle request when the slot is cleared', async () => {
        let requestSignal: AbortSignal | undefined;
        const fetchSubtitleData = vi.fn((signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
            requestSignal = signal;
            signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }));
        const pipeline = createPipeline(fetchSubtitleData);

        const selection = pipeline.select(0, { Index: 2, Codec: 'srt' });
        await vi.waitFor(() => expect(requestSignal).toBeDefined());
        pipeline.clear(0);
        await selection;

        expect(requestSignal?.aborted).toBe(true);
        expect(pipeline.getTrackIndex(0)).toBeUndefined();
        pipeline.dispose();
    });

    it('aborts and reports a text-subtitle request that exceeds the timeout', async () => {
        vi.useFakeTimers();
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        let requestSignal: AbortSignal | undefined;
        const onStateChange = vi.fn();
        const fetchSubtitleData = vi.fn((signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
            requestSignal = signal;
            signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }));
        const pipeline = createPipeline(fetchSubtitleData, onStateChange);

        const selection = pipeline.select(0, { Index: 3, Codec: 'srt' });
        for (let index = 0; index < 4 && !requestSignal; index++) {
            await Promise.resolve();
        }
        expect(requestSignal).toBeDefined();

        await vi.advanceTimersByTimeAsync(30_000);
        await selection;

        expect(requestSignal?.aborted).toBe(true);
        expect(onStateChange).toHaveBeenLastCalledWith(expect.objectContaining({
            trackIndex: 3,
            state: 'failed',
            restoredTrackIndex: -1,
            error: expect.objectContaining({
                message: 'Subtitle request timed out after 30 seconds.'
            })
        }));
        pipeline.dispose();
    });
});
