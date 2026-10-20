import { ansi } from '@pumpkin-plugins/minecraft-colors';
import { LodBuilder } from '../lod/builder.ts';
import type { CachedLod } from '../lod/cache.ts';
import { sectionRegion } from '../lod/generation.ts';
import { lodLocation } from '../lod/location.ts';
import { reject } from '../protocol/messages.ts';
import type { Peers } from './peer.ts';
import { validate } from './protocol.ts';
import { scheduleRefresh } from './refresh.ts';
import type { Request, SessionState } from './state.ts';
import { queueResponse } from './transfer.ts';

const INITIAL_TERRAIN_RETRY_MS = 1000;
const MAX_TERRAIN_RETRY_MS = 30_000;
const TERRAIN_RETRY_RETENTION_MS = 60_000;

/** Forgets terrain backoff for sections that no queued request needs once it is a minute old. */
export function pruneTerrainRetries(state: SessionState): void {
    const now = state.now();
    const activeKeys = new Set(state.requests.map((request) => request.key));
    for (const [key, retry] of state.terrainRetries) {
        if (!activeKeys.has(key) && now - retry.updatedAt >= TERRAIN_RETRY_RETENTION_MS)
            state.terrainRetries.delete(key);
    }
}

/**
 * Advances queued LOD requests in rotating order: rejects requests that are no longer valid, answers
 * from the cache (scheduling a background refresh for a stale entry), backs off from terrain that is
 * not ready and steps at most one capture builder. `cached_requests_per_tick` bounds the cache and
 * terrain checks. A request waits while another request captures its section, and a finished capture
 * answers every request queued for that section.
 *
 * @param blocksBudget - Block samples the builder may take this tick; 0 pauses capture sampling.
 * @returns Whether a builder sampled terrain.
 */
export function stepRequests(state: SessionState, peers: Peers, blocksBudget: number): boolean {
    let cacheChecks = 0;
    let availabilityChecks = 0;
    let builderStepped = false;
    const captures = state.requests.filter((request) => request.builder);
    for (const request of orderedRequests(state)) {
        if (!state.requests.includes(request)) continue;
        const queuedClient = state.clients.get(request.name);
        if (!queuedClient) continue;
        state.withSessionPeer(peers, request.name, (peer) => {
            try {
                const client = state.clients.get(peer.name);
                if (!client) return;
                const failure = validate(state, peer, client, { ...request, type: 'request' }, false);
                if (failure) {
                    state.rejected++;
                    state.lastFailure = failure.reason;
                    state.log.debug(
                        `Rejected DH request ${ansi.named.number(request.tracker)} from ${ansi.named.name(peer.name)} for ${lodLocation(request.level, request.section.x, request.section.z)}: ${failure.reason}.`,
                    );
                    peer.send(reject(request.tracker, failure.reason, failure.kind));
                    state.drop(request);
                    return;
                }
                const revision = state.revisions.get(request.key) ?? 0;
                if (revision !== request.revision) {
                    // A block changed in this section; start again from current terrain.
                    request.builder = undefined;
                    request.cacheChecked = false;
                    request.cached = undefined;
                    request.revision = revision;
                }
                if (!request.builder) {
                    if (waitsForCapture(state, captures, request)) return;
                    if (!request.cacheChecked) {
                        if (cacheChecks >= state.settings.cached_requests_per_tick) return;
                        request.cached = state.cache.get(request.key) ?? null;
                        request.cacheChecked = true;
                        cacheChecks++;
                        state.log.debug(
                            `LOD cache ${request.cached ? 'hit' : 'miss'} for ${ansi.named.name(request.name)} at ${lodLocation(request.level, request.section.x, request.section.z)}.`,
                        );
                    }
                    const cached = request.cached ?? undefined;
                    if (cached) {
                        const clientHasNewerData =
                            request.timestamp !== undefined && cached.updated <= request.timestamp;
                        const fresh = state.now() - cached.updated < state.settings.refresh_seconds * 1000;
                        if (clientHasNewerData || fresh) {
                            completeRequest(state, request, cached, true);
                            return;
                        }
                        scheduleRefresh(state, request);
                        completeRequest(state, request, cached, true);
                        return;
                    }
                }
                const region = sectionRegion(request.section, peer.terrain);
                const retry = state.terrainRetries.get(request.key);
                if (retry && state.now() < retry.retryAt) return;
                if (availabilityChecks >= state.settings.cached_requests_per_tick) return;
                availabilityChecks++;
                let prepared: ReturnType<NonNullable<typeof peer.terrain.prepare>> | undefined;
                try {
                    prepared = peer.terrain.prepare?.(region);
                } catch (err) {
                    deferTerrain(state, request, String(err));
                    return;
                }
                if (prepared && prepared.status !== 'ready') {
                    deferTerrain(
                        state,
                        request,
                        prepared.status === 'unavailable' ? prepared.reason : 'Terrain preparation is pending',
                    );
                    return;
                }
                state.terrainRetries.delete(request.key);
                if (
                    !request.builder &&
                    captureRequestCount(state, request.name, request) >= state.settings.requests_per_player
                ) {
                    request.cacheChecked = false;
                    return;
                }
                if (builderStepped || blocksBudget === 0) {
                    if (!request.builder && !request.cached) request.cacheChecked = false;
                    return;
                }
                builderStepped = true;
                if (!request.builder) {
                    request.builder = new LodBuilder(request.section, peer.terrain.minY, peer.terrain.height);
                    captures.push(request);
                }
                const sampledBefore = request.builder.samples();
                const started = state.measureNow();
                const complete = request.builder.step(peer.terrain, blocksBudget);
                // Charge only sampling to the cost estimate, not the terrain recheck or cache write.
                state.workBudget.observe(request.builder.samples() - sampledBefore, state.measureNow() - started);
                if (complete) {
                    let stillLoaded: ReturnType<NonNullable<typeof peer.terrain.prepare>> | undefined;
                    try {
                        stillLoaded = peer.terrain.prepare?.(region);
                    } catch (err) {
                        deferTerrain(state, request, String(err));
                        return;
                    }
                    if (stillLoaded && stillLoaded.status !== 'ready') {
                        deferTerrain(
                            state,
                            request,
                            stillLoaded.status === 'unavailable'
                                ? stillLoaded.reason
                                : 'Terrain preparation is pending',
                        );
                        return;
                    }
                    const captured = { updated: state.now(), data: request.builder.finish(state.now()) };
                    state.cache.put(request.key, captured);
                    state.log.debug(
                        `Captured LOD for ${ansi.named.name(request.name)} at ${lodLocation(request.level, request.section.x, request.section.z)} (${ansi.named.number(captured.data.length)} bytes).`,
                    );
                    for (const answered of state.requests.filter((other) => other.key === request.key))
                        completeRequest(state, answered, captured);
                }
            } catch (err) {
                const reason = String(err);
                state.log.debug(
                    `DH request ${ansi.named.number(request.tracker)} for ${lodLocation(request.level, request.section.x, request.section.z)} failed: ${reason}.`,
                );
                state.rejected++;
                state.lastFailure = reason;
                peer.send(
                    reject(
                        request.tracker,
                        'Terrain unavailable or changed; only loaded chunks and cached LODs can be served',
                    ),
                );
                state.drop(request);
            }
        });
    }
    return builderStepped;
}

function completeRequest(state: SessionState, request: Request, value: CachedLod, cached = false): void {
    state.terrainRetries.delete(request.key);
    const client = state.clients.get(request.name);
    if (client) queueResponse(state, client, request, value, cached);
    state.drop(request);
}

function deferTerrain(state: SessionState, request: Request, reason: string): void {
    const now = state.now();
    const previous = state.terrainRetries.get(request.key);
    const attempts = Math.min((previous?.attempts ?? 0) + 1, 32);
    const delay = Math.min(INITIAL_TERRAIN_RETRY_MS * 2 ** Math.min(attempts - 1, 10), MAX_TERRAIN_RETRY_MS);
    request.builder = undefined;
    state.terrainRetries.delete(request.key);
    state.terrainRetries.set(request.key, { attempts, retryAt: now + delay, updatedAt: now });
    const maximumEntries = Math.max(64, state.settings.pending_requests * 4);
    while (state.terrainRetries.size > maximumEntries) {
        const oldestKey = state.terrainRetries.keys().next().value;
        if (oldestKey === undefined) break;
        state.terrainRetries.delete(oldestKey);
    }
    state.log.debug(
        `Deferred DH request ${ansi.named.number(request.tracker)} from ${ansi.named.name(request.name)} for ${lodLocation(request.level, request.section.x, request.section.z)}: ${reason}; retrying in ${ansi.named.number(delay)} ms.`,
    );
}

/** Whether another queued request is capturing this request's section; that capture answers both. */
function waitsForCapture(state: SessionState, captures: readonly Request[], request: Request): boolean {
    return captures.some(
        (capture) =>
            capture !== request &&
            capture.key === request.key &&
            capture.builder !== undefined &&
            state.requests.includes(capture),
    );
}

function orderedRequests(state: SessionState): Request[] {
    const requests = [...state.requests];
    if (requests.length === 0) return requests;
    const offset = state.requestCursor % requests.length;
    state.requestCursor = (offset + 1) % requests.length;
    return [...requests.slice(offset), ...requests.slice(0, offset)];
}

function captureRequestCount(state: SessionState, name: string, except: Request): number {
    return state.requests.filter(
        (request) =>
            request !== except &&
            request.name === name &&
            (request.builder !== undefined || (request.cacheChecked === true && request.cached === null)),
    ).length;
}
