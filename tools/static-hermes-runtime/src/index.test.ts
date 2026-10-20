import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createStaticHermesProgram } from './cli.ts';
import type { ComponentBuildOptions } from './component/types.ts';
import { buildStaticHermesComponent, type StaticHermesBuildOptions } from './index.ts';

const mocks = vi.hoisted(() => ({ execFileSync: vi.fn() }));

vi.mock('node:child_process', () => ({ execFileSync: mocks.execFileSync }));
vi.mock('./esbuild-plugin.ts', () => ({ staticHermesImportsPlugin: vi.fn() }));

/** Run the public builder, then parse the CLI arguments it spawned the way the packaged CLI would. */
async function cliBuildFor(options: StaticHermesBuildOptions) {
    mocks.execFileSync.mockReset();
    buildStaticHermesComponent(options);
    const [command, [cli, ...args], spawnOptions] = mocks.execFileSync.mock.calls[0] as [
        string,
        string[],
        { stdio: unknown },
    ];
    expect(command).toBe(process.execPath);
    expect(fs.existsSync(cli)).toBe(true);

    const received: ComponentBuildOptions[] = [];
    await createStaticHermesProgram({
        hermesSource: () => undefined,
        hermesPatch: () => undefined,
        hermesBuild: () => undefined,
        hermesPrepare: () => undefined,
        analyze: () => undefined,
        generate: () => undefined,
        componentBuild: (build) => {
            received.push(build);
        },
    }).parseAsync(args, { from: 'user' });
    expect(received).toHaveLength(1);
    return { build: received[0], stdio: spawnOptions.stdio };
}

it('passes every build option through to the CLI component build', async () => {
    const { build, stdio } = await cliBuildFor({
        workspaceRoot: '/plugin',
        bundle: '/plugin/build/plugin.ts',
        witDir: '/plugin/build/wit',
        output: '/plugin/build/plugin.wasm',
        developmentMode: true,
        parseTypeScript: true,
        runtimeVariant: 'full',
        gcVariant: 'malloc',
        quietOutput: true,
        wasiImports: ['wasi:filesystem/types@0.2.3'],
        wasiMethods: ['wasi:filesystem/types@0.2.3#read-via-stream'],
        apiMethods: ['logging.log'],
        eventTypes: ['server-tick-end-event'],
    });

    expect(build).toEqual({
        workspaceRoot: path.resolve('/plugin'),
        bundle: path.resolve('/plugin/build/plugin.ts'),
        wit: path.resolve('/plugin/build/wit'),
        output: path.resolve('/plugin/build/plugin.wasm'),
        developmentMode: true,
        parseTypeScript: true,
        runtimeVariant: 'full',
        gcVariant: 'malloc',
        wasiImports: ['wasi:filesystem/types@0.2.3'],
        wasiMethods: ['wasi:filesystem/types@0.2.3#read-via-stream'],
        apiMethods: ['logging.log'],
        eventTypes: ['server-tick-end-event'],
    });
    expect(stdio).toEqual(['inherit', 'ignore', 'pipe']);
});

it('defaults to no WASI imports, leaves other selections open, and inherits output', async () => {
    const { build, stdio } = await cliBuildFor({
        bundle: '/plugin/bundle.js',
        witDir: '/plugin/wit',
        output: '/plugin/plugin.wasm',
        developmentMode: false,
    });

    expect(build).toEqual({
        bundle: path.resolve('/plugin/bundle.js'),
        wit: path.resolve('/plugin/wit'),
        output: path.resolve('/plugin/plugin.wasm'),
        developmentMode: false,
        wasiImports: [],
    });
    expect(stdio).toBe('inherit');
});
