import type { WorkloadScenario } from '../benchmark-workloads.ts';
import { PERMISSION_WORLDS } from './shared.ts';

const REGION_EVENT_COUNT = 20_000;
const WORLD_EDIT_WIDTH = 48;
const WORLD_EDIT_HEIGHT = 24;

/** Region protection and block-edit planning workloads. */
export const WORLD_WORKLOADS: readonly WorkloadScenario[] = [
    {
        name: 'region-protection',
        area: 'Region containment and access checks',
        operationsPerSample: REGION_EVENT_COUNT,
        run: runRegionProtection,
    },
    {
        name: 'world-edit-plan',
        area: 'Block-edit plan generation',
        operationsPerSample: WORLD_EDIT_WIDTH * WORLD_EDIT_HEIGHT * WORLD_EDIT_WIDTH,
        run: runWorldEditPlan,
    },
];

interface ProtectedRegion {
    allowPublicPlace: boolean;
    maximumX: number;
    maximumZ: number;
    minimumX: number;
    minimumZ: number;
    ownerId: number;
    trustedPlayers: ReadonlySet<number>;
    world: string;
}

function runRegionProtection(): number {
    const regionsByChunk = new Map<string, ProtectedRegion[]>();
    for (let worldIndex = 0; worldIndex < PERMISSION_WORLDS.length; worldIndex++) {
        const world = PERMISSION_WORLDS[worldIndex];
        for (let column = 0; column < 8; column++) {
            for (let row = 0; row < 4; row++) {
                const region: ProtectedRegion = {
                    world,
                    minimumX: -512 + column * 128,
                    maximumX: -449 + column * 128,
                    minimumZ: -256 + row * 128,
                    maximumZ: -193 + row * 128,
                    ownerId: (column * 11 + row * 7 + worldIndex) % 4_096,
                    trustedPlayers: new Set([(column * 17 + row * 13) % 4_096]),
                    allowPublicPlace: (column + row) % 5 === 0,
                };
                addRegionToChunkIndex(regionsByChunk, region);
            }
        }
    }

    let checksum = 0;
    for (let event = 0; event < REGION_EVENT_COUNT; event++) {
        const world = PERMISSION_WORLDS[event % PERMISSION_WORLDS.length];
        const x = ((event * 73) % 1_024) - 512;
        const z = ((event * 43) % 1_024) - 512;
        const playerId = (event * 19) % 4_096;
        const action = event % 2 === 0 ? 'break' : 'place';
        const candidates = regionsByChunk.get(`${world}:${x >> 4}:${z >> 4}`) ?? [];
        let allowed = true;

        for (const region of candidates) {
            if (x < region.minimumX || x > region.maximumX || z < region.minimumZ || z > region.maximumZ) continue;
            allowed =
                playerId === region.ownerId ||
                region.trustedPlayers.has(playerId) ||
                (action === 'place' && region.allowPublicPlace);
            break;
        }
        checksum = (checksum + (allowed ? 1 : 0) + candidates.length) >>> 0;
    }
    return checksum;
}

function addRegionToChunkIndex(index: Map<string, ProtectedRegion[]>, region: ProtectedRegion): void {
    for (let chunkX = region.minimumX >> 4; chunkX <= region.maximumX >> 4; chunkX++) {
        for (let chunkZ = region.minimumZ >> 4; chunkZ <= region.maximumZ >> 4; chunkZ++) {
            const key = `${region.world}:${chunkX}:${chunkZ}`;
            const regions = index.get(key) ?? [];
            regions.push(region);
            index.set(key, regions);
        }
    }
}

interface BlockChange {
    after: number;
    before: number;
    x: number;
    y: number;
    z: number;
}

function runWorldEditPlan(): number {
    const changes: BlockChange[] = [];
    const palette = [1, 2, 3, 4, 5, 6, 7, 8];
    for (let x = 0; x < WORLD_EDIT_WIDTH; x++) {
        for (let y = 0; y < WORLD_EDIT_HEIGHT; y++) {
            for (let z = 0; z < WORLD_EDIT_WIDTH; z++) {
                const offsetX = x - 24;
                const offsetY = y - 12;
                const offsetZ = z - 24;
                if (offsetX * offsetX + offsetY * offsetY + offsetZ * offsetZ > 24 * 24) continue;

                const before = (x * 31 + y * 17 + z * 13) % 9;
                if (before === 0 || (x + z) % 5 === 0) continue;
                const after = palette[(x + y + z) % palette.length];
                if (before !== after) changes.push({ x, y, z, before, after });
            }
        }
    }

    let checksum = changes.length;
    for (const change of changes) {
        checksum = (checksum + change.x * 3 + change.y * 5 + change.z * 7 + change.before + change.after) >>> 0;
    }
    return checksum;
}
