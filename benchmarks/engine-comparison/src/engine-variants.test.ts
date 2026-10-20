import { expect, it } from 'vitest';
import { createEngineVariants, getEngineVariantBuildOutput } from './engine-variants.ts';

it('includes QuickJS and every Static Hermes profile, collector, and parser mode', () => {
    const variants = createEngineVariants();
    const quickjsVariants = variants.filter(({ pluginEngine }) => pluginEngine === 'quickjs');
    const hermesVariants = variants.filter(({ pluginEngine }) => pluginEngine === 'static-hermes');
    const profiles = new Set(hermesVariants.map(({ staticHermesRuntime }) => staticHermesRuntime));
    const collectors = new Set(hermesVariants.map(({ staticHermesGc }) => staticHermesGc));
    const parserModes = new Set(hermesVariants.map(({ parseTypeScript }) => parseTypeScript));

    expect(quickjsVariants).toHaveLength(1);
    expect(quickjsVariants[0]).toMatchObject({ id: 'quickjs', runtimeSourceCompilation: true });
    expect(hermesVariants).toHaveLength(profiles.size * collectors.size * parserModes.size);
    expect(profiles).toEqual(new Set(['full', 'lean']));
    expect(collectors).toEqual(new Set(['hades', 'malloc']));
    expect(parserModes).toEqual(new Set([false, true]));

    const combinations = hermesVariants.map(
        ({ staticHermesRuntime, staticHermesGc, parseTypeScript }) =>
            `${staticHermesRuntime}/${staticHermesGc}/${parseTypeScript}`,
    );
    expect(new Set(combinations).size).toBe(hermesVariants.length);
    expect(new Set(variants.map(({ id }) => id)).size).toBe(variants.length);
    const buildOutputs = variants.map(({ id }) =>
        getEngineVariantBuildOutput('/repo/benchmarks/engine-comparison', id),
    );
    expect(new Set(buildOutputs).size).toBe(variants.length);
});
