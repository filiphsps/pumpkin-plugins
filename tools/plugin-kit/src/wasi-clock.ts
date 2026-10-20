import { now } from 'wasi:clocks/monotonic-clock@0.2.3';

/**
 * Reads the host's monotonic clock in milliseconds. Unlike `Date.now`, it never moves backwards,
 * so use it for deadlines and for timing work. The fractional part keeps sub-millisecond precision.
 */
export function monotonicMs(): number {
    return Number(now()) / 1_000_000;
}
