import type { Server } from 'pumpkin:plugin/server@0.1.0';
import { schema } from '../../../packages/distant-horizons-support-pumpkin/src/config/schema.ts';
import { LodCache } from '../../../packages/distant-horizons-support-pumpkin/src/lod/cache.ts';
import { sectionKey } from '../../../packages/distant-horizons-support-pumpkin/src/lod/generation.ts';
import { createTerrainAccess } from '../../../packages/distant-horizons-support-pumpkin/src/platform/terrain-access.ts';
import { SECTION_SIZE_BLOCKS } from '../../../packages/distant-horizons-support-pumpkin/src/protocol/constants.ts';
import type { Peer, Peers } from '../../../packages/distant-horizons-support-pumpkin/src/session.ts';
import { Sessions } from '../../../packages/distant-horizons-support-pumpkin/src/session.ts';
import { PumpkinPlusPlusSession, WarningScope } from '../../../tools/apis/pumpkin-plus-plus-api/src/session.ts';
import { defaultValues } from '../../../tools/config/src/index.ts';
import { hostLogger } from '../../../tools/plugin-kit/src/host.ts';
import { ipcSend } from '../../../tools/plugin-kit/src/ipc.ts';
import type { Logger } from '../../../tools/plugin-kit/src/logger.ts';
import { MemoryFiles } from '../../../tools/plugin-kit/src/testing/memory-files.ts';
import { disposeWasiResource } from '../../../tools/plugin-kit/src/wasi-resource.ts';
import { Plugin, registerPlugin } from '../../../tools/pumpkin-api/src/index.ts';

const FIXTURE_NAME = 'DistantHorizonsPumpkinPlusPlusFixture';
const CAPTURE_BLOCK_X = -512;
const CAPTURE_BLOCK_Z = 512;
const SECTION_X = Math.floor(CAPTURE_BLOCK_X / SECTION_SIZE_BLOCKS);
const SECTION_Z = Math.floor(CAPTURE_BLOCK_Z / SECTION_SIZE_BLOCKS);
const CHUNK_X = Math.floor((SECTION_X * SECTION_SIZE_BLOCKS) / 16);
const CHUNK_Z = Math.floor((SECTION_Z * SECTION_SIZE_BLOCKS) / 16);
const CAPTURE_WORLD = 'distant-horizons-bridge-air';
const values = defaultValues(schema);
const settings = { ...values.support, worlds: values.worlds };
const fixtureLogger: Logger = {
    debug: (message) => hostLogger.info(`${FIXTURE_NAME}: debug ${message}`),
    info: hostLogger.info,
    warn: hostLogger.warn,
    error: hostLogger.error,
};

/** Drives the production LOD session and terrain adapter against a real host world. */
class DistantHorizonsPumpkinPlusPlusFixture extends Plugin {
    private sessions: Sessions | undefined;
    private cache: LodCache | undefined;
    private finished = false;
    private leaseTicks = 0;
    private captureLevel: string | undefined;
    private generatedChunks = 0;

    metadata() {
        return {
            name: FIXTURE_NAME,
            version: __PLUGIN_VERSION__,
            authors: [],
            description: 'Distant Horizons Pumpkin++ real-server fixture',
            dependencies: [],
            permissions: [],
        };
    }

    override onLoad(ctx) {
        super.onLoad(ctx);
        this.registerEvent(ctx, 'server-tick-end-event', (server) => this.tick(server));
        hostLogger.info(`${FIXTURE_NAME}: ready`);
    }

    override onUnload(ctx) {
        this.sessions?.dispose();
        this.sessions = undefined;
        super.onUnload(ctx);
    }

    private tick(server: Server): void {
        if (this.finished) return;
        try {
            if (!this.sessions) {
                this.createWorld(server);
                this.cache = new LodCache(new MemoryFiles(), settings.memory_cache_entries, 0);
                this.sessions = new Sessions(
                    settings,
                    this.cache,
                    fixtureLogger,
                    nowMilliseconds,
                    nowMilliseconds,
                    new PumpkinPlusPlusSession({
                        send: ipcSend,
                        now: nowMilliseconds,
                        warn: hostLogger.warn,
                        warnings: new WarningScope(),
                    }),
                    nowMilliseconds,
                );
                if (
                    !this.withWorld(server, (peer) =>
                        this.sessions?.forceGenerate(peer, CAPTURE_BLOCK_X, CAPTURE_BLOCK_Z),
                    )
                )
                    return;
                hostLogger.info(
                    `${FIXTURE_NAME}: capture started for ${CAPTURE_WORLD} section ${SECTION_X}, ${SECTION_Z}`,
                );
            }

            this.sessions.tick(this.peers(server), server.getMspt());
            const world = this.captureLevel;
            if (!world) return;
            const tickets = inspectChunk(world, CHUNK_X, CHUNK_Z);
            const key = sectionKey(world, SECTION_X, SECTION_Z);
            const captured = this.cache?.get(key);
            if (!captured && tickets.levels.includes(43)) this.leaseTicks++;
            if (!captured) {
                if (!this.sessions.status().includes('Forced LOD capture for')) {
                    throw new Error(
                        `LOD generation finished without committing the requested section; generatedChunks=${this.generatedChunks}; status=${this.sessions.status()}`,
                    );
                }
                return;
            }
            if (this.leaseTicks < 1) throw new Error('No native chunk ticket was held during LOD capture');
            if (tickets.levels.length !== 0)
                throw new Error(`LOD capture leaked a chunk lease: ${JSON.stringify(tickets)}`);
            this.finished = true;
            hostLogger.info(
                `${FIXTURE_NAME}: capture complete ${JSON.stringify({
                    key,
                    bytes: captured.data.length,
                    leaseTicks: this.leaseTicks,
                    generatedChunks: this.generatedChunks,
                    tickets,
                })}`,
            );
        } catch (error) {
            this.finished = true;
            hostLogger.error(`${FIXTURE_NAME}: capture failed: ${String(error)}`);
        }
    }

    private peers(server: Server): Peers {
        return {
            withPeer: (name, use) => (name === FIXTURE_NAME ? this.withWorld(server, use) : false),
        };
    }

    private createWorld(server: Server): void {
        const world = server.createWorld(CAPTURE_WORLD, 'overworld');
        try {
            this.captureLevel = world.getName();
            const generator = this.registerChunkGenerator(() => {
                this.generatedChunks++;
            });
            world.setChunkGenerator(generator);
        } finally {
            disposeWasiResource(world);
        }
    }

    private withWorld(server: Server, use: (peer: Peer) => void): boolean {
        const worlds = server.getAllWorlds();
        try {
            const world = worlds.find((candidate) => candidate.getName() === this.captureLevel);
            if (!world) return false;
            const border = world.getWorldBorder();
            try {
                const level = world.getName();
                const dimension = world.getDimension();
                const centerX = border.getCenterX();
                const centerZ = border.getCenterZ();
                const radius = border.getSize() / 2;
                use({
                    name: FIXTURE_NAME,
                    level,
                    dimension,
                    x: centerX,
                    z: centerZ,
                    send: () => {},
                    report: (message) => hostLogger.info(`${FIXTURE_NAME}: ${message}`),
                    borderBounds: {
                        minX: centerX - radius,
                        maxX: centerX + radius,
                        minZ: centerZ - radius,
                        maxZ: centerZ + radius,
                    },
                    insideBorder: (x, z) =>
                        Math.abs(x + 0.5 - centerX) <= radius && Math.abs(z + 0.5 - centerZ) <= radius,
                    terrain: createTerrainAccess(world, settings),
                });
                return true;
            } finally {
                disposeWasiResource(border);
            }
        } finally {
            for (const world of worlds) disposeWasiResource(world);
        }
    }
}

registerPlugin(new DistantHorizonsPumpkinPlusPlusFixture());

function inspectChunk(world: string, x: number, z: number): { levels: number[]; loaded: boolean } {
    const request = asciiBytes(JSON.stringify({ world, x, z }));
    return JSON.parse(asciiString(ipcSend('BridgeInspector', request)));
}

function asciiBytes(text: string): Uint8Array {
    const bytes = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index);
    return bytes;
}

function asciiString(bytes: Uint8Array): string {
    let text = '';
    for (const byte of bytes) text += String.fromCharCode(byte);
    return text;
}

function nowMilliseconds(): number {
    return Date.now();
}

export * from '../../../tools/pumpkin-api/src/index.ts';
