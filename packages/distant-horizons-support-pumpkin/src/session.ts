import type { Logger } from '@pumpkin-plugins/plugin-kit/logger';
import type { Settings } from './config/schema.ts';
import type { LodCache } from './lod/cache.ts';
import {
    ForcedLodGeneration,
    type ForcedLodPeer,
    type ForcedLodRecovery,
    type ForcedLodStart,
} from './lod/force-generation.ts';
import { sectionKey } from './lod/generation.ts';
import { SECTION_SIZE_BLOCKS } from './protocol/constants.ts';
import { pruneTerrainRetries, stepRequests } from './session/capture.ts';
import type { Peer, Peers } from './session/peer.ts';
import { announce, receiveMessage } from './session/protocol.ts';
import { refreshOne } from './session/refresh.ts';
import { SessionState } from './session/state.ts';
import { describeStatus, type SessionPlaceholderSnapshot, sessionSnapshot } from './session/status.ts';
import { sendQueuedPackets } from './session/transfer.ts';

export type { Peer, Peers, PlayerTerrain } from './session/peer.ts';
export type { SessionPlaceholderSnapshot } from './session/status.ts';

/** Runs bounded LOD work, keeping client state separate from short-lived Pumpkin handles. */
export class Sessions {
    private readonly state: SessionState;
    private readonly forcedGeneration: ForcedLodGeneration;
    constructor(settings: Settings, cache: LodCache, log: Logger, now = Date.now, measureNow = Date.now) {
        this.state = new SessionState(settings, cache, log, now, measureNow);
        this.forcedGeneration = new ForcedLodGeneration(cache, log, now, measureNow);
    }
    /** Starts a cache-refreshing capture that takes priority over ordinary DH work. */
    forceGenerate(peer: ForcedLodPeer, blockX: number, blockZ: number, radius = 0): ForcedLodStart {
        return this.forcedGeneration.start(peer, blockX, blockZ, radius);
    }
    /** Backs up and rebuilds one explicitly selected cached section from loaded terrain. */
    forceRecover(peer: ForcedLodPeer, blockX: number, blockZ: number): ForcedLodRecovery {
        return this.forcedGeneration.recover(peer, blockX, blockZ);
    }
    /** Returns scalar live counters without traversing per-client packet queues. */
    placeholderSnapshot(): SessionPlaceholderSnapshot {
        return sessionSnapshot(this.state);
    }
    /** Checks whether an exact current player name has an active DH session. */
    hasClient(name: string): boolean {
        return this.state.clients.has(name);
    }
    /** Accepts and validates a DH packet from a Java player. */
    receive(peer: Peer, bytes: Uint8Array): void {
        receiveMessage(this.state, peer, bytes);
    }
    /** Advances sampling and transfers within global per-tick budgets. */
    tick(peers: Peers, serverMspt = 0): void {
        const handlerStarted = this.state.measureNow();
        this.state.ticks++;
        pruneTerrainRetries(this.state);
        const refreshesAtStart = [...this.state.refreshes.values()];
        for (const [name, client] of this.state.clients) {
            this.state.withSessionPeer(peers, name, (peer) => {
                if (peer.level !== client.level || peer.dimension !== client.dimension) announce(this.state, peer);
            });
        }
        const forcedWork = this.forcedGeneration.tick(
            { withPeer: (name, use) => peers.withTerrain(name, use) },
            serverMspt,
        );
        if (forcedWork) {
            this.state.lastBlocksBudget = 0;
            this.state.lastServerMspt = serverMspt;
        }
        const blocksBudget = forcedWork
            ? 0
            : this.state.workBudget.next(serverMspt, this.state.settings.blocks_per_tick);
        this.state.lastBlocksBudget = blocksBudget;
        if (!forcedWork) this.state.lastServerMspt = serverMspt;
        const builderStepped = stepRequests(this.state, peers, blocksBudget);
        if (!forcedWork && !builderStepped && blocksBudget > 0)
            refreshOne(this.state, peers, refreshesAtStart, blocksBudget);
        sendQueuedPackets(this.state, peers);
        this.state.lastHandlerMs = Math.max(0, this.state.measureNow() - handlerStarted);
    }
    /** Ends a player's DH protocol session and drops its requests and queued responses; operator captures continue. */
    endSession(name: string): void {
        this.state.endSession(name);
    }
    /** Removes a leaving player and cancels their operator capture. */
    playerLeft(name: string): void {
        this.forcedGeneration.left(name);
        this.state.protocolWarnings.delete(name);
        this.state.removeClient(name);
    }
    /** Invalidates a known changed section so pending captures of it start again. */
    changed(level: string, x: number, z: number): void {
        const key = sectionKey(level, Math.floor(x / SECTION_SIZE_BLOCKS), Math.floor(z / SECTION_SIZE_BLOCKS));
        this.state.cache.remove(key);
        this.forcedGeneration.changed(level, x, z);
        // Running requests and background refreshes share revisions to prevent stale writes.
        if (this.state.requests.some((request) => request.key === key) || this.state.refreshes.has(key))
            this.state.revisions.set(key, (this.state.revisions.get(key) ?? 0) + 1);
    }
    /** Invalidates each affected LOD section once for a bulk world mutation. */
    changedMany(level: string, positions: readonly { x: number; z: number }[]): void {
        const changedSections = new Set<string>();
        for (const position of positions) {
            const key = sectionKey(
                level,
                Math.floor(position.x / SECTION_SIZE_BLOCKS),
                Math.floor(position.z / SECTION_SIZE_BLOCKS),
            );
            if (changedSections.has(key)) continue;
            changedSections.add(key);
            this.changed(level, position.x, position.z);
        }
    }
    /** Describes current queues for the operator command. */
    status(): string {
        return describeStatus(this.state, this.forcedGeneration.status());
    }
}

export { sectionKey } from './lod/generation.ts';
