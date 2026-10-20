import { stripVTControlCharacters } from 'node:util';
import { expect, it, vi } from 'vitest';
import { type BuildOutputMessage, formatBuildOutput, printBuildOutput } from './output.ts';

function plain(message: BuildOutputMessage): string {
    return stripVTControlCharacters(formatBuildOutput(message));
}

it('formats both componentizers and results with the shared build prefix', () => {
    expect(plain({ type: 'componentize', engine: 'quickjs' })).toBe('[build] Componentizing with QuickJS...');
    expect(plain({ type: 'componentize', engine: 'static-hermes', runtimeVariant: 'lean', gcVariant: 'hades' })).toBe(
        '[build] Componentizing with Static Hermes (lean, hades)...',
    );
    expect(plain({ type: 'built', output: 'build/plugin.wasm', sizeBytes: 2048 })).toBe(
        '[build] Built build/plugin.wasm (2 KiB)',
    );
});

it('shows when Static Hermes uses its TypeScript parser', () => {
    expect(
        plain({
            type: 'bundle',
            entry: 'src/plugin.ts',
            engine: 'static-hermes',
            gcVariant: 'hades',
            parseTypeScript: true,
        }),
    ).toBe('[build] Bundling src/plugin.ts with Static Hermes (hades, TS parser)...');
    expect(
        plain({
            type: 'componentize',
            engine: 'static-hermes',
            runtimeVariant: 'lean',
            gcVariant: 'hades',
            parseTypeScript: true,
        }),
    ).toBe('[build] Componentizing with Static Hermes (lean, hades, TS parser)...');
});

it('shows an explicitly selected malloc collector', () => {
    expect(
        plain({
            type: 'componentize',
            engine: 'static-hermes',
            runtimeVariant: 'lean',
            gcVariant: 'malloc',
        }),
    ).toBe('[build] Componentizing with Static Hermes (lean, malloc)...');
});

it('prints Static Hermes selections and explains omitted all-operation filters', () => {
    expect(
        plain({
            type: 'componentize',
            engine: 'static-hermes',
            runtimeVariant: 'lean',
            gcVariant: 'hades',
            selections: {
                wasiImports: ['wasi:clocks/monotonic-clock@0.2.3'],
                apiMethods: ['player.player.get-position'],
            },
        }),
    ).toBe(
        '[build] Componentizing with Static Hermes (lean, hades)...\n' +
            '[build]   --wasi-imports ["wasi:clocks/monotonic-clock@0.2.3"]\n' +
            '[build]   --wasi-methods (omitted; all imported WASI operations)\n' +
            '[build]   --api-methods ["player.player.get-position"]\n' +
            '[build]   --event-types (omitted; all event variants)',
    );
});

it('keeps captured runtime diagnostics in the shared error format', () => {
    expect(plain({ type: 'error', message: 'componentizer failed\nlink failed' })).toBe(
        '[build] Error: componentizer failed\n[build]   link failed',
    );
});

it('prints each message as one JSON object when the JSON log format is selected', () => {
    vi.stubEnv('PUMPKIN_PLUGINS_BUILD_LOG_FORMAT', 'json');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
        printBuildOutput({
            type: 'componentize',
            engine: 'static-hermes',
            runtimeVariant: 'lean',
            gcVariant: 'hades',
            parseTypeScript: true,
        });
        printBuildOutput({ type: 'error', message: 'componentizer failed\nlink failed' });

        expect(log.mock.calls).toEqual([
            [
                '{"type":"componentize","engine":"static-hermes","runtimeVariant":"lean","gcVariant":"hades","parseTypeScript":true}',
            ],
        ]);
        expect(error.mock.calls).toEqual([['{"type":"error","message":"componentizer failed\\nlink failed"}']]);
    } finally {
        log.mockRestore();
        error.mockRestore();
        vi.unstubAllEnvs();
    }
});
