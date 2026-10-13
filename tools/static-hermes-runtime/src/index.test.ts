import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, expect, it, vi } from 'vitest';
import { buildStaticHermesComponent } from './index.ts';

const mocks = vi.hoisted(() => ({ execFileSync: vi.fn() }));

vi.mock('node:child_process', () => ({ execFileSync: mocks.execFileSync }));
vi.mock('./esbuild-plugin.ts', () => ({ staticHermesImportsPlugin: vi.fn() }));

beforeEach(() => mocks.execFileSync.mockReset());

it('forwards selected build options to the packaged CLI', () => {
    const options = {
        workspaceRoot: '/plugin',
        bundle: '/plugin/build/plugin.js',
        witDir: '/plugin/build/wit',
        output: '/plugin/build/plugin.wasm',
        developmentMode: true,
        runtimeVariant: 'full' as const,
        quietOutput: true,
        wasiImports: ['wasi:filesystem/types@0.2.3'],
        wasiMethods: ['wasi:filesystem/types@0.2.3#read-via-stream'],
        apiMethods: ['logging.log']
    };

    buildStaticHermesComponent(options);

    const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    expect(mocks.execFileSync).toHaveBeenCalledWith(
        process.execPath,
        [
            path.join(packageRoot, 'dist/cli.js'),
            'component',
            'build',
            '--bundle',
            options.bundle,
            '--wit',
            options.witDir,
            '--output',
            options.output,
            '--workspace-root',
            options.workspaceRoot,
            '--development-mode',
            '--wasi-imports',
            JSON.stringify(options.wasiImports),
            '--wasi-methods',
            JSON.stringify(options.wasiMethods),
            '--api-methods',
            JSON.stringify(options.apiMethods),
            '--runtime-variant',
            'full'
        ],
        { stdio: ['inherit', 'ignore', 'pipe'], maxBuffer: 16 * 1024 * 1024 }
    );
});

it('inherits runtime output by default for direct component builds', () => {
    buildStaticHermesComponent({
        bundle: 'bundle.js',
        witDir: 'wit',
        output: 'plugin.wasm',
        developmentMode: false
    });

    expect(mocks.execFileSync).toHaveBeenCalledWith(expect.any(String), expect.any(Array), { stdio: 'inherit' });
});

it('uses empty WASI imports and omits optional selections by default', () => {
    buildStaticHermesComponent({
        bundle: 'bundle.js',
        witDir: 'wit',
        output: 'plugin.wasm',
        developmentMode: false
    });

    const args = mocks.execFileSync.mock.calls[0]?.[1] as string[] | undefined;
    expect(args).toContain('--wasi-imports');
    expect(args?.[args.indexOf('--wasi-imports') + 1]).toBe('[]');
    expect(args).not.toContain('--development-mode');
    expect(args).not.toContain('--wasi-methods');
    expect(args).not.toContain('--api-methods');
    expect(args).not.toContain('--runtime-variant');
});
