import type { ApiClient } from 'jellyfin-apiclient';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseSubtitleFontResolution, resolveSubtitleFontBridge } from '../plugins/htmlVideoPlayer/subtitleFontBridgeResolver';

afterEach(() => {
    vi.useRealTimers();
});

function createApiClient(getJSON = vi.fn()) {
    return {
        accessToken: vi.fn(() => 'access-token'),
        getJSON,
        getUrl: vi.fn((path: string, params?: Record<string, string>) => {
            const url = new URL(path, 'https://example.test/');
            if (params) {
                Object.entries(params).forEach(([ key, value ]) => {
                    url.searchParams.set(key, value);
                });
            }
            return url.toString();
        })
    } as unknown as ApiClient;
}

describe('Subtitle Font Bridge resolver', () => {
    it('uses authenticated font URLs and skips attachments when every family resolves', () => {
        const apiClient = createApiClient();
        const result = parseSubtitleFontResolution(apiClient, {
            Resolution: {
                RequestedFamilies: [ 'Arial', 'Malgun Gothic' ],
                MissingFamilies: [],
                Files: [
                    { Path: 'SubtitleFontBridge/Files/one.ttf' },
                    { Path: 'SubtitleFontBridge/Files/one.ttf' },
                    { Path: 'SubtitleFontBridge/Files/two.ttc' }
                ]
            }
        });

        expect(result.fullyResolved).toBe(true);
        expect(result.fontUrls).toEqual([
            'https://example.test/SubtitleFontBridge/Files/one.ttf?ApiKey=access-token',
            'https://example.test/SubtitleFontBridge/Files/two.ttc?ApiKey=access-token'
        ]);
    });

    it('keeps embedded fonts available when a family is missing', () => {
        const apiClient = createApiClient();
        const result = parseSubtitleFontResolution(apiClient, {
            Resolution: {
                RequestedFamilies: [ 'Arial', 'Missing Font' ],
                MissingFamilies: [ 'Missing Font' ],
                Files: [ { Path: 'SubtitleFontBridge/Files/one.ttf' } ]
            }
        });

        expect(result.fullyResolved).toBe(false);
        expect(result.fontUrls).toHaveLength(1);
    });

    it('does not skip embedded fonts for an empty or malformed response', () => {
        const apiClient = createApiClient();

        expect(parseSubtitleFontResolution(apiClient, {
            Resolution: {
                RequestedFamilies: [],
                MissingFamilies: [],
                Files: []
            }
        })).toEqual({ fontUrls: [], fullyResolved: false });
        expect(parseSubtitleFontResolution(apiClient, null))
            .toEqual({ fontUrls: [], fullyResolved: false });
    });

    it('falls back cleanly when the plugin endpoint is unavailable', async () => {
        const getJSON = vi.fn().mockRejectedValue(new Error('Not Found'));
        const apiClient = createApiClient(getJSON);
        vi.spyOn(console, 'debug').mockImplementation(() => undefined);

        await expect(resolveSubtitleFontBridge(apiClient, 'item', 'source', 4))
            .resolves.toEqual({ fontUrls: [], fullyResolved: false });
        expect(getJSON).toHaveBeenCalledWith(
            'https://example.test/SubtitleFontBridge/Subtitles/item/source/4'
        );
    });

    it('does not block ASS rendering when the plugin request stalls', async () => {
        vi.useFakeTimers();
        const apiClient = createApiClient(vi.fn(() => new Promise(() => undefined)));
        vi.spyOn(console, 'debug').mockImplementation(() => undefined);

        const resultPromise = resolveSubtitleFontBridge(apiClient, 'item', 'source', 4);
        await vi.advanceTimersByTimeAsync(10_000);

        await expect(resultPromise).resolves.toEqual({ fontUrls: [], fullyResolved: false });
    });
});
