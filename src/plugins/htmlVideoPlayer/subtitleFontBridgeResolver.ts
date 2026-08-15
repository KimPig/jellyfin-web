import type { ApiClient } from 'jellyfin-apiclient';

interface SubtitleFontBridgeFile {
    Id?: string;
    Path?: string;
}

interface SubtitleFontBridgeFamily {
    RequestedFamily?: string;
    FontIds?: string[];
}

interface SubtitleFontBridgeResolution {
    RequestedFamilies?: string[];
    MissingFamilies?: string[];
    Files?: SubtitleFontBridgeFile[];
    Families?: SubtitleFontBridgeFamily[];
}

interface SubtitleFontResolution {
    Resolution?: SubtitleFontBridgeResolution;
}

export interface ResolvedSubtitleFonts {
    /** Font URLs to pass to libass as eager fallback files. */
    fontUrls: string[];
    /** Lower-cased ASS family name to lazily fetched system-font URL. */
    availableFonts: Record<string, string>;
    fullyResolved: boolean;
}

const EMPTY_RESOLUTION: ResolvedSubtitleFonts = {
    fontUrls: [],
    availableFonts: {},
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

function normalizeFamilyName(value: string | undefined): string | undefined {
    const normalized = value?.trim().toLowerCase();
    return normalized || undefined;
}

export function parseSubtitleFontResolution(
    apiClient: ApiClient,
    result?: SubtitleFontResolution | null
): ResolvedSubtitleFonts {
    const resolution = result?.Resolution;
    const requestedFamilies = resolution?.RequestedFamilies;
    const missingFamilies = resolution?.MissingFamilies;
    const files = resolution?.Files;
    const families = resolution?.Families;

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

    const urlByFontId = new Map(files
        .filter((file): file is Required<SubtitleFontBridgeFile> => typeof file?.Id === 'string'
            && file.Id.length > 0
            && typeof file.Path === 'string'
            && file.Path.length > 0)
        .map(file => [file.Id, apiClient.getUrl(file.Path, {
            ApiKey: apiClient.accessToken()
        })]));

    const availableFonts: Record<string, string> = {};
    const eagerFontUrls = new Set<string>();

    if (Array.isArray(families)) {
        for (const family of families) {
            const requestedFamily = normalizeFamilyName(family?.RequestedFamily);
            const fontIds = family?.FontIds;
            if (!requestedFamily || !Array.isArray(fontIds)) {
                continue;
            }

            const urls = fontIds
                .map(fontId => urlByFontId.get(fontId))
                .filter((url): url is string => !!url);
            if (urls.length === 0) {
                continue;
            }

            // libass uses the first URL as its lazy font source for this family.
            availableFonts[requestedFamily] = urls[0];
            // Distinct face files still need to be available for bold/italic selection.
            urls.slice(1).forEach(url => eagerFontUrls.add(url));
        }
    } else {
        // Preserve the old, eager behavior for an older Bridge API response.
        fontUrls.forEach(url => eagerFontUrls.add(url));
    }

    return {
        fontUrls: [ ...eagerFontUrls ],
        availableFonts,
        fullyResolved: requestedFamilies.length > 0
            && missingFamilies.length === 0
            && Object.keys(availableFonts).length > 0
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