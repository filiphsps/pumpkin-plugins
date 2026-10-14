import { expect, it } from 'vitest';
import { createEngineComparisonMatrix, createEngineVariants } from './engine-variants.ts';

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
});

it('builds benchmark and stack-guard jobs from the engine variant definitions', () => {
    const variants = createEngineVariants();
    const matrix = createEngineComparisonMatrix();
    const benchmarkJobs = matrix.filter(({ kind }) => kind === 'benchmark');
    const stackGuardJobs = matrix.filter(({ kind }) => kind === 'stack-guard');
    const runtimeProfiles = new Set(variants.flatMap(({ staticHermesRuntime }) => staticHermesRuntime ?? []));

    expect(benchmarkJobs).toHaveLength(variants.length);
    expect(new Set(benchmarkJobs.map(({ variant }) => variant)).size).toBe(variants.length);
    for (const { id } of variants) {
        expect(benchmarkJobs.some(({ variant }) => variant === id)).toBe(true);
    }

    expect(stackGuardJobs).toHaveLength(runtimeProfiles.size);
    for (const runtime of runtimeProfiles) {
        expect(stackGuardJobs).toContainEqual({
            kind: 'stack-guard',
            variant: `static-hermes-${runtime}-stack-guard`,
            runtime,
        });
    }
});
