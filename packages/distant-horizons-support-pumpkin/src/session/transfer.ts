import { ansi } from '@pumpkin-plugins/minecraft-colors';
import { TransferCursor } from '../flow/transfer-cursor.ts';
import type { CachedLod } from '../lod/cache.ts';
import { lodLocation } from '../lod/location.ts';
import { unchanged } from '../protocol/messages.ts';
import type { Peers } from './peer.ts';
import type { Client, QueuedPacket, Request, SessionState } from './state.ts';

/** Queues the response to a finished request: an unchanged notice, or the LOD as paced packets. */
export function queueResponse(
    state: SessionState,
    client: Client,
    request: Request,
    value: CachedLod,
    cached: boolean,
): void {
    const isUnchanged = request.timestamp !== undefined && value.updated <= request.timestamp;
    const cursor = isUnchanged
        ? undefined
        : new TransferCursor(request.tracker, state.buffer++, value.data, client.config.bandwidthKbps);
    const lod = {
        level: request.level,
        section: request.section,
        tracker: request.tracker,
        packetCount: cursor?.packetCount ?? 1,
        dataBytes: value.data.length,
        cached,
        unchanged: isUnchanged,
        sync: request.timestamp !== undefined,
    };
    client.packets.push({ bytes: isUnchanged ? unchanged(request.tracker) : undefined, cursor, cached, lod });
}

/** Applies a newly negotiated bandwidth limit to the client's byte credit and queued transfers. */
export function setBandwidth(state: SessionState, client: Client, bandwidthKbps: number): void {
    client.byteCredit.setRate(bandwidthKbps, state.now());
    for (const response of client.packets) response.cursor?.setBandwidthRate(bandwidthKbps);
    client.activeTransfer ??= client.packets.find((response) => response.cursor?.hasInFlightBuffer);
}

/** Removes the queued response for a request tracker and returns it, if one was queued. */
export function cancelQueuedResponse(client: Client, tracker: number): QueuedPacket | undefined {
    const responseIndex = client.packets.findIndex((response) => response.lod.tracker === tracker);
    const response = client.packets[responseIndex];
    if (responseIndex < 0 || !response) return undefined;
    if (client.activeTransfer === response) client.activeTransfer = undefined;
    client.packets.splice(responseIndex, 1);
    return response;
}

/**
 * Sends queued packets to clients in rotating order within the per-tick packet limits and each
 * client's byte credit, finishing a client's in-flight transfer before it starts another.
 */
export function sendQueuedPackets(state: SessionState, peers: Peers): void {
    let remaining = state.settings.packets_per_tick;
    let cachedRemaining = state.settings.cached_packets_per_tick;
    const names = [...state.clients.keys()];
    let next = names.length === 0 ? 0 : state.sendCursor % names.length;
    let idleVisits = 0;
    while (names.length > 0 && (remaining > 0 || cachedRemaining > 0) && idleVisits < names.length) {
        const name = names[next] ?? '';
        next = (next + 1) % names.length;
        const client = state.clients.get(name);
        if (!client) {
            idleVisits++;
            continue;
        }
        let sent = false;
        state.withSessionPeer(peers, name, (peer) => {
            let responseIndex = -1;
            let response: QueuedPacket | undefined;
            let bytes: Uint8Array | undefined;
            const now = state.now();
            if (client.activeTransfer && !client.packets.includes(client.activeTransfer)) {
                client.activeTransfer = undefined;
            }
            const candidates = client.activeTransfer ? [client.activeTransfer] : client.packets;
            for (const candidate of candidates) {
                if (!candidate || (candidate.cached ? cachedRemaining <= 0 : remaining <= 0)) continue;
                const candidateBytes = candidate.cursor?.peek() ?? candidate.bytes;
                if (!candidateBytes || !client.byteCredit.canSend(candidateBytes.length, now)) continue;
                responseIndex = client.packets.indexOf(candidate);
                response = candidate;
                bytes = candidateBytes;
                break;
            }
            if (responseIndex < 0 || !response || !bytes) return;
            peer.send(bytes);
            client.byteCredit.consume(bytes.length);
            state.dhPacketBytesSent += bytes.length;
            response.cursor?.advance();
            if (response.cursor?.hasInFlightBuffer) client.activeTransfer = response;
            else if (client.activeTransfer === response) client.activeTransfer = undefined;
            if (!response.cursor || response.cursor.done) {
                client.packets.splice(responseIndex, 1);
                state.served++;
                const {
                    level,
                    section,
                    tracker,
                    packetCount: originalPacketCount,
                    dataBytes,
                    cached,
                    unchanged: noChange,
                } = response.lod;
                const packetCount = response.cursor?.packetCount ?? originalPacketCount;
                const label = noChange ? 'unchanged LOD response' : cached ? 'cached LOD' : 'captured LOD';
                state.log.debug(
                    `Sent ${label} to ${ansi.named.name(peer.name)} for ${lodLocation(level, section.x, section.z)} (request ${ansi.named.number(tracker)}, ${ansi.named.number(packetCount)} packet(s), ${ansi.named.number(dataBytes)} bytes).`,
                );
            }
            if (response.cached) cachedRemaining--;
            else remaining--;
            sent = true;
        });
        if (sent) {
            idleVisits = 0;
            state.sendCursor = next;
        } else idleVisits++;
    }
}
