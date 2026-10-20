import { FORCE_BLOCK_SAMPLES_PER_TICK } from '../lod/force-generation.ts';
import type { Request, SessionState } from './state.ts';

/** Scalar live-session values for placeholder callbacks, excluding client queues and identities. */
export interface SessionPlaceholderSnapshot {
    readonly cacheRefreshes: number;
    readonly cancelled: number;
    readonly clients: number;
    readonly packetBytesSent: number;
    readonly pendingRequests: number;
    readonly rejected: number;
    readonly served: number;
    readonly workerTicks: number;
}

/** Returns scalar live counters without traversing per-client packet queues. */
export function sessionSnapshot(state: SessionState): SessionPlaceholderSnapshot {
    return Object.freeze({
        clients: state.clients.size,
        pendingRequests: state.requests.length,
        workerTicks: state.ticks,
        served: state.served,
        rejected: state.rejected,
        cancelled: state.cancelled,
        packetBytesSent: state.dhPacketBytesSent,
        cacheRefreshes: state.refreshes.size,
    });
}

/**
 * Describes current queues for the operator command.
 *
 * @param forced - Status of the running operator capture, if any.
 */
export function describeStatus(state: SessionState, forced: string | undefined): string {
    // Requests are served in rotating order, so show the capture closest to finishing.
    let request: Request | undefined;
    for (const candidate of state.requests) {
        if ((candidate.builder?.progress() ?? -1) > (request?.builder?.progress() ?? -1)) request = candidate;
    }
    const progress = request?.builder
        ? forced
            ? ` Paused DH capture ${request.level} ${request.section.x}, ${request.section.z}: ${(request.builder.progress() * 100).toFixed(1)}%.`
            : ` Capturing ${request.level} ${request.section.x}, ${request.section.z}: ${(request.builder.progress() * 100).toFixed(1)}%.`
        : '';
    let queuedPackets = 0;
    let queuedResponses = 0;
    let queuedBytes = 0;
    for (const client of state.clients.values()) {
        for (const response of client.packets) {
            queuedResponses++;
            queuedPackets += response.cursor?.remainingPackets ?? 1;
            queuedBytes += response.cursor?.retainedBytes ?? response.bytes?.length ?? 0;
        }
    }
    const budget = forced
        ? ` Forced budget up to ${FORCE_BLOCK_SAMPLES_PER_TICK} block samples/tick; ordinary capture sampling paused while cache delivery continues.`
        : ` Capture budget ${state.lastBlocksBudget}/${state.settings.blocks_per_tick} block samples/tick at ${state.lastServerMspt.toFixed(1)} reported MSPT.`;
    const lines = [
        `${state.clients.size} Distant Horizons client(s), ${state.requests.length} pending LOD request(s).`,
        `${state.ticks} worker tick(s), ${state.served} served, ${state.rejected} rejected, ${state.cancelled} cancelled.`,
        `${queuedPackets} queued packet(s) across ${queuedResponses} response(s); ${queuedBytes} logical queued response bytes retained.`,
        `${state.dhPacketBytesSent} DH packet bytes sent; ${state.refreshes.size} background cache refresh(es).`,
        `Last DH tick-end handler: ${state.lastHandlerMs.toFixed(2)} ms; Pumpkin MSPT excludes this handler on the pinned server.`,
    ];
    if (progress) lines.push(progress.trim());
    if (forced) lines.push(forced);
    lines.push(budget.trim());
    if (state.lastFailure) lines.push(`Last rejection: ${state.lastFailure}.`);
    lines.push('Distant chunk generation is unavailable in the pinned Pumpkin API.');
    return lines.join('\n');
}
