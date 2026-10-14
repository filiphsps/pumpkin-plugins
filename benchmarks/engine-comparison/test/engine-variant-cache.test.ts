import * as path from 'node:path';
import { expect, it } from 'vitest';
import { createEngineVariants, getEngineVariantBuildOutput } from './engine-variants.ts';

it('assigns each engine configuration a stable, separate cached component path', () => {
    const benchmarkDir = '/repo/benchmarks/engine-comparison';
    const variants = createEngineVariants();
    const buildOutputs = variants.map(({ id }) => getEngineVariantBuildOutput(benchmarkDir, id));
    const outputDirectory = path.join(benchmarkDir, 'build', 'engine-comparison');

    expect(buildOutputs).toHaveLength(variants.length);
    expect(new Set(buildOutputs).size).toBe(variants.length);
    for (const [index, variant] of variants.entries()) {
        const buildOutput = buildOutputs[index];
        expect(buildOutput).toBe(path.join(outputDirectory, `${variant.id}.wasm`));
    }
});
