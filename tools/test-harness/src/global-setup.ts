import { resolvePumpkinBinary } from './binary.ts';

// Resolve (and if needed download) the binary once, before any worker starts, so parallel
// test files never race on the download. Workers inherit this env var.
/** Vitest global setup: resolves the Pumpkin binary once, before any worker starts. */
export default async function setup(): Promise<void> {
    process.env.PUMPKIN_BIN = await resolvePumpkinBinary();
}
