import { ansi } from '@pumpkin-plugins/minecraft-colors';
import type { Logger } from '@pumpkin-plugins/plugin-kit/logger';
import { AdaptiveWorkBudget, type TerrainSource } from '@pumpkin-plugins/terrain';
import type { Settings } from './config/schema.ts';
import { LodBuilder } from './lod/builder.ts';
import type { CachedLod, LodCache } from './lod/cache.ts';
import {
    FORCE_BLOCK_SAMPLES_PER_TICK,
    ForcedLodGeneration,
    type ForcedLodPeer,
    type ForcedLodStart
} from './lod/force-generation.ts';
import { sectionKey } from './lod/generation.ts';
import { lodLocation } from './lod/location.ts';
import { PLUGIN_NAME } from './name.ts';
import { CHUNK_SIZE_BLOCKS, SECTION_DETAIL, SECTION_SIZE_BLOCKS } from './protocol/constants.ts';
import {
    decode,
    levelInit,
    type Message,
    packet,
    reject,
    type Section,
    sessionConfig,
    transfer,
    unchanged
} from './protocol/messages.ts';

const logTag = ansi.named.name(PLUGIN_NAME);

/** A Java player snapshot and terrain access, valid only during an adapter callback. */
export interface Peer extends ForcedLodPeer {
    dimension: string;
    x: number;
    z: number;
    send(bytes: Uint8Array): void;
}
/** Obtains fresh host handles for one player, releasing them after the callback. */
export interface Peers {
    withPeer(name: string, use: (peer: Peer) => void): boolean;
}
interface Client {
    level: string;
    distance: number;
    concurrency: number;
    disabled: boolean;
    packets: QueuedPacket[];
}
interface QueuedPacket {
    bytes: Uint8Array;
    cached: boolean;
    lod?: {
        level: string;
        section: Section;
        tracker: number;
        packetCount: number;
        dataBytes: number;
        cached: boolean;
        unchanged: boolean;
    };
}
interface Request {
    name: string;
    tracker: number;
    key: string;
    level: string;
    section: Section;
    timestamp?: number;
    builder?: LodBuilder;
    fallback?: CachedLod;
    cacheChecked?: boolean;
    cached?: CachedLod | null;
    revision: number;
}
/** Runs bounded LOD work, keeping client state separate from short-lived Pumpkin handles. */
export class Sessions {
    private readonly clients = new Map<string, Client>();
    private readonly requests: Request[] = [];
    private readonly revisions = new Map<string, number>();
    private readonly workBudget = new AdaptiveWorkBudget({ initialUnits: 8192 });
    private readonly forcedGeneration: ForcedLodGeneration;
    private buffer = 1;
    private ticks = 0;
    private served = 0;
    private rejected = 0;
    private cancelled = 0;
    private lastFailure = '';
    private lastBlocksBudget = 0;
    private lastServerMspt = 0;
    constructor(
        private readonly settings: Settings,
        private readonly cache: LodCache,
        private readonly log: Logger,
        private readonly now = Date.now,
        private readonly measureNow = Date.now
    ) {
        this.forcedGeneration = new ForcedLodGeneration(cache, log, now);
    }
    /** Starts a cache-refreshing capture that takes priority over ordinary DH work. */
    forceGenerate(peer: Peer, blockX: number, blockZ: number, radius = 0): ForcedLodStart {
        return this.forcedGeneration.start(peer, blockX, blockZ, radius);
    }
    /** Accepts and validates a DH packet from a Java player. */
    receive(peer: Peer, bytes: Uint8Array): void {
        let message: Message;
        try {
            message = decode(bytes);
        } catch (err) {
            this.log.debug(
                `${logTag} Ignoring malformed DH message from ${ansi.named.name(peer.name)}: ${String(err)}.`
            );
            peer.send(
                packet(1)
                    .string(`${PLUGIN_NAME}: ${String(err)}`)
                    .finish()
            );
            this.left(peer.name);
            return;
        }
        if (message.type === 'close') {
            this.left(peer.name);
            return;
        }
        if (message.type === 'init') {
            if (message.dimension !== peer.dimension) {
                this.log.debug(
                    `${logTag} Ignored DH initialization from ${ansi.named.name(peer.name)} for ${ansi.named.identifier(message.dimension)}; current dimension is ${ansi.named.identifier(peer.dimension)}.`
                );
                return;
            }
            this.announce(peer);
            return;
        }
        const client = this.clients.get(peer.name);
        if (!client) return;
        if (message.type === 'config') {
            client.disabled = message.disabled;
            client.distance = Math.min(message.distance, this.settings.render_distance);
            client.concurrency = Math.min(message.concurrency, this.settings.requests_per_player);
            this.log.debug(
                `${logTag} ${ansi.named.name(peer.name)} configured DH requests: ${message.disabled ? 'disabled' : 'enabled'}, distance ${ansi.named.number(client.distance)}, concurrency ${ansi.named.number(client.concurrency)}.`
            );
            if (client.disabled) {
                const pending = this.requests.filter((request) => request.name === peer.name).length;
                const queued = client.packets.length;
                this.cancelRequests(peer.name);
                client.packets = [];
                this.log.debug(
                    `${logTag} Dropped ${ansi.named.number(pending)} pending request(s) and ${ansi.named.number(queued)} queued packet(s) for ${ansi.named.name(peer.name)}.`
                );
            }
            return;
        }
        if (message.type === 'cancel') {
            const index = this.requests.findIndex((r) => r.name === peer.name && r.tracker === message.tracker);
            const request = this.requests[index];
            if (request) {
                this.cancelled++;
                this.log.debug(
                    `${logTag} Cancelled DH request ${ansi.named.number(request.tracker)} from ${ansi.named.name(peer.name)} for ${lodLocation(request.level, request.section.x, request.section.z)}.`
                );
                this.drop(request);
            }
            return;
        }
        if (message.type !== 'request') return;
        const failure = this.validate(peer, client, message);
        if (failure) {
            this.rejected++;
            this.lastFailure = failure.reason;
            this.log.debug(
                `${logTag} Rejected DH request ${ansi.named.number(message.tracker)} from ${ansi.named.name(peer.name)} for ${lodLocation(peer.level, message.section.x, message.section.z)}: ${failure.reason}.`
            );
            peer.send(reject(message.tracker, failure.reason, failure.kind));
            return;
        }
        if (this.requests.some((r) => r.name === peer.name && r.tracker === message.tracker)) {
            this.log.debug(
                `${logTag} Ignored duplicate DH request ${ansi.named.number(message.tracker)} from ${ansi.named.name(peer.name)}.`
            );
            return;
        }
        const key = sectionKey(peer.level, message.section.x, message.section.z);
        this.log.debug(
            `${logTag} Queued DH request ${ansi.named.number(message.tracker)} from ${ansi.named.name(peer.name)} for ${lodLocation(peer.level, message.section.x, message.section.z)}.`
        );
        this.requests.push({
            name: peer.name,
            tracker: message.tracker,
            key,
            level: peer.level,
            section: message.section,
            timestamp: message.timestamp,
            revision: this.revisions.get(key) ?? 0
        });
    }
    /** Advances sampling and transfers within global per-tick budgets. */
    tick(peers: Peers, serverMspt = 0): void {
        this.ticks++;
        for (const [name, client] of this.clients) {
            if (
                !peers.withPeer(name, (peer) => {
                    if (peer.level !== client.level) this.announce(peer);
                })
            )
                this.left(name);
        }
        const forcedWork = this.forcedGeneration.tick(peers);
        if (forcedWork) {
            this.lastBlocksBudget = 0;
            this.lastServerMspt = serverMspt;
        }
        let cacheChecks = 0;
        let builderStepped = false;
        const blocksBudget = forcedWork ? 0 : this.workBudget.next(serverMspt, this.settings.blocks_per_tick);
        this.lastBlocksBudget = blocksBudget;
        if (!forcedWork) this.lastServerMspt = serverMspt;
        let cachedQueued = [...this.clients.values()].reduce(
            (sum, client) => sum + client.packets.filter((packet) => packet.cached).length,
            0
        );
        for (const request of forcedWork ? [] : [...this.requests]) {
            if (!this.requests.includes(request)) continue;
            const queuedClient = this.clients.get(request.name);
            if (!queuedClient || queuedClient.packets.length) continue;
            const found = peers.withPeer(request.name, (peer) => {
                try {
                    const client = this.clients.get(peer.name);
                    if (!client || this.validate(peer, client, { ...request, type: 'request' }, false)) {
                        this.rejected++;
                        this.lastFailure = 'Request no longer in range';
                        this.log.debug(
                            `${logTag} Rejected DH request ${ansi.named.number(request.tracker)} from ${ansi.named.name(peer.name)} for ${lodLocation(request.level, request.section.x, request.section.z)}: ${this.lastFailure}.`
                        );
                        peer.send(reject(request.tracker, this.lastFailure, 1));
                        this.drop(request);
                        return;
                    }
                    if ((this.revisions.get(request.key) ?? 0) !== request.revision)
                        throw new Error('Terrain changed while building; retry this request');
                    if (!request.builder) {
                        if (!request.cacheChecked) {
                            if (cacheChecks >= this.settings.cached_requests_per_tick) return;
                            request.cached = this.cache.get(request.key) ?? null;
                            request.cacheChecked = true;
                            cacheChecks++;
                            this.log.debug(
                                `${logTag} LOD cache ${request.cached ? 'hit' : 'miss'} for ${ansi.named.name(request.name)} at ${lodLocation(request.level, request.section.x, request.section.z)}.`
                            );
                        }
                        const cached = request.cached ?? undefined;
                        if (cached && this.now() - cached.updated < this.settings.refresh_seconds * 1000) {
                            if (cachedQueued < this.settings.cached_packets_per_tick)
                                cachedQueued += this.complete(request, cached, true);
                            return;
                        }
                        request.fallback = cached;
                    }
                    if (builderStepped || blocksBudget === 0) return;
                    builderStepped = true;
                    const region = {
                        originX: request.section.x * SECTION_SIZE_BLOCKS,
                        originZ: request.section.z * SECTION_SIZE_BLOCKS,
                        width: SECTION_SIZE_BLOCKS,
                        depth: SECTION_SIZE_BLOCKS,
                        minY: peer.terrain.minY,
                        height: peer.terrain.height
                    };
                    const prepared = peer.terrain.prepare?.(region);
                    if (prepared?.status === 'pending') return;
                    if (prepared && prepared.status !== 'ready') throw new Error(prepared.reason);
                    request.builder ??= new LodBuilder(request.section, peer.terrain.minY, peer.terrain.height);
                    const measured = measureTerrainSource(peer.terrain);
                    const started = this.measureNow();
                    const complete = request.builder.step(measured.source, blocksBudget);
                    if (complete) {
                        const stillLoaded = peer.terrain.prepare?.(region);
                        if (stillLoaded?.status === 'pending') {
                            this.workBudget.observe(measured.samples(), this.measureNow() - started);
                            return;
                        }
                        if (stillLoaded && stillLoaded.status !== 'ready') throw new Error(stillLoaded.reason);
                        const captured = { updated: this.now(), data: request.builder.finish(this.now()) };
                        this.cache.put(request.key, captured);
                        this.log.debug(
                            `${logTag} Captured LOD for ${ansi.named.name(request.name)} at ${lodLocation(request.level, request.section.x, request.section.z)} (${ansi.named.number(captured.data.length)} bytes).`
                        );
                        this.complete(request, captured);
                    }
                    this.workBudget.observe(measured.samples(), this.measureNow() - started);
                } catch (err) {
                    if (request.fallback && (this.revisions.get(request.key) ?? 0) === request.revision)
                        cachedQueued += this.complete(request, request.fallback, true);
                    else {
                        this.rejected++;
                        this.lastFailure = String(err);
                        peer.send(
                            reject(
                                request.tracker,
                                'Terrain unavailable or changed; only loaded chunks and cached LODs can be served'
                            )
                        );
                        this.drop(request);
                    }
                    this.log.debug(`${PLUGIN_NAME}: ${String(err)}`);
                }
            });
            if (!found) this.left(request.name);
        }
        let remaining = this.settings.packets_per_tick;
        let cachedRemaining = this.settings.cached_packets_per_tick;
        for (const [name, client] of this.clients) {
            if (remaining <= 0 && cachedRemaining <= 0) break;
            peers.withPeer(name, (peer) => {
                while (client.packets.length) {
                    const packet = client.packets[0];
                    if (!packet || (packet.cached ? cachedRemaining <= 0 : remaining <= 0)) break;
                    client.packets.shift();
                    peer.send(packet.bytes);
                    if (packet.lod) {
                        const {
                            level,
                            section,
                            tracker,
                            packetCount,
                            dataBytes,
                            cached,
                            unchanged: noChange
                        } = packet.lod;
                        const response = noChange ? 'unchanged LOD response' : cached ? 'cached LOD' : 'captured LOD';
                        this.log.debug(
                            `${logTag} Sent ${response} to ${ansi.named.name(peer.name)} for ${lodLocation(level, section.x, section.z)} (request ${ansi.named.number(tracker)}, ${ansi.named.number(packetCount)} packet(s), ${ansi.named.number(dataBytes)} bytes).`
                        );
                    }
                    if (packet.cached) cachedRemaining--;
                    else remaining--;
                }
            });
        }
    }
    /** Removes a disconnected client's work and queued transfers. */
    left(name: string): void {
        const client = this.clients.get(name);
        const pending = this.requests.filter((request) => request.name === name).length;
        const queued = client?.packets.length ?? 0;
        this.removeClient(name);
        if (client) {
            this.log.debug(
                `${logTag} Removed DH session for ${ansi.named.name(name)}; discarded ${ansi.named.number(pending)} pending request(s) and ${ansi.named.number(queued)} queued packet(s).`
            );
        }
    }
    /** Removes a leaving player and cancels their operator capture. */
    playerLeft(name: string): void {
        this.forcedGeneration.left(name);
        this.removeClient(name);
    }
    /** Invalidates a known changed section and cancels its obsolete captures. */
    changed(level: string, x: number, z: number): void {
        const key = sectionKey(level, Math.floor(x / SECTION_SIZE_BLOCKS), Math.floor(z / SECTION_SIZE_BLOCKS));
        this.cache.remove(key);
        this.forcedGeneration.changed(level, x, z);
        // Only running requests need a revision; this map stays bounded by the request limit.
        if (this.requests.some((r) => r.key === key)) this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
    }
    private removeClient(name: string): void {
        this.clients.delete(name);
        this.cancelRequests(name);
    }
    /** Describes current queues for the operator command. */
    status(): string {
        const forced = this.forcedGeneration.status();
        const request = this.requests[0];
        const progress = request?.builder
            ? forced
                ? ` Paused DH capture ${request.level} ${request.section.x}, ${request.section.z}: ${(request.builder.progress() * 100).toFixed(1)}%.`
                : ` Capturing ${request.level} ${request.section.x}, ${request.section.z}: ${(request.builder.progress() * 100).toFixed(1)}%.`
            : '';
        const packets = [...this.clients.values()].reduce((sum, client) => sum + client.packets.length, 0);
        const budget = forced
            ? ` Forced budget up to ${FORCE_BLOCK_SAMPLES_PER_TICK} block samples/tick; ordinary DH sampling paused.`
            : ` Capture budget ${this.lastBlocksBudget}/${this.settings.blocks_per_tick} block samples/tick at ${this.lastServerMspt.toFixed(1)} MSPT.`;
        return `${this.clients.size} DH client(s), ${this.requests.length} pending LOD request(s). ${this.ticks} worker tick(s), ${this.served} served, ${this.rejected} rejected, ${this.cancelled} cancelled, ${packets} queued packet(s).${progress}${forced ? ` ${forced}` : ''}${budget}${this.lastFailure ? ` Last rejection: ${this.lastFailure}.` : ''} Distant chunk generation is unavailable in the pinned Pumpkin API.`;
    }
    private announce(peer: Peer): void {
        this.removeClient(peer.name);
        this.clients.set(peer.name, {
            level: peer.level,
            distance: this.settings.render_distance,
            concurrency: this.settings.requests_per_player,
            disabled: false,
            packets: []
        });
        peer.send(levelInit(peer.dimension, this.settings.server_key, peer.level, this.now()));
        peer.send(
            sessionConfig(
                this.settings.render_distance,
                this.settings.generation_requests_per_second,
                this.settings.sync_requests_per_second
            )
        );
        this.log.debug(
            `${logTag} Established DH session with ${ansi.named.name(peer.name)} in ${ansi.named.identifier(peer.dimension)} / ${ansi.named.identifier(peer.level)} (distance ${ansi.named.number(this.settings.render_distance)}, generation rate ${ansi.named.number(this.settings.generation_requests_per_second)}/s, sync rate ${ansi.named.number(this.settings.sync_requests_per_second)}/s).`
        );
    }
    private complete(request: Request, value: CachedLod, cached = false): number {
        const client = this.clients.get(request.name);
        let packetCount = 0;
        if (client) {
            this.served++;
            const packets =
                request.timestamp !== undefined && value.updated <= request.timestamp
                    ? [unchanged(request.tracker)]
                    : transfer(request.tracker, this.buffer++, value.data);
            const lod = {
                level: request.level,
                section: request.section,
                tracker: request.tracker,
                packetCount: packets.length,
                dataBytes: value.data.length,
                cached,
                unchanged: request.timestamp !== undefined && value.updated <= request.timestamp
            };
            client.packets.push(
                ...packets.map((bytes, index) => ({ bytes, cached, ...(index === packets.length - 1 ? { lod } : {}) }))
            );
            packetCount = packets.length;
        }
        this.drop(request);
        if (!this.requests.some((r) => r.key === request.key)) this.revisions.delete(request.key);
        return cached ? packetCount : 0;
    }
    private drop(request: Request): void {
        const index = this.requests.indexOf(request);
        if (index >= 0) this.requests.splice(index, 1);
        if (!this.requests.some((r) => r.key === request.key)) this.revisions.delete(request.key);
    }
    private cancelRequests(name: string): void {
        for (let i = this.requests.length - 1; i >= 0; i--) {
            if (this.requests[i]?.name === name) this.requests.splice(i, 1);
        }
        for (const key of this.revisions.keys())
            if (!this.requests.some((r) => r.key === key)) this.revisions.delete(key);
    }
    private validate(
        peer: Peer,
        client: Client,
        request: Extract<Message, { type: 'request' }>,
        capacity = true
    ): { reason: string; kind: number } | undefined {
        if (request.level !== peer.level || client.level !== peer.level) return { reason: 'Wrong world', kind: 2 };
        if (client.disabled) return { reason: 'LOD requests disabled by client', kind: 2 };
        if (request.section.detail !== SECTION_DETAIL) return { reason: 'Request block-detail sections', kind: 3 };
        const x = request.section.x * SECTION_SIZE_BLOCKS,
            z = request.section.z * SECTION_SIZE_BLOCKS,
            range = client.distance * CHUNK_SIZE_BLOCKS;
        if (
            Math.max(Math.abs(x + SECTION_SIZE_BLOCKS / 2 - peer.x), Math.abs(z + SECTION_SIZE_BLOCKS / 2 - peer.z)) >
                range ||
            !peer.insideBorder(x, z) ||
            !peer.insideBorder(x + SECTION_SIZE_BLOCKS - 1, z + SECTION_SIZE_BLOCKS - 1)
        )
            return { reason: 'Section outside request range or world border', kind: 1 };
        // Backpressure includes transfers: don't let repeated requests build an unbounded byte queue.
        if (
            client.concurrency === 0 ||
            (capacity &&
                (client.packets.length > 0 ||
                    this.requests.length >= this.settings.pending_requests ||
                    this.requests.filter((r) => r.name === peer.name).length >= client.concurrency))
        )
            return { reason: 'LOD request limit reached', kind: 0 };
        return undefined;
    }
}

export { sectionKey } from './lod/generation.ts';

function measureTerrainSource(source: TerrainSource): { source: TerrainSource; samples: () => number } {
    let samples = 0;
    const measured: TerrainSource = {
        minY: source.minY,
        height: source.height,
        sample: (x, y, z) => {
            samples++;
            return source.sample(x, y, z);
        }
    };
    if (source.top) measured.top = source.top.bind(source);
    return { source: measured, samples: () => samples };
}
