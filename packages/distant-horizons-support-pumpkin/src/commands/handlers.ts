import type { CommandSender } from 'pumpkin:plugin/command@0.1.0';
import { CommandFailed, type CommandHandlers } from '@pumpkin-plugins/docs';
import { disposeWasiResource } from '@pumpkin-plugins/plugin-kit/wasi-resource';
import type { Settings } from '../config/schema.ts';
import type { LodCache } from '../lod/cache.ts';
import { FORCE_BLOCK_SAMPLES_PER_TICK, type ForcedLodStart } from '../lod/force-generation.ts';
import { DEFAULT_LOD_GENERATION_RADIUS, MAX_LOD_GENERATION_RADIUS } from '../lod/generation.ts';
import { DEFAULT_LOD_MAP_RADIUS, MAX_LOD_MAP_RADIUS, renderLodMap } from '../lod/map.ts';
import { withPlayer } from '../platform/peers.ts';
import type { Sessions } from '../session.ts';
import type { commands } from './spec.ts';

/** Builds operator handlers for session status and cache management. */
export function commandHandlers(
    sessions: Sessions,
    cache: LodCache,
    settings: Settings
): CommandHandlers<typeof commands, CommandSender> {
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
        'dhs cache disk clear': () => [`Cleared ${cache.clearDisk()} disk cache entries.`],
        'dhs map': (sender) => showMap(cache, sender, DEFAULT_LOD_MAP_RADIUS),
        'dhs map <radius>': (sender, { radius }) => showMap(cache, sender, radius),
        'dhs map <x> <z>': (sender, { x, z }) => showMap(cache, sender, DEFAULT_LOD_MAP_RADIUS, [x, z]),
        'dhs map <x> <z> <radius>': (sender, { x, z, radius }) => showMap(cache, sender, radius, [x, z]),
        'dhs generate': (sender) => generateLods(sessions, settings, sender, DEFAULT_LOD_GENERATION_RADIUS),
        'dhs generate <radius>': (sender, { radius }) => generateLods(sessions, settings, sender, radius),
        'dhs generate <x> <z>': (sender, { x, z }) =>
            generateLods(sessions, settings, sender, DEFAULT_LOD_GENERATION_RADIUS, [x, z]),
        'dhs generate <x> <z> <radius>': (sender, { x, z, radius }) =>
            generateLods(sessions, settings, sender, radius, [x, z])
    };
}

function generateLods(
    sessions: Sessions,
    settings: Settings,
    sender: CommandSender,
    radius: number,
    coordinates?: readonly [x: number, z: number]
): string[] {
    if (!Number.isSafeInteger(radius) || radius < 0 || radius > MAX_LOD_GENERATION_RADIUS) {
        throw new CommandFailed(`Radius must be between 0 and ${MAX_LOD_GENERATION_RADIUS} LOD sections.`);
    }
    const player = sender.asPlayer();
    if (!player) throw new CommandFailed('Run this command as a Java player so the current world is known.');

    try {
        let started: ForcedLodStart | undefined;
        const found = withPlayer(player, settings, (peer) => {
            const [x, z] = coordinates ?? [Math.floor(peer.x), Math.floor(peer.z)];
            started = sessions.forceGenerate(peer, x, z, radius);
        });
        if (!found) throw new CommandFailed('Run this command as a Java player so terrain access is available.');
        if (!started) throw new CommandFailed('Could not start forced LOD capture.');
        return [
            `Started forced LOD capture at section ${started.centerX}, ${started.centerZ} (radius ${radius}; ${started.sections} sections requested).`,
            'Already-generated LOD sections and sections outside the world border will be skipped.',
            `Capturing at full speed with up to ${FORCE_BLOCK_SAMPLES_PER_TICK.toLocaleString()} block samples per tick. Progress will be reported in chat.`
        ];
    } catch (err) {
        if (err instanceof CommandFailed) throw err;
        throw new CommandFailed(err instanceof Error ? err.message : String(err));
    } finally {
        disposeWasiResource(player);
    }
}

function showMap(
    cache: LodCache,
    sender: CommandSender,
    radius: number,
    coordinates?: readonly [x: number, z: number]
): string[] {
    if (!Number.isSafeInteger(radius) || radius < 0 || radius > MAX_LOD_MAP_RADIUS) {
        throw new CommandFailed(`Radius must be between 0 and ${MAX_LOD_MAP_RADIUS} LOD sections.`);
    }
    const player = sender.asPlayer();
    if (!player) throw new CommandFailed('Run this command as a player so the current world is known.');
    let world: ReturnType<typeof player.getWorld> | undefined;
    try {
        world = player.getWorld();
        const level = world.getName();
        const [x, z] =
            coordinates ??
            (() => {
                const position = player.getPosition();
                return [position[0], position[2]] as const;
            })();
        return renderLodMap(cache, level, x, z, radius);
    } finally {
        disposeWasiResource(world);
        disposeWasiResource(player);
    }
}

function formatLimit(limit: number): string {
    if (limit < 0) return 'unlimited';
    if (limit === 0) return 'disabled';
    return String(limit);
}
