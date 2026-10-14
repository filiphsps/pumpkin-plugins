import { expect, it } from 'vitest';
import { createEngineVariants } from './engine-variants.ts';

it('includes QuickJS and every Static Hermes profile, collector, and parser mode', () => {
    const variants = createEngineVariants();

    expect(variants.map(({ id }) => id)).toEqual([
        'quickjs',
        'static-hermes-full-hades-js',
        'static-hermes-full-hades-ts',
        'static-hermes-full-malloc-js',
        'static-hermes-full-malloc-ts',
        'static-hermes-lean-hades-js',
        'static-hermes-lean-hades-ts',
        'static-hermes-lean-malloc-js',
        'static-hermes-lean-malloc-ts',
    ]);
    expect(
        variants
            .slice(1)
            .map(({ staticHermesRuntime, staticHermesGc, parseTypeScript }) => [
                staticHermesRuntime,
                staticHermesGc,
                parseTypeScript,
            ]),
    ).toEqual([
        ['full', 'hades', false],
        ['full', 'hades', true],
        ['full', 'malloc', false],
        ['full', 'malloc', true],
        ['lean', 'hades', false],
        ['lean', 'hades', true],
        ['lean', 'malloc', false],
        ['lean', 'malloc', true],
    ]);
});
