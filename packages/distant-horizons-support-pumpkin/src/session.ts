import { ansi } from '@pumpkin-plugins/minecraft-colors';
import type { Logger } from '@pumpkin-plugins/plugin-kit/logger';
import { AdaptiveWorkBudget, type TerrainSource } from '@pumpkin-plugins/terrain';
import type { Settings } from './config/schema.ts';
import { ByteCredit } from './flow/byte-credit.ts';
import { TransferCursor } from './flow/transfer-cursor.ts';
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
    closeSession,
    decode,
    levelInit,
    type Message,
    packet,
    reject,
    type Section,
    type SessionConfiguration,
    sessionConfig,
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
    dimension: string;
    config: SessionConfiguration;
    byteCredit: ByteCredit;
    packets: QueuedPacket[];
}
interface QueuedPacket {
    bytes?: Uint8Array;
    cursor?: TransferCursor;
    cached: boolean;
    lod: {
        level: string;
        section: Section;
        tracker: number;
        packetCount: number;
        dataBytes: number;
        cached: boolean;
        unchanged: boolean;
        sync: boolean;
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
    cacheChecked?: boolean;
    cached?: CachedLod | null;
    revision: number;
}
interface Refresh {
    name: string;
    key: string;
    level: string;
    section: Section;
    revision: number;
    builder?: LodBuilder;
}
/** Runs bounded LOD work, keeping client state separate from short-lived Pumpkin handles. */
export class Sessions {
    private readonly clients = new Map<string, Client>();
    private readonly requests: Request[] = [];
    private readonly refreshes = new Map<string, Refresh>();
    private readonly revisions = new Map<string, number>();
    private readonly workBudget = new AdaptiveWorkBudget({ initialUnits: 8192 });
    private readonly forcedGeneration: ForcedLodGeneration;
    private buffer = 1;
    private sendCursor = 0;
    private requestCursor = 0;
    private ticks = 0;
    private served = 0;
    private rejected = 0;
    private cancelled = 0;
    private dhPacketBytesSent = 0;
    private lastHandlerMs = 0;
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
            const config = this.negotiateConfiguration(message.config);
            client.config = config;
            client.byteCredit.setRate(config.bandwidthKbps, this.now());
            if (config.generationPlan === 3) this.rejectPendingRequestClass(peer, false);
            if (!config.syncEnabled) this.rejectPendingRequestClass(peer, true);
            peer.send(sessionConfig(config));
            this.log.debug(
                `${logTag} ${ansi.named.name(peer.name)} configured DH requests: generation ${config.generationPlan === 3 ? 'disabled' : 'enabled'} (${ansi.named.number(config.generationDistance)} chunks, ${ansi.named.number(config.generationRate)}/s), sync ${config.syncEnabled ? 'enabled' : 'disabled'} (${ansi.named.number(config.syncDistance)} chunks, ${ansi.named.number(config.syncRate)}/s), bandwidth ${config.bandwidthKbps === 0 ? 'unlimited' : `${ansi.named.number(config.bandwidthKbps)} KB/s`}.`
            );
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
        if (
            this.requests.some((r) => r.name === peer.name && r.tracker === message.tracker) ||
            client.packets.some((response) => response.lod.tracker === message.tracker)
        ) {
            this.log.debug(
                `${logTag} Ignored duplicate DH request ${ansi.named.number(message.tracker)} from ${ansi.named.name(peer.name)}.`
            );
            return;
        }
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
        const handlerStarted = this.measureNow();
        this.ticks++;
        const refreshesAtStart = [...this.refreshes.values()];
        for (const [name, client] of this.clients) {
            if (
                !peers.withPeer(name, (peer) => {
                    if (peer.level !== client.level || peer.dimension !== client.dimension) this.announce(peer);
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
        let availabilityChecks = 0;
        let builderStepped = false;
        const blocksBudget = forcedWork ? 0 : this.workBudget.next(serverMspt, this.settings.blocks_per_tick);
        this.lastBlocksBudget = blocksBudget;
        if (!forcedWork) this.lastServerMspt = serverMspt;
        for (const request of this.orderedRequests()) {
            if (!this.requests.includes(request)) continue;
            const queuedClient = this.clients.get(request.name);
            if (!queuedClient) continue;
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
                        if (cached) {
                            const clientHasNewerData =
                                request.timestamp !== undefined && cached.updated <= request.timestamp;
                            const fresh = this.now() - cached.updated < this.settings.refresh_seconds * 1000;
                            if (clientHasNewerData || fresh) {
                                this.complete(request, cached, true);
                                return;
                            }
                            this.scheduleRefresh(request);
                            this.complete(request, cached, true);
                            return;
                        }
                    }
                    const region = {
                        originX: request.section.x * SECTION_SIZE_BLOCKS,
                        originZ: request.section.z * SECTION_SIZE_BLOCKS,
                        width: SECTION_SIZE_BLOCKS,
                        depth: SECTION_SIZE_BLOCKS,
                        minY: peer.terrain.minY,
                        height: peer.terrain.height
                    };
                    if (availabilityChecks >= this.settings.cached_requests_per_tick) return;
                    availabilityChecks++;
                    const prepared = peer.terrain.prepare?.(region);
                    if (prepared?.status === 'pending') return;
                    if (prepared && prepared.status !== 'ready') throw new Error(prepared.reason);
                    if (
                        !request.builder &&
                        this.captureRequestCount(request.name, request) >= this.settings.requests_per_player
                    ) {
                        request.cacheChecked = false;
                        return;
                    }
                    if (builderStepped || blocksBudget === 0) {
                        if (!request.builder && !request.cached) request.cacheChecked = false;
                        return;
                    }
                    builderStepped = true;
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
                    const reason = String(err);
                    this.log.debug(
                        `${logTag} DH request ${ansi.named.number(request.tracker)} for ${lodLocation(request.level, request.section.x, request.section.z)} failed: ${reason}.`
                    );
                    this.rejected++;
                    this.lastFailure = reason;
                    peer.send(
                        reject(
                            request.tracker,
                            'Terrain unavailable or changed; only loaded chunks and cached LODs can be served'
                        )
                    );
                    this.drop(request);
                }
            });
            if (!found) this.left(request.name);
        }
        if (!forcedWork && !builderStepped && blocksBudget > 0)
            builderStepped = this.refreshOne(peers, refreshesAtStart, blocksBudget);
        let remaining = this.settings.packets_per_tick;
        let cachedRemaining = this.settings.cached_packets_per_tick;
        const names = [...this.clients.keys()];
        let next = names.length === 0 ? 0 : this.sendCursor % names.length;
        let idleVisits = 0;
        while (names.length > 0 && (remaining > 0 || cachedRemaining > 0) && idleVisits < names.length) {
            const name = names[next] ?? '';
            next = (next + 1) % names.length;
            const client = this.clients.get(name);
            if (!client) {
                idleVisits++;
                continue;
            }
            let sent = false;
            const found = peers.withPeer(name, (peer) => {
                let responseIndex = -1;
                let response: QueuedPacket | undefined;
                let bytes: Uint8Array | undefined;
                const now = this.now();
                for (let index = 0; index < client.packets.length; index++) {
                    const candidate = client.packets[index];
                    if (!candidate || (candidate.cached ? cachedRemaining <= 0 : remaining <= 0)) continue;
                    const candidateBytes = candidate.cursor?.peek() ?? candidate.bytes;
                    if (!candidateBytes || !client.byteCredit.canSend(candidateBytes.length, now)) continue;
                    responseIndex = index;
                    response = candidate;
                    bytes = candidateBytes;
                    break;
                }
                if (responseIndex < 0 || !response || !bytes) return;
                peer.send(bytes);
                client.byteCredit.consume(bytes.length);
                this.dhPacketBytesSent += bytes.length;
                response.cursor?.advance();
                if (!response.cursor || response.cursor.done) {
                    client.packets.splice(responseIndex, 1);
                    this.served++;
                    const {
                        level,
                        section,
                        tracker,
                        packetCount,
                        dataBytes,
                        cached,
                        unchanged: noChange
                    } = response.lod;
                    const label = noChange ? 'unchanged LOD response' : cached ? 'cached LOD' : 'captured LOD';
                    this.log.debug(
                        `${logTag} Sent ${label} to ${ansi.named.name(peer.name)} for ${lodLocation(level, section.x, section.z)} (request ${ansi.named.number(tracker)}, ${ansi.named.number(packetCount)} packet(s), ${ansi.named.number(dataBytes)} bytes).`
                    );
                }
                if (response.cached) cachedRemaining--;
                else remaining--;
                sent = true;
            });
            if (!found) this.left(name);
            if (sent) {
                idleVisits = 0;
                this.sendCursor = next;
            } else idleVisits++;
        }
        this.lastHandlerMs = Math.max(0, this.measureNow() - handlerStarted);
    }
    /** Removes a disconnected client's work and queued transfers. */
    left(name: string): void {
        const client = this.clients.get(name);
        const pending = this.requests.filter((request) => request.name === name).length;
        const queued = client?.packets.length ?? 0;
        this.removeClient(name);
        if (client) {
            this.log.debug(
                `${logTag} Removed DH session for ${ansi.named.name(name)}; discarded ${ansi.named.number(pending)} pending request(s) and ${ansi.named.number(queued)} queued response(s).`
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
        // Running requests and background refreshes share revisions to prevent stale writes.
        if (this.requests.some((request) => request.key === key) || this.refreshes.has(key))
            this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
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
        let queuedPackets = 0;
        let queuedResponses = 0;
        let queuedBytes = 0;
        for (const client of this.clients.values()) {
            for (const response of client.packets) {
                queuedResponses++;
                queuedPackets += response.cursor?.remainingPackets ?? 1;
                queuedBytes += response.cursor?.retainedBytes ?? response.bytes?.length ?? 0;
            }
        }
        const budget = forced
            ? ` Forced budget up to ${FORCE_BLOCK_SAMPLES_PER_TICK} block samples/tick; ordinary capture sampling paused while cache delivery continues.`
            : ` Capture budget ${this.lastBlocksBudget}/${this.settings.blocks_per_tick} block samples/tick at ${this.lastServerMspt.toFixed(1)} reported MSPT.`;
        const lines = [
            `${this.clients.size} Distant Horizons client(s), ${this.requests.length} pending LOD request(s).`,
            `${this.ticks} worker tick(s), ${this.served} served, ${this.rejected} rejected, ${this.cancelled} cancelled.`,
            `${queuedPackets} queued packet(s) across ${queuedResponses} response(s); ${queuedBytes} logical queued response bytes retained.`,
            `${this.dhPacketBytesSent} DH packet bytes sent; ${this.refreshes.size} background cache refresh(es).`,
            `Last DH tick-end handler: ${this.lastHandlerMs} ms; Pumpkin MSPT excludes this handler on the pinned server.`
        ];
        if (progress) lines.push(progress.trim());
        if (forced) lines.push(forced);
        lines.push(budget.trim());
        if (this.lastFailure) lines.push(`Last rejection: ${this.lastFailure}.`);
        lines.push('Distant chunk generation is unavailable in the pinned Pumpkin API.');
        return lines.join('\n');
    }
    private scheduleRefresh(request: Request): void {
        if (this.refreshes.has(request.key) || this.refreshes.size >= this.settings.pending_requests) return;
        this.refreshes.set(request.key, {
            name: request.name,
            key: request.key,
            level: request.level,
            section: request.section,
            revision: request.revision
        });
    }
    private refreshOne(peers: Peers, candidates: Refresh[], blocksBudget: number): boolean {
        const refresh = candidates.find((candidate) => this.refreshes.get(candidate.key) === candidate);
        if (!refresh) return false;
        let stepped = false;
        const found = peers.withPeer(refresh.name, (peer) => {
            if (peer.level !== refresh.level || (this.revisions.get(refresh.key) ?? 0) !== refresh.revision) {
                this.finishRefresh(refresh);
                return;
            }
            try {
                const region = {
                    originX: refresh.section.x * SECTION_SIZE_BLOCKS,
                    originZ: refresh.section.z * SECTION_SIZE_BLOCKS,
                    width: SECTION_SIZE_BLOCKS,
                    depth: SECTION_SIZE_BLOCKS,
                    minY: peer.terrain.minY,
                    height: peer.terrain.height
                };
                const prepared = peer.terrain.prepare?.(region);
                if (prepared?.status === 'pending') {
                    this.refreshes.delete(refresh.key);
                    this.refreshes.set(refresh.key, refresh);
                    return;
                }
                if (prepared && prepared.status !== 'ready') throw new Error(prepared.reason);
                refresh.builder ??= new LodBuilder(refresh.section, peer.terrain.minY, peer.terrain.height);
                const measured = measureTerrainSource(peer.terrain);
                const started = this.measureNow();
                const complete = refresh.builder.step(measured.source, blocksBudget);
                stepped = true;
                this.workBudget.observe(measured.samples(), this.measureNow() - started);
                if (!complete) return;
                const stillLoaded = peer.terrain.prepare?.(region);
                if (stillLoaded?.status === 'pending') return;
                if (stillLoaded && stillLoaded.status !== 'ready') throw new Error(stillLoaded.reason);
                const captured = { updated: this.now(), data: refresh.builder.finish(this.now()) };
                this.cache.put(refresh.key, captured);
                this.log.debug(
                    `${logTag} Refreshed cached LOD for ${ansi.named.name(refresh.name)} at ${lodLocation(refresh.level, refresh.section.x, refresh.section.z)} (${ansi.named.number(captured.data.length)} bytes).`
                );
                this.finishRefresh(refresh);
            } catch (err) {
                this.log.debug(
                    `${logTag} Background refresh for ${lodLocation(refresh.level, refresh.section.x, refresh.section.z)} failed: ${String(err)}.`
                );
                this.finishRefresh(refresh);
            }
        });
        if (!found) this.finishRefresh(refresh);
        return stepped;
    }
    private finishRefresh(refresh: Refresh): void {
        if (this.refreshes.get(refresh.key) === refresh) this.refreshes.delete(refresh.key);
        this.clearRevisionIfUnused(refresh.key);
    }
    private clearRevisionIfUnused(key: string): void {
        if (!this.requests.some((request) => request.key === key) && !this.refreshes.has(key))
            this.revisions.delete(key);
    }
    private announce(peer: Peer): void {
        const existing = this.clients.get(peer.name);
        if (existing?.level === peer.level && existing.dimension === peer.dimension) {
            peer.send(levelInit(peer.dimension, this.settings.server_key, peer.level, this.now()));
            peer.send(sessionConfig(existing.config));
            return;
        }
        if (existing) {
            peer.send(closeSession('World changed; restarting the Distant Horizons session.'));
            this.removeClient(peer.name);
        }
        const config = this.serverConfiguration();
        this.clients.set(peer.name, {
            level: peer.level,
            dimension: peer.dimension,
            config,
            byteCredit: new ByteCredit(config.bandwidthKbps, this.now()),
            packets: []
        });
        peer.send(levelInit(peer.dimension, this.settings.server_key, peer.level, this.now()));
        peer.send(sessionConfig(config));
        this.log.debug(
            `${logTag} Established DH session with ${ansi.named.name(peer.name)} in ${ansi.named.identifier(peer.dimension)} / ${ansi.named.identifier(peer.level)} (generation distance ${ansi.named.number(config.generationDistance)} chunks at ${ansi.named.number(config.generationRate)}/s, sync distance ${ansi.named.number(config.syncDistance)} chunks at ${ansi.named.number(config.syncRate)}/s).`
        );
    }
    private complete(request: Request, value: CachedLod, cached = false): void {
        const client = this.clients.get(request.name);
        if (client) {
            const isUnchanged = request.timestamp !== undefined && value.updated <= request.timestamp;
            const cursor = isUnchanged ? undefined : new TransferCursor(request.tracker, this.buffer++, value.data);
            const lod = {
                level: request.level,
                section: request.section,
                tracker: request.tracker,
                packetCount: cursor?.packetCount ?? 1,
                dataBytes: value.data.length,
                cached,
                unchanged: isUnchanged,
                sync: request.timestamp !== undefined
            };
            client.packets.push({ bytes: isUnchanged ? unchanged(request.tracker) : undefined, cursor, cached, lod });
        }
        this.drop(request);
    }
    private drop(request: Request): void {
        const index = this.requests.indexOf(request);
        if (index >= 0) this.requests.splice(index, 1);
        this.clearRevisionIfUnused(request.key);
    }
    private cancelRequests(name: string): void {
        for (let i = this.requests.length - 1; i >= 0; i--) {
            if (this.requests[i]?.name === name) this.requests.splice(i, 1);
        }
        for (const [key, refresh] of this.refreshes) if (refresh.name === name) this.refreshes.delete(key);
        for (const key of this.revisions.keys()) this.clearRevisionIfUnused(key);
    }
    private rejectPendingRequestClass(peer: Peer, sync: boolean): void {
        for (let i = this.requests.length - 1; i >= 0; i--) {
            const request = this.requests[i];
            if (!request || request.name !== peer.name || (request.timestamp !== undefined) !== sync) continue;
            this.rejected++;
            this.lastFailure = 'LOD requests disabled by client';
            peer.send(reject(request.tracker, this.lastFailure, 2));
            this.drop(request);
        }
        for (const key of this.revisions.keys()) this.clearRevisionIfUnused(key);
    }
    private orderedRequests(): Request[] {
        const requests = [...this.requests];
        if (requests.length === 0) return requests;
        const offset = this.requestCursor % requests.length;
        this.requestCursor = (offset + 1) % requests.length;
        return [...requests.slice(offset), ...requests.slice(0, offset)];
    }
    private pendingWorkCount(): number {
        return (
            this.requests.length +
            [...this.clients.values()].reduce((count, client) => count + client.packets.length, 0)
        );
    }
    private captureRequestCount(name: string, except: Request): number {
        return this.requests.filter(
            (request) =>
                request !== except &&
                request.name === name &&
                (request.builder !== undefined || (request.cacheChecked === true && request.cached === null))
        ).length;
    }
    private serverConfiguration(): SessionConfiguration {
        return {
            generationPlan: 2,
            generationDistance: this.settings.render_distance,
            generationRate: Math.min(this.settings.generation_requests_per_second, this.settings.pending_requests),
            realTimeUpdates: false,
            realTimeDistance: 0,
            syncEnabled: true,
            syncDistance: this.settings.render_distance,
            syncRate: Math.min(this.settings.sync_requests_per_second, this.settings.pending_requests),
            bandwidthKbps: 0
        };
    }
    private negotiateConfiguration(request: SessionConfiguration): SessionConfiguration {
        const server = this.serverConfiguration();
        return {
            generationPlan: request.generationPlan,
            generationDistance: Math.min(request.generationDistance, server.generationDistance),
            generationRate: Math.min(request.generationRate, server.generationRate),
            realTimeUpdates: false,
            realTimeDistance: 0,
            syncEnabled: request.syncEnabled && server.syncEnabled,
            syncDistance: Math.min(request.syncDistance, server.syncDistance),
            syncRate: Math.min(request.syncRate, server.syncRate),
            bandwidthKbps: request.bandwidthKbps
        };
    }
    private validate(
        peer: Peer,
        client: Client,
        request: Extract<Message, { type: 'request' }>,
        capacity = true
    ): { reason: string; kind: number } | undefined {
        if (request.level !== peer.level || client.level !== peer.level) return { reason: 'Wrong world', kind: 2 };
        const sync = request.timestamp !== undefined;
        const enabled = sync ? client.config.syncEnabled : client.config.generationPlan !== 3;
        if (!enabled) return { reason: 'LOD requests disabled by client', kind: 2 };
        if (request.section.detail !== SECTION_DETAIL) return { reason: 'Request block-detail sections', kind: 3 };
        const x = request.section.x * SECTION_SIZE_BLOCKS,
            z = request.section.z * SECTION_SIZE_BLOCKS,
            playerX = Math.floor(peer.x),
            playerZ = Math.floor(peer.z),
            distance = sync ? client.config.syncDistance : client.config.generationDistance,
            rate = sync ? client.config.syncRate : client.config.generationRate,
            range = distance * CHUNK_SIZE_BLOCKS,
            signedEdgeDistance =
                Math.max(
                    Math.abs(x + SECTION_SIZE_BLOCKS / 2 - playerX),
                    Math.abs(z + SECTION_SIZE_BLOCKS / 2 - playerZ)
                ) -
                SECTION_SIZE_BLOCKS / 2;
        if (
            signedEdgeDistance > range ||
            !peer.insideBorder(x, z) ||
            !peer.insideBorder(x + SECTION_SIZE_BLOCKS - 1, z + SECTION_SIZE_BLOCKS - 1)
        )
            return { reason: 'Section outside request range or world border', kind: 1 };
        // Wire rates shape client demand; this queue is the server's combined backpressure bound.
        if (capacity && (rate === 0 || this.pendingWorkCount() >= this.settings.pending_requests))
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
