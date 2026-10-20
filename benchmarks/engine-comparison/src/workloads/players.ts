import type { WorkloadScenario } from '../benchmark-workloads.ts';
import { PERMISSION_WORLDS } from './shared.ts';

const PLAYER_DIRECTORY_SIZE = 6_000;
const PLAYER_LOOKUP_COUNT = 12_000;
const EVENT_CACHE_TICK_COUNT = 20_000;

/** Player directory and lifecycle cache workloads. */
export const PLAYER_WORKLOADS: readonly WorkloadScenario[] = [
    {
        name: 'player-directory',
        area: 'Player and home lookups',
        operationsPerSample: PLAYER_DIRECTORY_SIZE + PLAYER_LOOKUP_COUNT,
        run: runPlayerDirectory,
    },
    {
        name: 'event-cache',
        area: 'Lifecycle cache updates',
        operationsPerSample: EVENT_CACHE_TICK_COUNT,
        run: runEventCache,
    },
];

interface PlayerProfile {
    balance: number;
    homes: readonly string[];
    name: string;
    uuid: string;
    world: string;
}

function runPlayerDirectory(): number {
    const byUuid = new Map<string, PlayerProfile>();
    const byName = new Map<string, PlayerProfile>();
    for (let id = 0; id < PLAYER_DIRECTORY_SIZE; id++) {
        const hexadecimalId = id.toString(16);
        const profile: PlayerProfile = {
            uuid: `00000000-0000-4000-8000-${'000000000000'.slice(hexadecimalId.length)}${hexadecimalId}`,
            name: `Player${id}`,
            world: PERMISSION_WORLDS[id % PERMISSION_WORLDS.length],
            balance: 1_000 + ((id * 97) % 90_000),
            homes: id % 3 === 0 ? ['home', 'farm'] : ['home'],
        };
        byUuid.set(profile.uuid, profile);
        byName.set(profile.name.toLowerCase(), profile);
    }

    let checksum = 0;
    for (let lookup = 0; lookup < PLAYER_LOOKUP_COUNT; lookup++) {
        const id = lookup % PLAYER_DIRECTORY_SIZE;
        const profile =
            lookup % 2 === 0
                ? byName.get(`player${id}`)
                : byUuid.get(
                      `00000000-0000-4000-8000-${'000000000000'.slice(id.toString(16).length)}${id.toString(16)}`,
                  );
        if (profile !== undefined) checksum += profile.balance + profile.name.length + profile.homes.length;
    }
    return checksum;
}

function runEventCache(): number {
    const cache = new Map<string, { food: number; lastTick: number }>();
    for (let tick = 0; tick < EVENT_CACHE_TICK_COUNT; tick++) {
        const playerId = `player-${tick % 2_000}`;
        const current = cache.get(playerId);
        cache.set(playerId, { food: current ? (current.food + 1) % 21 : tick % 21, lastTick: tick });
        if (tick % 1_000 === 999) {
            for (const [id, entry] of cache) {
                if (tick - entry.lastTick > 1_000) cache.delete(id);
            }
        }
    }
    let checksum = 0;
    for (const [id, entry] of cache) checksum += id.length + entry.food + entry.lastTick;
    return checksum;
}
