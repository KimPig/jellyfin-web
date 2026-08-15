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
    /** Font URLs to preload in libass when the Bridge resolves the ASS families. */
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

    const resolvableFamilies = new Set<string>();
    if (Array.isArray(families)) {
        for (const family of families) {
            const requestedFamily = normalizeFamilyName(family?.RequestedFamily);
            const fontIds = family?.FontIds;
            if (!requestedFamily || !Array.isArray(fontIds)) {
                continue;
            }

            const hasResolvedFile = fontIds.some(fontId => files.some(file =>
                file?.Id === fontId && typeof file.Path === 'string' && file.Path.length > 0));
            if (hasResolvedFile) {
                resolvableFamilies.add(requestedFamily);
            }
        }
    }

    const fullyResolved = requestedFamilies.length > 0
        && missingFamilies.length === 0
        && requestedFamilies.every(requestedFamily => {
            const normalizedFamily = normalizeFamilyName(requestedFamily);
            return normalizedFamily !== undefined && resolvableFamilies.has(normalizedFamily);
        });

    return {
        // Preload only the system font files needed by this ASS. This is more
        // reliable than libass' synchronous lazy-file path for plugin endpoints.
        fontUrls,
        fullyResolved
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