import { expect, it } from 'vitest';
import { createEngineVariants, getEngineVariantBuildOutput } from './engine-variants.ts';

it('assigns each engine configuration a separate cached component path', () => {
    const benchmarkDir = '/repo/benchmarks/engine-comparison';
    const variants = createEngineVariants();
    const buildOutputs = variants.map(({ id }) => getEngineVariantBuildOutput(benchmarkDir, id));

    expect(new Set(buildOutputs).size).toBe(variants.length);
});
