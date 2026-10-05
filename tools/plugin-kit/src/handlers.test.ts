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
});
