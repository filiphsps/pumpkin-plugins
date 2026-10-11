import { PUMPKIN_RELEASE, resolvePumpkinBinary } from '@pumpkin-plugins/test-harness';
import type { TestProject } from 'vitest/node';
import { PIE_RELEASE, resolvePieProvider } from './provider.ts';

declare module 'vitest' {
    export interface ProvidedContext {
        pieProviderPath: string;
    }
}

/** Resolve the server and checksum-verified provider once before integration workers start. */
export default async function setup(project: TestProject): Promise<void> {
    if (PUMPKIN_RELEASE !== PIE_RELEASE.pumpkinRelease)
        throw new Error('PumpkinPIE fixture does not target the pinned Pumpkin release');
    process.env.PUMPKIN_BIN = await resolvePumpkinBinary();
    project.provide('pieProviderPath', await resolvePieProvider());
}
