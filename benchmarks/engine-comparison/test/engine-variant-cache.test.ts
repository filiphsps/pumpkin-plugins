import * as path from 'node:path';
import { expect, it } from 'vitest';
import { createEngineVariants, getEngineVariantBuildOutput } from './engine-variants.ts';

it('assigns each engine configuration a stable, separate cached component path', () => {
    const benchmarkDir = '/repo/benchmarks/engine-comparison';
    const buildOutputs = createEngineVariants().map(({ id }) => getEngineVariantBuildOutput(benchmarkDir, id));

    expect(buildOutputs).toEqual([
        path.join(benchmarkDir, 'build', 'engine-comparison', 'quickjs.wasm'),
        path.join(benchmarkDir, 'build', 'engine-comparison', 'static-hermes-full-hades-js.wasm'),
        path.join(benchmarkDir, 'build', 'engine-comparison', 'static-hermes-full-hades-ts.wasm'),
        path.join(benchmarkDir, 'build', 'engine-comparison', 'static-hermes-full-malloc-js.wasm'),
        path.join(benchmarkDir, 'build', 'engine-comparison', 'static-hermes-full-malloc-ts.wasm'),
        path.join(benchmarkDir, 'build', 'engine-comparison', 'static-hermes-lean-hades-js.wasm'),
        path.join(benchmarkDir, 'build', 'engine-comparison', 'static-hermes-lean-hades-ts.wasm'),
        path.join(benchmarkDir, 'build', 'engine-comparison', 'static-hermes-lean-malloc-js.wasm'),
        path.join(benchmarkDir, 'build', 'engine-comparison', 'static-hermes-lean-malloc-ts.wasm'),
    ]);
    expect(new Set(buildOutputs).size).toBe(9);
});
