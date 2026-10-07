import { describe, expect, it } from 'vitest';
import { Reader } from '../protocol/bytes.ts';
import { MAX_TRANSFER_MESSAGE_BYTES, PROTOCOL, TRANSFER_PACKET_BYTES } from '../protocol/constants.ts';
import { transferFragment } from '../protocol/messages.ts';
import { ByteCredit } from './byte-credit.ts';
import { TransferCursor } from './transfer-cursor.ts';

function fragment(bytes: Uint8Array) {
    const input = new Reader(bytes);
    expect(input.short()).toBe(PROTOCOL);
    expect(input.short()).toBe(10);
    const buffer = input.int();
    const length = input.int();
    const data = input.bytes(length);
    const first = input.bool();
    input.end();
    return { buffer, data, first, bytes: bytes.length };
}

describe('DH transfer cursor', () => {
    it('rejects fragment sizes above the protocol maximum', () => {
        expect(() =>
            transferFragment(1, new Uint8Array(TRANSFER_PACKET_BYTES + 1), 0, TRANSFER_PACKET_BYTES + 1)
        ).toThrow('Invalid DH transfer fragment size');
    });

    it('assembles multiple fragments at 1 KB/s before the receiver expires its buffer', () => {
        const source = Uint8Array.from({ length: 60_000 }, (_, index) => index % 251);
        const cursor = new TransferCursor(7, 42, source, 1);
        const credit = new ByteCredit(1, 0);
        const receiver = new Map<number, { lastAccess: number; chunks: Uint8Array[] }>();
        const accessTimes: number[] = [];
        let finalResponse = false;
        let now = 0;

        for (now = 0; !cursor.done && now <= 90_000; now += 50) {
            const next = cursor.peek();
            if (!next || !credit.canSend(next.length, now)) continue;

            credit.consume(next.length);
            const input = new Reader(next);
            expect(input.short()).toBe(PROTOCOL);
            const id = input.short();
            if (id === 10) {
                const part = fragment(next);
                let buffer = receiver.get(part.buffer);
                if (buffer && now - buffer.lastAccess >= 30_000) {
                    receiver.delete(part.buffer);
                    buffer = undefined;
                }
                if (part.first) buffer = { lastAccess: now, chunks: [] };
                if (!buffer) throw new Error('DH receiver buffer expired before the next fragment');
                buffer.lastAccess = now;
                buffer.chunks.push(part.data);
                receiver.set(part.buffer, buffer);
                accessTimes.push(now);
                expect(part.bytes).toBe(part.data.length + 13);
                expect(part.bytes).toBeLessThanOrEqual(MAX_TRANSFER_MESSAGE_BYTES);
            } else {
                expect(id).toBe(8);
                expect(input.int()).toBe(7);
                expect(input.bool()).toBe(true);
                expect(input.int()).toBe(42);
                input.int();
                input.end();
                const buffer = receiver.get(42);
                if (!buffer || now - buffer.lastAccess >= 30_000) {
                    throw new Error('DH receiver had no complete buffer when the final response arrived');
                }
                expect(concat(buffer.chunks)).toEqual(source);
                finalResponse = true;
            }
            cursor.advance();
        }

        expect(finalResponse).toBe(true);
        expect(accessTimes.length).toBeGreaterThan(2);
        expect(accessTimes.slice(1).every((time, index) => time - (accessTimes[index] ?? time) < 30_000)).toBe(true);
        expect(cursor.done).toBe(true);
    });

    it('rebuilds an unsent fragment after the negotiated rate changes', () => {
        const cursor = new TransferCursor(1, 2, new Uint8Array(60_000).fill(3), 2);
        const initial = cursor.peek();
        expect(initial).toBeDefined();
        expect(fragment(initial ?? new Uint8Array()).data).toHaveLength(TRANSFER_PACKET_BYTES);

        cursor.setBandwidthRate(1);

        const resized = cursor.peek();
        expect(resized).toBeDefined();
        expect(fragment(resized ?? new Uint8Array())).toMatchObject({
            data: expect.any(Uint8Array),
            first: true
        });
        expect(fragment(resized ?? new Uint8Array()).data).toHaveLength(19_987);
        expect(resized).not.toBe(initial);
        expect(cursor.packetCount).toBe(5);
    });

    it('keeps nonuniform one-kilobyte ticks inside the receiver access window', () => {
        const source = Uint8Array.from({ length: 60_000 }, (_, index) => index % 239);
        const cursor = new TransferCursor(8, 43, source, 1);
        const credit = new ByteCredit(1, 0);
        let lastAccess = -1;
        let assembled: Uint8Array[] = [];
        let completed = false;

        for (const now of [
            0, 5_000, 11_000, 17_500, 23_000, 27_000, 33_000, 41_000, 47_000, 50_000, 59_000, 61_000, 62_000, 63_000
        ]) {
            const next = cursor.peek();
            if (!next || !credit.canSend(next.length, now)) continue;
            credit.consume(next.length);
            const input = new Reader(next);
            input.short();
            const id = input.short();
            if (id === 10) {
                const { buffer, data, first } = fragment(next);
                expect(buffer).toBe(43);
                if (lastAccess >= 0) expect(now - lastAccess).toBeLessThan(30_000);
                if (first) assembled = [];
                assembled.push(data);
                lastAccess = now;
            } else {
                expect(id).toBe(8);
                expect(input.int()).toBe(8);
                expect(input.bool()).toBe(true);
                expect(input.int()).toBe(43);
                input.int();
                input.end();
                expect(concat(assembled)).toEqual(source);
                expect(now - lastAccess).toBeLessThan(30_000);
                completed = true;
            }
            cursor.advance();
        }

        expect(completed).toBe(true);
        expect(cursor.done).toBe(true);
    });

    it('uses the protocol maximum for higher and unlimited rates and updates packet counts', () => {
        const cursor = new TransferCursor(3, 4, new Uint8Array(80_000), 1);
        const first = fragment(cursor.peek() ?? new Uint8Array());
        expect(first.data).toHaveLength(19_987);
        cursor.advance();
        expect(cursor.remainingPackets).toBe(5);

        cursor.setBandwidthRate(500);
        const second = fragment(cursor.peek() ?? new Uint8Array());
        expect(second.data).toHaveLength(TRANSFER_PACKET_BYTES);
        expect(second.bytes).toBe(MAX_TRANSFER_MESSAGE_BYTES);
        expect(cursor.packetCount).toBe(5);

        cursor.advance();
        cursor.setBandwidthRate(0);
        expect(fragment(cursor.peek() ?? new Uint8Array()).data).toHaveLength(TRANSFER_PACKET_BYTES);
    });
});

function concat(chunks: Uint8Array[]): Uint8Array {
    const result = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
    }
    return result;
}
