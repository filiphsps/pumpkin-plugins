import { ansi } from '@pumpkin-plugins/minecraft-colors';
import { LodBuilder } from '../lod/builder.ts';
import { sectionRegion } from '../lod/generation.ts';
import { lodLocation } from '../lod/location.ts';
import type { Peers } from './peer.ts';
import type { Refresh, Request, SessionState } from './state.ts';

/** Queues a background rebuild of a stale cached section unless one is queued or the queue is full. */
export function scheduleRefresh(state: SessionState, request: Request): void {
    if (state.refreshes.has(request.key) || state.refreshes.size >= state.settings.pending_requests) return;
    state.refreshes.set(request.key, {
        name: request.name,
        key: request.key,
        level: request.level,
        section: request.section,
        revision: request.revision,
    });
}

/**
 * Advances the first refresh from the tick's starting list that is still queued, by one builder step
 * within the block budget, and caches the result once its terrain is still loaded.
 *
 * @param candidates - Refreshes queued when the tick started, in queue order.
 * @returns Whether a builder sampled terrain.
 */
export function refreshOne(state: SessionState, peers: Peers, candidates: Refresh[], blocksBudget: number): boolean {
    const refresh = candidates.find((candidate) => state.refreshes.get(candidate.key) === candidate);
    if (!refresh) return false;
    let stepped = false;
    let found = false;
    try {
        found = peers.withPeer(refresh.name, (peer) => {
            if (peer.level !== refresh.level || (state.revisions.get(refresh.key) ?? 0) !== refresh.revision) {
                finishRefresh(state, refresh);
                return;
            }
            try {
                const region = sectionRegion(refresh.section, peer.terrain);
                const prepared = peer.terrain.prepare?.(region);
                if (prepared?.status === 'pending') {
                    state.refreshes.delete(refresh.key);
                    state.refreshes.set(refresh.key, refresh);
                    return;
                }
                if (prepared && prepared.status !== 'ready') throw new Error(prepared.reason);
                refresh.builder ??= new LodBuilder(refresh.section, peer.terrain.minY, peer.terrain.height);
                const sampledBefore = refresh.builder.samples();
                const started = state.measureNow();
                const complete = refresh.builder.step(peer.terrain, blocksBudget);
                stepped = true;
                state.workBudget.observe(refresh.builder.samples() - sampledBefore, state.measureNow() - started);
                if (!complete) return;
                const stillLoaded = peer.terrain.prepare?.(region);
                if (stillLoaded?.status === 'pending') return;
                if (stillLoaded && stillLoaded.status !== 'ready') throw new Error(stillLoaded.reason);
                const captured = { updated: state.now(), data: refresh.builder.finish(state.now()) };
                state.cache.put(refresh.key, captured);
                state.log.debug(
                    `Refreshed cached LOD for ${ansi.named.name(refresh.name)} at ${lodLocation(refresh.level, refresh.section.x, refresh.section.z)} (${ansi.named.number(captured.data.length)} bytes).`,
                );
                finishRefresh(state, refresh);
            } catch (err) {
                state.log.debug(
                    `Background refresh for ${lodLocation(refresh.level, refresh.section.x, refresh.section.z)} failed: ${String(err)}.`,
                );
                finishRefresh(state, refresh);
            }
        });
    } catch (err) {
        state.log.debug(
            `Background refresh for ${lodLocation(refresh.level, refresh.section.x, refresh.section.z)} failed: ${String(err)}.`,
        );
    }
    if (!found) finishRefresh(state, refresh);
    return stepped;
}

function finishRefresh(state: SessionState, refresh: Refresh): void {
    if (state.refreshes.get(refresh.key) === refresh) state.refreshes.delete(refresh.key);
    state.clearRevisionIfUnused(refresh.key);
}
