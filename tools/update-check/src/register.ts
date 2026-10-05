import * as logging from 'pumpkin:plugin/logging@0.1.0';
import type { PluginInfo } from '@pumpkin-plugins/docs';
import { type Plugin, registerPlugin } from '@pumpkinmc/pumpkin-api-ts';
import { requestMarketJsonAsync, type SchedulePoll } from './http.ts';
import { checkMarketUpdate, marketUpdateUrl } from './sources/market.ts';
import type { JsonRequest } from './updates.ts';

/** Update registration options. A scheduler is required unless a request override is supplied. */
export type UpdateRegistrationOptions =
    | { request: JsonRequest; marketplaceUrl?: string; schedule?: SchedulePoll }
    | { request?: never; marketplaceUrl?: string; schedule: SchedulePoll };

/** Registers a plugin and checks Pumpkin Market for an update after the plugin loads. */
export function registerPluginWithUpdates(plugin: Plugin, info: PluginInfo, options: UpdateRegistrationOptions): void {
    const onLoad = plugin.onLoad.bind(plugin);
    plugin.onLoad = (ctx) => {
        onLoad(ctx);
        try {
            const metadata = plugin.metadata();
            const request = options?.request;
            const schedule = options?.schedule;
            if (!request) {
                if (!schedule) {
                    logFailure(info.name, new Error('A scheduler is required for the automatic update check'));
                    return;
                }
                const url = marketUpdateUrl(info.name, metadata.version, options.marketplaceUrl);
                schedule(() => {
                    requestMarketJsonAsync(url, schedule, (result) => {
                        if (!result.ok) {
                            logFailure(info.name, result.error);
                            return;
                        }
                        reportUpdate(info.name, metadata.version, result.value);
                    });
                });
                return;
            }
            const update = checkMarketUpdate({
                pluginName: info.name,
                currentVersion: metadata.version,
                request,
                ...(options.marketplaceUrl ? { marketplaceUrl: options.marketplaceUrl } : {})
            });
            logUpdate(info.name, update);
        } catch (error) {
            logFailure(info.name, error);
        }
    };
    registerPlugin(plugin);
}

function reportUpdate(pluginName: string, currentVersion: string, response: unknown): void {
    try {
        logUpdate(pluginName, checkMarketUpdate({ pluginName, currentVersion, request: () => response }));
    } catch (error) {
        logFailure(pluginName, error);
    }
}

function logUpdate(pluginName: string, update: ReturnType<typeof checkMarketUpdate>): void {
    if (update.updateAvailable && update.latestVersion) {
        logging.log('info', `${pluginName} update available: ${update.currentVersion} -> ${update.latestVersion}`);
    }
}

function logFailure(pluginName: string, error: unknown): void {
    logging.log('warn', `${pluginName} update check failed: ${error instanceof Error ? error.message : String(error)}`);
}
