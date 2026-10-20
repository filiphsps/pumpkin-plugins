import { resolvePumpkinBinary } from '@pumpkin-plugins/test-harness';

/** Resolves the Pumpkin binary once, before the comparison starts its servers. */
export default async function setup(): Promise<void> {
    process.env.PUMPKIN_BIN = await resolvePumpkinBinary();
}
