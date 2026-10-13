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

it('keeps captured runtime diagnostics in the shared error format', () => {
    expect(formatBuildOutput({ type: 'error', message: 'componentizer failed\nlink failed' })).toBe(
        '[build] Error: \u001b[1;31mcomponentizer failed\u001b[0m\n[build]   \u001b[1;31mlink failed\u001b[0m'
    );
});
