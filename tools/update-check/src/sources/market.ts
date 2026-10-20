import { assertSemver, compareVersions, type JsonRequest, type UpdateCheck } from '../updates.ts';

/** Settings needed to check a plugin against Pumpkin Market. */
export interface MarketUpdateOptions {
    currentVersion: string;
    marketplaceUrl?: string;
    pluginName: string;
    request: JsonRequest;
}

/** Builds the Pumpkin Market URL for one plugin version check. */
export function marketUpdateUrl(pluginName: string, currentVersion: string, marketplaceUrl?: string): string {
    const baseUrl = (marketplaceUrl ?? 'https://market.pumpkinmc.org').replace(/\/$/, '');
    const query = `plugin_name=${encodeURIComponent(pluginName)}&current_version=${encodeURIComponent(currentVersion)}`;
    return `${baseUrl}/api/v1/rest/check-update?${query}`;
}

/** Checks the stable version of a plugin listed on Pumpkin Market. */
export function checkMarketUpdate(options: MarketUpdateOptions): UpdateCheck {
    const response = options.request(
        marketUpdateUrl(options.pluginName, options.currentVersion, options.marketplaceUrl),
    );
    if (typeof response !== 'object' || response === null) throw new TypeError('Invalid Market update response');
    const payload = response as {
        latest_version?: unknown;
        release_notes?: unknown;
        update_available?: unknown;
    };
    if (
        typeof payload.update_available !== 'boolean' ||
        (payload.latest_version !== null && typeof payload.latest_version !== 'string') ||
        (payload.latest_version === null && payload.update_available) ||
        (payload.release_notes !== undefined &&
            payload.release_notes !== null &&
            typeof payload.release_notes !== 'string')
    ) {
        throw new TypeError('Invalid Market update response');
    }
    const latestVersion = payload.latest_version;
    // Validate the installed version even when Market has no release to compare.
    assertSemver(options.currentVersion);
    return {
        currentVersion: options.currentVersion,
        latestVersion,
        updateAvailable: latestVersion === null ? false : compareVersions(options.currentVersion, latestVersion) < 0,
        ...(typeof payload.release_notes === 'string' ? { releaseNotes: payload.release_notes } : {}),
    };
}
