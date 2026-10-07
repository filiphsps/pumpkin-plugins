/*
 * Adapted from DH Support. Copyright (C) 2024 Jim C K Flaten.
 * Protocol adaptations reference Distant Horizons core, Copyright (C) 2020 James Seibel,
 * originally under LGPL-3.0-only (see ../../LICENSE.LESSER.txt).
 * Changes for Pumpkin made in October 2026.
 * SPDX-License-Identifier: GPL-3.0-or-later
 * This program is free software under GNU GPL version 3 or any later version.
 * Distributed WITHOUT ANY WARRANTY; see ../../LICENSE.
 */
import { Reader, Writer } from './bytes.ts';
import { PROTOCOL, TRANSFER_PACKET_BYTES } from './constants.ts';

export * from './constants.ts';
/** Plugin channel shared with the released DH client. */
export const CHANNEL = 'distant_horizons:msg';
/** Coordinates of a DH block-detail section. */
export interface Section {
    high: number;
    low: number;
    detail: number;
    x: number;
    z: number;
}
/** Settings exchanged in a DH session configuration message. */
export interface SessionConfiguration {
    generationPlan: number;
    generationDistance: number;
    generationRate: number;
    realTimeUpdates: boolean;
    realTimeDistance: number;
    syncEnabled: boolean;
    syncDistance: number;
    syncRate: number;
    bandwidthKbps: number;
}
/** Client messages accepted by the server. */
export type Message =
    | { type: 'init'; dimension: string }
    | { type: 'config'; config: SessionConfiguration }
    | { type: 'request'; tracker: number; level: string; section: Section; timestamp?: number }
    | { type: 'cancel'; tracker: number }
    | { type: 'close' };

/** Reads a packed section position without losing any of its 64 bits. */
export function readSection(input: Reader): Section {
    const { high, low } = input.words();
    const x = (((low >>> 8) | ((high & 15) << 24)) << 4) >> 4;
    const z = ((high >>> 4) << 4) >> 4;
    return { high, low, detail: low & 255, x, z };
}

/** Reads only client-to-server messages and validates their complete layout. */
export function decode(data: Uint8Array): Message {
    if (data.length > 4096) throw new RangeError('DH client message is too large');
    const input = new Reader(data);
    if (input.short() !== PROTOCOL) throw new RangeError('Incompatible DH protocol');
    const id = input.short();
    let message: Message;
    if (id === 3) message = { type: 'init', dimension: input.string() };
    else if (id === 4) {
        const generationPlan = input.byte();
        if (generationPlan > 3) throw new RangeError('Invalid generator plan');
        const generationDistance = input.int();
        input.int();
        input.int();
        input.int();
        const generationRate = input.int();
        const realTimeUpdates = input.bool();
        const realTimeDistance = input.int();
        const syncEnabled = input.bool();
        const syncDistance = input.int();
        const syncRate = input.int();
        const bandwidthKbps = input.int();
        if (
            generationDistance < 0 ||
            generationRate < 0 ||
            realTimeDistance < 0 ||
            syncDistance < 0 ||
            syncRate < 0 ||
            bandwidthKbps < 0
        )
            throw new RangeError('Invalid DH client limits');
        message = {
            type: 'config',
            config: {
                generationPlan,
                generationDistance,
                generationRate,
                realTimeUpdates,
                realTimeDistance,
                syncEnabled,
                syncDistance,
                syncRate,
                bandwidthKbps
            }
        };
    } else if (id === 7) {
        const tracker = input.int();
        const level = input.string();
        const section = readSection(input);
        const timestamp = input.bool() ? input.timestamp() : undefined;
        message = { type: 'request', tracker, level, section, timestamp };
    } else if (id === 5) message = { type: 'cancel', tracker: input.int() };
    else if (id === 1) {
        input.string();
        message = { type: 'close' };
    } else throw new RangeError('Unexpected DH client message');
    input.end();
    return message;
}

/** Starts a server message with the protocol and message id. */
export function packet(id: number): Writer {
    return new Writer().short(PROTOCOL).short(id);
}
/** Announces the current world and the persistent server identity. */
export function levelInit(dimension: string, server: string, level: string, now: number): Uint8Array {
    return packet(2).string(dimension).string(server).string(level).timestamp(now).finish();
}
/** Encodes the negotiated settings for one DH client session. */
export function sessionConfig(config: SessionConfiguration): Uint8Array {
    return packet(4)
        .byte(config.generationPlan)
        .int(config.generationDistance)
        .int(0)
        .int(0)
        .int(0)
        .int(config.generationRate)
        .bool(config.realTimeUpdates)
        .int(config.realTimeDistance)
        .bool(config.syncEnabled)
        .int(config.syncDistance)
        .int(config.syncRate)
        .int(config.bandwidthKbps)
        .finish();
}
/** Rejects a request using the client's typed exception response. */
export function reject(tracker: number, reason: string, kind = 2): Uint8Array {
    return packet(6).int(tracker).int(kind).string(reason).finish();
}
/** Closes a DH session with a client-readable reason. */
export function closeSession(reason: string): Uint8Array {
    return packet(1).string(reason).finish();
}
/** Responds to an unchanged update-only request. */
export function unchanged(tracker: number): Uint8Array {
    return packet(8).int(tracker).bool(false).finish();
}
/** Splits an LOD payload before the response points the client at its buffer. */
export function transfer(tracker: number, buffer: number, lod: Uint8Array): Uint8Array[] {
    const packets: Uint8Array[] = [];
    for (let offset = 0; offset < lod.length; offset += TRANSFER_PACKET_BYTES) {
        packets.push(transferFragment(buffer, lod, offset));
    }
    packets.push(transferResponse(tracker, buffer));
    return packets;
}

/** Encodes one bounded transfer fragment. */
export function transferFragment(buffer: number, lod: Uint8Array, offset: number): Uint8Array {
    const part = lod.subarray(offset, offset + TRANSFER_PACKET_BYTES);
    return packet(10)
        .int(buffer)
        .blob(part)
        .bool(offset === 0)
        .finish();
}

/** Encodes the response that completes a transfer after all fragments. */
export function transferResponse(tracker: number, buffer: number): Uint8Array {
    return packet(8).int(tracker).bool(true).int(buffer).int(0).finish();
}
