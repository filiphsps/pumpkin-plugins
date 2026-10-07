import { describe, expect, it } from 'vitest';
import { Reader, Writer } from './bytes.ts';
import { decode, levelInit, packet, readSection, sessionConfig, transfer } from './messages.ts';

describe('Distant Horizons protocol', () => {
    it('encodes a UTF-8 level announcement with a millisecond timestamp', () => {
        const data = levelInit('minecraft:overworld', 'server', 'world', 4294967297);
        const input = new Reader(data);
        expect(input.short()).toBe(16);
        expect(input.short()).toBe(2);
        expect(input.string()).toBe('minecraft:overworld');
        expect(input.string()).toBe('server');
        expect(input.string()).toBe('world');
        expect([...input.bytes(8)]).toEqual([0, 0, 0, 1, 0, 0, 0, 1]);
        input.end();
        expect([...new Writer().string('ö😀').finish()]).toEqual([0, 6, 195, 182, 240, 159, 152, 128]);
        expect(new Reader(new Writer().string('ö😀').finish()).string()).toBe('ö😀');
    });
    it('decodes signed section coordinates without rounding 64-bit positions', () => {
        const bytes = new Writer().words(0xffffffff, 0xffffff06).finish();
        expect(readSection(new Reader(bytes))).toEqual({ high: 0xffffffff, low: 0xffffff06, detail: 6, x: -1, z: -1 });
        const data = packet(7).int(-12).string('world').bytes(bytes).bool(true).timestamp(123456789).finish();
        expect(decode(data)).toMatchObject({
            type: 'request',
            tracker: -12,
            level: 'world',
            section: { x: -1, z: -1 },
            timestamp: 123456789
        });
    });
    it('rejects truncated, malformed, oversized, or unexpected messages', () => {
        for (const data of [
            new Uint8Array(),
            packet(7).int(1).finish(),
            packet(8).finish(),
            packet(3).string('world').byte(0).finish(),
            new Uint8Array(4097)
        ])
            expect(() => decode(data)).toThrow();
        expect(() => new Reader(new Uint8Array([0, 2, 192, 128])).string()).toThrow('UTF-8');
        expect(() => decode(new Writer().short(15).short(3).string('world').finish())).toThrow('protocol');
    });
    it('encodes negotiated generation and sync limits independently', () => {
        const bytes = sessionConfig({
            generationPlan: 2,
            generationDistance: 128,
            generationRate: 20,
            realTimeUpdates: false,
            realTimeDistance: 0,
            syncEnabled: true,
            syncDistance: 128,
            syncRate: 50,
            bandwidthKbps: 0
        });
        expect(bytes.length).toBe(43);
        expect(decode(bytes)).toEqual({
            type: 'config',
            config: {
                generationPlan: 2,
                generationDistance: 128,
                generationRate: 20,
                realTimeUpdates: false,
                realTimeDistance: 0,
                syncEnabled: true,
                syncDistance: 128,
                syncRate: 50,
                bandwidthKbps: 0
            }
        });
        const input = new Reader(bytes);
        input.short();
        input.short();
        expect(input.byte()).toBe(2);
        expect(input.int()).toBe(128);
        for (let i = 0; i < 3; i++) expect(input.int()).toBe(0);
        expect(input.int()).toBe(20);
        expect(input.bool()).toBe(false);
        input.int();
        expect(input.bool()).toBe(true);
        expect(input.int()).toBe(128);
        expect(input.int()).toBe(50);
        expect(input.int()).toBe(0);
        input.end();
    });
    it('preserves the independent client request, update, sync, and bandwidth settings', () => {
        const bytes = packet(4)
            .byte(1)
            .int(96)
            .int(12)
            .int(-8)
            .int(128)
            .int(17)
            .bool(true)
            .int(64)
            .bool(false)
            .int(48)
            .int(23)
            .int(500)
            .finish();

        expect(decode(bytes)).toEqual({
            type: 'config',
            config: {
                generationPlan: 1,
                generationDistance: 96,
                generationRate: 17,
                realTimeUpdates: true,
                realTimeDistance: 64,
                syncEnabled: false,
                syncDistance: 48,
                syncRate: 23,
                bandwidthKbps: 500
            }
        });
    });
    it('splits data before sending its tracked response', () => {
        const bytes = new Uint8Array(60001).fill(9);
        const messages = transfer(42, 17, bytes);
        const restored: number[] = [];
        for (let i = 0; i < 3; i++) {
            const input = new Reader(messages[i] ?? new Uint8Array());
            expect(input.short()).toBe(16);
            expect(input.short()).toBe(10);
            expect(input.int()).toBe(17);
            restored.push(...input.bytes(input.int()));
            expect(input.bool()).toBe(i === 0);
            input.end();
        }
        expect(new Uint8Array(restored)).toEqual(bytes);
        expect([...(messages[3] ?? [])]).toEqual([0, 16, 0, 8, 0, 0, 0, 42, 1, 0, 0, 0, 17, 0, 0, 0, 0]);
    });
});
