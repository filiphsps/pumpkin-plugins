import { expect, it } from 'vitest';
import { formatBuildOutput } from './output.ts';

it('formats both componentizers and results with the shared build prefix', () => {
    expect(formatBuildOutput({ type: 'componentize', engine: 'quickjs' })).toBe(
        '[build] Componentizing with \u001b[36mQuickJS\u001b[0m...'
    );
    expect(formatBuildOutput({ type: 'componentize', engine: 'static-hermes', runtimeVariant: 'lean' })).toBe(
        '[build] Componentizing with \u001b[36mStatic Hermes (lean)\u001b[0m...'
    );
    expect(formatBuildOutput({ type: 'built', output: 'build/plugin.wasm', sizeBytes: 2048 })).toBe(
        '[build] Built \u001b[36mbuild/plugin.wasm\u001b[0m (\u001b[94m2 KiB\u001b[0m)'
    );
});

it('shows when Static Hermes uses its TypeScript parser', () => {
    expect(
        formatBuildOutput({ type: 'bundle', entry: 'src/plugin.ts', engine: 'static-hermes', parseTypeScript: true })
    ).toBe('[build] Bundling \u001b[36msrc/plugin.ts\u001b[0m with \u001b[36mStatic Hermes (-parse-ts)\u001b[0m...');
    expect(
        formatBuildOutput({
            type: 'componentize',
            engine: 'static-hermes',
            runtimeVariant: 'lean',
            parseTypeScript: true
        })
    ).toBe('[build] Componentizing with \u001b[36mStatic Hermes (lean, -parse-ts)\u001b[0m...');
});

it('prints Static Hermes selections and explains omitted all-operation filters', () => {
    expect(
        formatBuildOutput({
            type: 'componentize',
            engine: 'static-hermes',
            runtimeVariant: 'lean',
            selections: {
                wasiImports: ['wasi:clocks/monotonic-clock@0.2.3'],
                apiMethods: ['player.player.get-position']
            }
        })
    ).toBe(
        '[build] Componentizing with \u001b[36mStatic Hermes (lean)\u001b[0m...\n' +
            '[build]   \u001b[36m--wasi-imports\u001b[0m \u001b[33m["wasi:clocks/monotonic-clock@0.2.3"]\u001b[0m\n' +
            '[build]   \u001b[36m--wasi-methods\u001b[0m \u001b[33m(omitted; all imported WASI operations)\u001b[0m\n' +
            '[build]   \u001b[36m--api-methods\u001b[0m \u001b[33m["player.player.get-position"]\u001b[0m\n' +
            '[build]   \u001b[36m--event-types\u001b[0m \u001b[33m(omitted; all event variants)\u001b[0m'
    );
});

it('keeps captured runtime diagnostics in the shared error format', () => {
    expect(formatBuildOutput({ type: 'error', message: 'componentizer failed\nlink failed' })).toBe(
        '[build] Error: \u001b[1;31mcomponentizer failed\u001b[0m\n[build]   \u001b[1;31mlink failed\u001b[0m'
    );
});
