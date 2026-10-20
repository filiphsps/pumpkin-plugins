import { resolvePumpkinBinary } from './binary.ts';

/**
 * Vitest global setup: resolves (and if needed downloads) the Pumpkin binary once, before any worker
 * starts, so parallel test files never race on the download. Workers inherit `PUMPKIN_BIN`.
 */
export default async function setup(): Promise<void> {
    process.env.PUMPKIN_BIN = await resolvePumpkinBinary();
}
