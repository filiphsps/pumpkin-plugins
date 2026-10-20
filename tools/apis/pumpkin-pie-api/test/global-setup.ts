import { resolvePumpkinBinary } from '@pumpkin-plugins/test-harness';
import type { TestProject } from 'vitest/node';
import { resolvePieProvider } from './provider.ts';

declare module 'vitest' {
    export interface ProvidedContext {
        pieProviderPath: string;
    }
}

/** Resolve the server and checksum-verified provider once before integration workers start. */
export default async function setup(project: TestProject): Promise<void> {
    process.env.PUMPKIN_BIN = await resolvePumpkinBinary();
    project.provide('pieProviderPath', await resolvePieProvider());
}
