import type { WorkloadScenario } from '../benchmark-workloads.ts';
import { isRecord } from './shared.ts';

const CONFIG_VALIDATION_COUNT = 1_000;

const CONFIG_SOURCE = JSON.stringify({
    enabled: true,
    cache: { maxEntries: 512, ttlTicks: 1200 },
    channels: ['status', 'inventory', 'health'],
    aliases: { hp: 'health', inv: 'inventory', st: 'status' },
});

/** Configuration parsing and validation workload. */
export const CONFIG_WORKLOADS: readonly WorkloadScenario[] = [
    {
        name: 'config-validation',
        area: 'Configuration parsing and validation',
        operationsPerSample: CONFIG_VALIDATION_COUNT,
        run: runConfigValidation,
    },
];

function runConfigValidation(): number {
    let checksum = 0;
    for (let index = 0; index < CONFIG_VALIDATION_COUNT; index++) {
        const parsed: unknown = JSON.parse(CONFIG_SOURCE);
        if (
            !isRecord(parsed) ||
            !isRecord(parsed.cache) ||
            !Array.isArray(parsed.channels) ||
            !isRecord(parsed.aliases)
        ) {
            return -1;
        }

        const { cache, channels, aliases } = parsed;
        if (
            parsed.enabled !== true ||
            typeof cache.maxEntries !== 'number' ||
            cache.maxEntries < 1 ||
            typeof cache.ttlTicks !== 'number' ||
            cache.ttlTicks < 1 ||
            channels.some((channel) => typeof channel !== 'string')
        ) {
            return -1;
        }

        const channelNames = new Set(channels as string[]);
        const aliasEntries = Object.entries(aliases);
        if (aliasEntries.some(([, channel]) => typeof channel !== 'string' || !channelNames.has(channel))) return -1;
        checksum += channelNames.size + aliasEntries.length + cache.maxEntries + cache.ttlTicks;
    }
    return checksum;
}
