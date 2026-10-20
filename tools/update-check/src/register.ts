import * as logging from 'pumpkin:plugin/logging@0.1.0';
import type { PluginInfo } from '@pumpkin-plugins/docs';
import { type Plugin, registerPlugin } from '@pumpkin-plugins/pumpkin-api';
import { requestMarketJsonAsync, type SchedulePoll } from './http.ts';
import { normalizeMarkdownForConsole } from './markdown.ts';
import { checkMarketUpdate, marketUpdateUrl } from './sources/market.ts';
import type { JsonRequest } from './updates.ts';

/** Update registration options. A scheduler is required unless a request override is supplied. */
export type UpdateRegistrationOptions =
    | {
          /**
           * Replaces the scheduled Market request. It runs synchronously inside `onLoad` and blocks
           * plugin loading, so use it only in tests.
           */
          request: JsonRequest;
          marketplaceUrl?: string;
          schedule?: SchedulePoll;
      }
    | { request?: never; marketplaceUrl?: string; schedule: SchedulePoll };

/** Registers a plugin and checks Pumpkin Market for an update after the plugin loads. */
export function registerPluginWithUpdates(plugin: Plugin, info: PluginInfo, options: UpdateRegistrationOptions): void {
    const onLoad = plugin.onLoad.bind(plugin);
    plugin.onLoad = (ctx) => {
        onLoad(ctx);
        if (typeof __PUMPKIN_DEV_MODE__ !== 'undefined' && __PUMPKIN_DEV_MODE__) return;
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
                ...(options.marketplaceUrl ? { marketplaceUrl: options.marketplaceUrl } : {}),
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
        const changelog = update.releaseNotes ? normalizeMarkdownForConsole(update.releaseNotes) : '';
        const formattedChangelog = changelog
            ? `\nChangelog:\n${changelog
                  .split('\n')
                  .map((line) => `  ${line}`)
                  .join('\n')}`
            : '';
        logging.log(
            'info',
            `${pluginName} update available: ${update.currentVersion} -> ${update.latestVersion}${formattedChangelog}`,
        );
    }
}

function logFailure(pluginName: string, error: unknown): void {
    logging.log('warn', `${pluginName} update check failed: ${error instanceof Error ? error.message : String(error)}`);
}
