import { compareVersions, type JsonRequest, type UpdateCheck } from '../updates.ts';

/** Settings needed to check a plugin against Pumpkin Market. */
export interface MarketUpdateOptions {
    request: JsonRequest;
    pluginName: string;
    currentVersion: string;
    marketplaceUrl?: string;
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
        marketUpdateUrl(options.pluginName, options.currentVersion, options.marketplaceUrl)
    );
    if (typeof response !== 'object' || response === null) throw new TypeError('Invalid Market update response');
    const payload = response as { latest_version?: unknown; update_available?: unknown };
    if (typeof payload.update_available !== 'boolean') throw new TypeError('Invalid Market update response');
    const latestVersion = typeof payload.latest_version === 'string' ? payload.latest_version : null;
    return {
        currentVersion: options.currentVersion,
        latestVersion,
        updateAvailable:
            latestVersion === null
                ? payload.update_available
                : compareVersions(options.currentVersion, latestVersion) < 0
    };
}
