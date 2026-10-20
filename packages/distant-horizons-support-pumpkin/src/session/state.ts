import { ansi } from '@pumpkin-plugins/minecraft-colors';
import type { Logger } from '@pumpkin-plugins/plugin-kit/logger';
import { AdaptiveWorkBudget } from '@pumpkin-plugins/terrain';
import type { Settings } from '../config/schema.ts';
import type { ByteCredit } from '../flow/byte-credit.ts';
import type { TransferCursor } from '../flow/transfer-cursor.ts';
import type { LodBuilder } from '../lod/builder.ts';
import type { CachedLod, LodCache } from '../lod/cache.ts';
import type { Section, SessionConfiguration } from '../protocol/messages.ts';
import type { Peer, Peers } from './peer.ts';

/** One player's negotiated DH session and its queue of outgoing responses. */
export interface Client {
    activeTransfer?: QueuedPacket;
    byteCredit: ByteCredit;
    config: SessionConfiguration;
    dimension: string;
    level: string;
    packets: QueuedPacket[];
}
/** A response waiting to be sent, with the LOD details its log line reports. */
export interface QueuedPacket {
    bytes?: Uint8Array;
    cached: boolean;
    cursor?: TransferCursor;
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
/** A pending LOD request from one player, with its cache check and capture progress. */
export interface Request {
    builder?: LodBuilder;
    cacheChecked?: boolean;
    cached?: CachedLod | null;
    key: string;
    level: string;
    name: string;
    revision: number;
    section: Section;
    timestamp?: number;
    tracker: number;
}
/** Backoff for a section whose terrain was not ready to sample. */
export interface TerrainRetry {
    attempts: number;
    retryAt: number;
    updatedAt: number;
}
/** A background rebuild of a stale cached section. */
export interface Refresh {
    builder?: LodBuilder;
    key: string;
    level: string;
    name: string;
    revision: number;
    section: Section;
}

/**
 * Client sessions, request queues and counters shared by the session modules, with the bookkeeping
 * that keeps them consistent. Each `Sessions` owns one instance.
 */
export class SessionState {
    readonly clients = new Map<string, Client>();
    readonly requests: Request[] = [];
    readonly terrainRetries = new Map<string, TerrainRetry>();
    readonly refreshes = new Map<string, Refresh>();
    readonly revisions = new Map<string, number>();
    readonly protocolWarnings = new Set<string>();
    readonly heightWarnings = new Set<string>();
    readonly workBudget = new AdaptiveWorkBudget({ initialUnits: 8192 });
    buffer = 1;
    sendCursor = 0;
    requestCursor = 0;
    ticks = 0;
    served = 0;
    rejected = 0;
    cancelled = 0;
    dhPacketBytesSent = 0;
    lastHandlerMs = 0;
    lastFailure = '';
    lastBlocksBudget = 0;
    lastServerMspt = 0;
    constructor(
        readonly settings: Settings,
        readonly cache: LodCache,
        readonly log: Logger,
        readonly now: () => number,
        readonly measureNow: () => number,
    ) {}
    /** Ends a player's DH protocol session and drops its requests and queued responses. */
    endSession(name: string): void {
        const client = this.clients.get(name);
        const pending = this.requests.filter((request) => request.name === name).length;
        const queued = client?.packets.length ?? 0;
        this.removeClient(name);
        if (client) {
            this.log.debug(
                `Removed DH session for ${ansi.named.name(name)}; discarded ${ansi.named.number(pending)} pending request(s) and ${ansi.named.number(queued)} queued response(s).`,
            );
        }
    }
    /** Runs work for one session player, ending only that session when the player is gone or the work fails. */
    withSessionPeer(peers: Peers, name: string, use: (peer: Peer) => void): void {
        let found = false;
        try {
            found = peers.withPeer(name, use);
        } catch (err) {
            this.log.warn(`Ended DH session for ${ansi.named.name(name)} after an error: ${String(err)}.`);
        }
        if (!found) this.endSession(name);
    }
    /** Forgets a player's session, pending requests and background refreshes, without logging. */
    removeClient(name: string): void {
        this.clients.delete(name);
        this.cancelRequests(name);
    }
    /** Removes a finished, rejected or cancelled request from the queue. */
    drop(request: Request): void {
        const index = this.requests.indexOf(request);
        if (index >= 0) this.requests.splice(index, 1);
        this.clearRevisionIfUnused(request.key);
    }
    /** Forgets a section's change revision once no request or refresh still tracks it. */
    clearRevisionIfUnused(key: string): void {
        if (!this.requests.some((request) => request.key === key) && !this.refreshes.has(key))
            this.revisions.delete(key);
    }
    private cancelRequests(name: string): void {
        for (let i = this.requests.length - 1; i >= 0; i--) {
            if (this.requests[i]?.name === name) this.requests.splice(i, 1);
        }
        for (const [key, refresh] of this.refreshes) if (refresh.name === name) this.refreshes.delete(key);
        for (const key of this.revisions.keys()) this.clearRevisionIfUnused(key);
    }
}
