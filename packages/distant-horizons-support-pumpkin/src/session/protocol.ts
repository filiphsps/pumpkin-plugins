import { ansi } from '@pumpkin-plugins/minecraft-colors';
import { ByteCredit } from '../flow/byte-credit.ts';
import { sectionKey } from '../lod/generation.ts';
import { lodLocation } from '../lod/location.ts';
import { PLUGIN_NAME } from '../name.ts';
import { CHUNK_SIZE_BLOCKS, SECTION_DETAIL, SECTION_SIZE_BLOCKS } from '../protocol/constants.ts';
import {
    closeSession,
    DH_VERSION,
    decode,
    levelInit,
    type Message,
    PROTOCOL,
    reject,
    type SessionConfiguration,
    sessionConfig,
} from '../protocol/messages.ts';
import type { Peer } from './peer.ts';
import type { Client, SessionState } from './state.ts';
import { cancelQueuedResponse, setBandwidth } from './transfer.ts';

/**
 * Decodes one DH message from a Java player and applies it. A malformed packet or another protocol
 * version closes the session; otherwise it starts, configures or closes the session, cancels a
 * request or queued response, or queues a validated LOD request.
 */
export function receiveMessage(state: SessionState, peer: Peer, bytes: Uint8Array): void {
    let message: Message;
    try {
        message = decode(bytes);
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const clientProtocol = bytes.length >= 2 ? (bytes[0] ?? 0) * 256 + (bytes[1] ?? 0) : PROTOCOL;
        if (clientProtocol !== PROTOCOL) {
            if (!state.protocolWarnings.has(peer.name)) {
                state.protocolWarnings.add(peer.name);
                state.log.warn(
                    `${ansi.named.name(peer.name)} uses DH protocol ${ansi.named.number(clientProtocol)}, but this plugin supports protocol ${ansi.named.number(PROTOCOL)} (Distant Horizons ${ansi.named.version(DH_VERSION)}); closed the DH session.`,
                );
            }
        } else {
            state.log.debug(`Closed DH session for ${ansi.named.name(peer.name)} after malformed message: ${reason}.`);
        }
        peer.send(closeSession(`${PLUGIN_NAME}: ${reason}`));
        state.endSession(peer.name);
        return;
    }
    if (message.type === 'close') {
        state.endSession(peer.name);
        return;
    }
    if (message.type === 'init') {
        if (message.dimension !== peer.dimension) {
            state.log.debug('Ignored DH initialization for a dimension other than the current player dimension.');
            return;
        }
        announce(state, peer);
        return;
    }
    const client = state.clients.get(peer.name);
    if (!client) return;
    if (message.type === 'config') {
        const config = negotiateConfiguration(state, message.config);
        client.config = config;
        setBandwidth(state, client, config.bandwidthKbps);
        if (config.generationPlan === 3) rejectPendingRequestClass(state, peer, false);
        if (!config.syncEnabled) rejectPendingRequestClass(state, peer, true);
        peer.send(sessionConfig(config));
        state.log.debug(
            `${ansi.named.name(peer.name)} configured DH requests: generation ${config.generationPlan === 3 ? 'disabled' : 'enabled'} (${ansi.named.number(config.generationDistance)} chunks, ${ansi.named.number(config.generationRate)}/s), sync ${config.syncEnabled ? 'enabled' : 'disabled'} (${ansi.named.number(config.syncDistance)} chunks, ${ansi.named.number(config.syncRate)}/s), bandwidth ${config.bandwidthKbps === 0 ? 'unlimited' : `${ansi.named.number(config.bandwidthKbps)} KB/s`}.`,
        );
        return;
    }
    if (message.type === 'cancel') {
        const index = state.requests.findIndex((r) => r.name === peer.name && r.tracker === message.tracker);
        const request = state.requests[index];
        if (request) {
            state.cancelled++;
            state.log.debug(
                `Cancelled DH request ${ansi.named.number(request.tracker)} from ${ansi.named.name(peer.name)} for ${lodLocation(request.level, request.section.x, request.section.z)}.`,
            );
            state.drop(request);
        } else {
            const response = cancelQueuedResponse(client, message.tracker);
            if (response) {
                state.cancelled++;
                state.log.debug(
                    `Cancelled queued DH response ${ansi.named.number(message.tracker)} from ${ansi.named.name(peer.name)} for ${lodLocation(response.lod.level, response.lod.section.x, response.lod.section.z)}.`,
                );
            }
        }
        return;
    }
    if (message.type !== 'request') return;
    if (
        state.requests.some((r) => r.name === peer.name && r.tracker === message.tracker) ||
        client.packets.some((response) => response.lod.tracker === message.tracker)
    ) {
        state.log.debug(
            `Ignored duplicate DH request ${ansi.named.number(message.tracker)} from ${ansi.named.name(peer.name)}.`,
        );
        return;
    }
    const failure = validate(state, peer, client, message);
    if (failure) {
        state.rejected++;
        state.lastFailure = failure.reason;
        state.log.debug(
            `Rejected DH request ${ansi.named.number(message.tracker)} from ${ansi.named.name(peer.name)} for ${lodLocation(peer.level, message.section.x, message.section.z)}: ${failure.reason}.`,
        );
        peer.send(reject(message.tracker, failure.reason, failure.kind));
        return;
    }
    const key = sectionKey(peer.level, message.section.x, message.section.z);
    state.log.debug(
        `Queued DH request ${ansi.named.number(message.tracker)} from ${ansi.named.name(peer.name)} for ${lodLocation(peer.level, message.section.x, message.section.z)}.`,
    );
    state.requests.push({
        name: peer.name,
        tracker: message.tracker,
        key,
        level: peer.level,
        section: message.section,
        timestamp: message.timestamp,
        revision: state.revisions.get(key) ?? 0,
    });
}

/**
 * Starts the player's DH session in their current world, or restarts it after a world change, and
 * sends the level and session configuration. Closes the session when the world height is unknown.
 */
export function announce(state: SessionState, peer: Peer): void {
    if (peer.terrain.height <= 0) {
        if (!state.heightWarnings.has(peer.level)) {
            state.heightWarnings.add(peer.level);
            state.log.warn(
                `World ${ansi.named.identifier(peer.level)} (${ansi.named.identifier(peer.dimension)}) has no known height, so DH sessions there are closed. Set height under [worlds."${peer.level}"] in config.toml.`,
            );
        }
        peer.send(closeSession(`${PLUGIN_NAME}: no world height is configured for ${peer.level}.`));
        state.removeClient(peer.name);
        return;
    }
    const existing = state.clients.get(peer.name);
    if (existing?.level === peer.level && existing.dimension === peer.dimension) {
        peer.send(levelInit(peer.dimension, state.settings.server_key, peer.level, state.now()));
        peer.send(sessionConfig(existing.config));
        return;
    }
    if (existing) {
        peer.send(closeSession('World changed; restarting the Distant Horizons session.'));
        state.removeClient(peer.name);
    }
    const config = serverConfiguration(state);
    state.clients.set(peer.name, {
        level: peer.level,
        dimension: peer.dimension,
        config,
        byteCredit: new ByteCredit(config.bandwidthKbps, state.now()),
        packets: [],
    });
    peer.send(levelInit(peer.dimension, state.settings.server_key, peer.level, state.now()));
    peer.send(sessionConfig(config));
    state.log.debug(
        `Established DH session with ${ansi.named.name(peer.name)} in ${ansi.named.identifier(peer.dimension)} / ${ansi.named.identifier(peer.level)} (generation distance ${ansi.named.number(config.generationDistance)} chunks at ${ansi.named.number(config.generationRate)}/s, sync distance ${ansi.named.number(config.syncDistance)} chunks at ${ansi.named.number(config.syncRate)}/s).`,
    );
}

function rejectPendingRequestClass(state: SessionState, peer: Peer, sync: boolean): void {
    for (let i = state.requests.length - 1; i >= 0; i--) {
        const request = state.requests[i];
        if (!request || request.name !== peer.name || (request.timestamp !== undefined) !== sync) continue;
        state.rejected++;
        state.lastFailure = 'LOD requests disabled by client';
        peer.send(reject(request.tracker, state.lastFailure, 2));
        state.drop(request);
    }
    for (const key of state.revisions.keys()) state.clearRevisionIfUnused(key);
}

function pendingWorkCount(state: SessionState): number {
    return (
        state.requests.length + [...state.clients.values()].reduce((count, client) => count + client.packets.length, 0)
    );
}

function serverConfiguration(state: SessionState): SessionConfiguration {
    return {
        generationPlan: 2,
        generationDistance: state.settings.render_distance,
        generationRate: Math.min(state.settings.generation_requests_per_second, state.settings.pending_requests),
        realTimeUpdates: false,
        realTimeDistance: 0,
        syncEnabled: true,
        syncDistance: state.settings.render_distance,
        syncRate: Math.min(state.settings.sync_requests_per_second, state.settings.pending_requests),
        bandwidthKbps: 0,
    };
}

function negotiateConfiguration(state: SessionState, request: SessionConfiguration): SessionConfiguration {
    const server = serverConfiguration(state);
    return {
        generationPlan: request.generationPlan,
        generationDistance: Math.min(request.generationDistance, server.generationDistance),
        generationRate: Math.min(request.generationRate, server.generationRate),
        realTimeUpdates: false,
        realTimeDistance: 0,
        syncEnabled: request.syncEnabled && server.syncEnabled,
        syncDistance: Math.min(request.syncDistance, server.syncDistance),
        syncRate: Math.min(request.syncRate, server.syncRate),
        bandwidthKbps: request.bandwidthKbps,
    };
}

/**
 * Checks a LOD request against the player's world, the negotiated configuration, the request range
 * and the world border.
 *
 * @param capacity - Also enforce the request rate and the server's pending-work limit, as for a new request.
 * @returns The rejection reason and wire kind, or undefined when the request can be served.
 */
export function validate(
    state: SessionState,
    peer: Peer,
    client: Client,
    request: Extract<Message, { type: 'request' }>,
    capacity = true,
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
            Math.max(Math.abs(x + SECTION_SIZE_BLOCKS / 2 - playerX), Math.abs(z + SECTION_SIZE_BLOCKS / 2 - playerZ)) -
            SECTION_SIZE_BLOCKS / 2;
    if (
        signedEdgeDistance > range ||
        !peer.insideBorder(x, z) ||
        !peer.insideBorder(x + SECTION_SIZE_BLOCKS - 1, z + SECTION_SIZE_BLOCKS - 1)
    )
        return { reason: 'Section outside request range or world border', kind: 1 };
    // Wire rates shape client demand; this queue is the server's combined backpressure bound.
    if (capacity && (rate === 0 || pendingWorkCount(state) >= state.settings.pending_requests))
        return { reason: 'LOD request limit reached', kind: 0 };
    return undefined;
}
