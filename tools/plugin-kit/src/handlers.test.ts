import { describe, expect, it } from 'vitest';
import { HandlerRegistry } from './handlers.ts';

describe('HandlerRegistry', () => {
    it('hands out consecutive ids from the first one and finds handlers by id', () => {
        const registry = new HandlerRegistry<() => string>(900_000);
        const a = registry.add(() => 'a');
        const b = registry.add(() => 'b');
        expect([a, b]).toEqual([900_000, 900_001]);
        expect(registry.get(a)?.()).toBe('a');
        expect(registry.get(b)?.()).toBe('b');
    });

    it('returns undefined for ids it did not hand out, so callers can fall through', () => {
        expect(new HandlerRegistry<() => void>(900_000).get(5)).toBeUndefined();
    });

    it('removes a handler when it is taken', () => {
        const registry = new HandlerRegistry<string>(7);
        const id = registry.add('once');

        expect(registry.take(id)).toBe('once');
        expect(registry.get(id)).toBeUndefined();
    });
    it.each([-1, 0.5, NaN, Infinity, 0x1_0000_0000])('rejects invalid first id %s', (id) => {
        expect(() => new HandlerRegistry(id)).toThrow(RangeError);
    });

    it('fails before overflowing the host u32 id space', () => {
        const registry = new HandlerRegistry<string>(0xffff_ffff);
        expect(registry.add('last')).toBe(0xffff_ffff);
        expect(() => registry.add('overflow')).toThrow('Handler ids exhausted');
        expect(registry.get(0xffff_ffff)).toBe('last');
    });
});
