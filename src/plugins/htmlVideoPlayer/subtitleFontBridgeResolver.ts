import type { ApiClient } from 'jellyfin-apiclient';

interface SubtitleFontBridgeFile {
    Path?: string;
}

interface SubtitleFontBridgeResolution {
    RequestedFamilies?: string[];
    MissingFamilies?: string[];
    Files?: SubtitleFontBridgeFile[];
}

interface SubtitleFontResolution {
    Resolution?: SubtitleFontBridgeResolution;
}

export interface ResolvedSubtitleFonts {
    fontUrls: string[];
    fullyResolved: boolean;
}

const EMPTY_RESOLUTION: ResolvedSubtitleFonts = {
    fontUrls: [],
    fullyResolved: false
};
const RESOLUTION_TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Subtitle Font Bridge request timed out.')), timeoutMs);
        promise.then(result => {
            clearTimeout(timeout);
            resolve(result);
        }, error => {
            clearTimeout(timeout);
            reject(error);
        });
    });
}

export function parseSubtitleFontResolution(
    apiClient: ApiClient,
    result?: SubtitleFontResolution | null
): ResolvedSubtitleFonts {
    const resolution = result?.Resolution;
    const requestedFamilies = resolution?.RequestedFamilies;
    const missingFamilies = resolution?.MissingFamilies;
    const files = resolution?.Files;

    if (!Array.isArray(requestedFamilies)
        || !Array.isArray(missingFamilies)
        || !Array.isArray(files)) {
        return EMPTY_RESOLUTION;
    }

    const fontUrls = [ ...new Set(files
        .map(file => file?.Path)
        .filter((path): path is string => typeof path === 'string' && path.length > 0)
        .map(path => apiClient.getUrl(path, {
            ApiKey: apiClient.accessToken()
        }))) ];

    return {
        fontUrls,
        fullyResolved: requestedFamilies.length > 0
            && missingFamilies.length === 0
            && fontUrls.length > 0
    };
}

export async function resolveSubtitleFontBridge(
    apiClient: ApiClient,
    itemId: string | undefined,
    mediaSourceId: string | undefined,
    subtitleIndex: number | undefined
): Promise<ResolvedSubtitleFonts> {
    if (!itemId || !mediaSourceId || !Number.isInteger(subtitleIndex)) {
        return EMPTY_RESOLUTION;
    }

    const url = apiClient.getUrl(
        `SubtitleFontBridge/Subtitles/${encodeURIComponent(itemId)}/${encodeURIComponent(mediaSourceId)}/${subtitleIndex}`
    );

    try {
        const result = await withTimeout(
            apiClient.getJSON(url) as Promise<SubtitleFontResolution>,
            RESOLUTION_TIMEOUT_MS
        );
        return parseSubtitleFontResolution(apiClient, result);
    } catch (error) {
        console.debug('Subtitle Font Bridge plugin is unavailable; using embedded subtitle fonts.', error instanceof Error ? error.message : error);
        return EMPTY_RESOLUTION;
    }
}
