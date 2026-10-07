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
/** Client messages accepted by the server. */
export type Message =
    | { type: 'init'; dimension: string }
    | { type: 'config'; disabled: boolean; distance: number; concurrency: number; sync: boolean }
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
        const plan = input.byte();
        if (plan > 3) throw new RangeError('Invalid generator plan');
        const distance = input.int();
        input.int();
        input.int();
        input.int();
        const concurrency = input.int();
        input.bool();
        input.int();
        const sync = input.bool();
        input.int();
        input.int();
        input.int();
        if (distance < 0 || concurrency < 0) throw new RangeError('Invalid DH client limits');
        message = { type: 'config', disabled: plan === 3, distance, concurrency, sync };
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
/** Advertises the generation and login-sync request rates allowed by this server. */
export function sessionConfig(
    distance: number,
    generationRequestsPerSecond: number,
    syncRequestsPerSecond: number
): Uint8Array {
    return packet(4)
        .byte(2)
        .int(distance)
        .int(0)
        .int(0)
        .int(0)
        .int(generationRequestsPerSecond)
        .bool(false)
        .int(0)
        .bool(true)
        .int(distance)
        .int(syncRequestsPerSecond)
        .int(0)
        .finish();
}
/** Rejects a request using the client's typed exception response. */
export function reject(tracker: number, reason: string, kind = 2): Uint8Array {
    return packet(6).int(tracker).int(kind).string(reason).finish();
}
/** Responds to an unchanged update-only request. */
export function unchanged(tracker: number): Uint8Array {
    return packet(8).int(tracker).bool(false).finish();
}
/** Splits an LOD payload before the response points the client at its buffer. */
export function transfer(tracker: number, buffer: number, lod: Uint8Array): Uint8Array[] {
    const packets: Uint8Array[] = [];
    for (let offset = 0; offset < lod.length; offset += TRANSFER_PACKET_BYTES) {
        const part = lod.subarray(offset, offset + TRANSFER_PACKET_BYTES);
        packets.push(
            packet(10)
                .int(buffer)
                .blob(part)
                .bool(offset === 0)
                .finish()
        );
    }
    packets.push(packet(8).int(tracker).bool(true).int(buffer).int(0).finish());
    return packets;
}
