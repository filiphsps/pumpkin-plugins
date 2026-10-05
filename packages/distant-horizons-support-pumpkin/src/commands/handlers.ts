import type { CommandHandlers } from '@pumpkin-plugins/docs';
import type { LodCache } from '../lod/cache.ts';
import type { Sessions } from '../session.ts';
import type { commands } from './spec.ts';

/** Builds operator handlers for session status and cache management. */
export function commandHandlers(sessions: Sessions, cache: LodCache): CommandHandlers<typeof commands> {
    return {
        'dhs status': () => [sessions.status()],
        'dhs cache status': () => {
            const stats = cache.stats();
            return [
                `Memory cache: ${stats.memoryEntries}/${formatLimit(stats.memoryLimit)} entries, ${stats.memoryBytes} bytes.`,
                `Disk cache: ${stats.diskEntries}/${formatLimit(stats.diskLimit)} entries, ${stats.diskBytes} bytes.`
            ];
        },
        'dhs cache clear': () => {
            const cleared = cache.clear();
            return [`Cleared ${cleared.memoryEntries} in-memory and ${cleared.diskEntries} disk cache entries.`];
        },
        'dhs cache memory clear': () => [`Cleared ${cache.clearMemory()} in-memory cache entries.`],
        'dhs cache disk clear': () => [`Cleared ${cache.clearDisk()} disk cache entries.`]
    };
}

function formatLimit(limit: number): string {
    if (limit < 0) return 'unlimited';
    if (limit === 0) return 'disabled';
    return String(limit);
}
