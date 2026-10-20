import { describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ ns: 0n }));
vi.mock('wasi:clocks/monotonic-clock@0.2.3', () => ({ now: () => host.ns }));

import { monotonicMs } from './wasi-clock.ts';

describe('monotonicMs', () => {
    it('reads the monotonic clock in milliseconds', () => {
        host.ns = 15_000_000_000n;

        expect(monotonicMs()).toBe(15_000);
    });

    it('keeps sub-millisecond precision, so short work does not measure as zero', () => {
        host.ns = 2_000_250_000n;

        expect(monotonicMs()).toBe(2000.25);
    });
});
