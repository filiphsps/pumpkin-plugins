import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createStaticHermesProgram, parseJsonStringArray, type StaticHermesCliDependencies } from './cli.ts';

const mocks = vi.hoisted(() => ({ setupToolchain: vi.fn(), execFileSync: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
    const original = await importOriginal<typeof import('node:child_process')>();
    return { ...original, execFileSync: mocks.execFileSync };
});
vi.mock('./hermes/toolchain-environment.ts', () => ({
    setupHermesToolchainEnvironment: mocks.setupToolchain,
}));

const emptyPluginWit = 'package example:plugin@1.0.0; world plugin {}';
const emptyWitGraph = JSON.stringify({
    worlds: [{ name: 'plugin', package: 0, imports: {} }],
    interfaces: [],
    types: [],
    packages: [{ name: 'example:plugin@1.0.0', interfaces: {}, worlds: { plugin: 0 } }],
});
const directories: string[] = [];

afterEach(() => {
    vi.unstubAllEnvs();
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

/** Build the CLI with no-op handlers, replacing only the handlers a test observes. */
function programWith(overrides: Partial<StaticHermesCliDependencies>) {
    return createStaticHermesProgram({
        hermesSource: () => undefined,
        hermesPatch: () => undefined,
        hermesBuild: () => undefined,
        hermesPrepare: () => undefined,
        analyze: () => undefined,
        generate: () => undefined,
        componentBuild: () => undefined,
        ...overrides,
    });
}

/** Create a temporary WIT directory, optionally with a plugin world. */
function witFixture(prefix: string, pluginWit?: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    directories.push(root);
    const witDirectory = path.join(root, 'wit');
    fs.mkdirSync(witDirectory);
    if (pluginWit !== undefined) fs.writeFileSync(path.join(witDirectory, 'plugin.wit'), pluginWit);
    return witDirectory;
}
it('deduplicates JSON string arrays and rejects malformed option values', () => {
    expect(parseJsonStringArray('["a","a","b"]', 'wasi-imports', 'module specifiers')).toEqual(['a', 'b']);
    expect(() => parseJsonStringArray('{', 'wasi-imports', 'module specifiers')).toThrow(
        '--wasi-imports must be a JSON array',
    );
    expect(() => parseJsonStringArray('["a",1]', 'wasi-imports', 'module specifiers')).toThrow(
        'a JSON array of module specifiers',
    );
});

it('forwards parsed options to the selected Commander action', async () => {
    const calls: unknown[] = [];
    const program = programWith({
        analyze: (options) => {
            calls.push(options);
        },
    });
    await program.parseAsync(
        [
            'codegen',
            'analyze',
            '--wit',
            'wit',
            '--wasi-imports',
            '["wasi:io/poll@0.2.3"]',
            '--event-types',
            '["server-tick-end-event"]',
        ],
        { from: 'user' },
    );

    expect(calls).toEqual([
        {
            wit: path.resolve('wit'),
            wasiImports: ['wasi:io/poll@0.2.3'],
            eventTypes: ['server-tick-end-event'],
        },
    ]);
});

it('forwards generated output paths without requiring a JavaScript bundle', async () => {
    const calls: unknown[] = [];
    const program = programWith({
        generate: (options) => {
            calls.push(options);
        },
    });
    await program.parseAsync(
        [
            'codegen',
            'generate',
            '--wit',
            'wit',
            '--template',
            'runtime.cpp.in',
            '--header',
            'plugin.h',
            '--out-dir',
            'generated',
        ],
        { from: 'user' },
    );

    expect(calls).toEqual([
        {
            wit: path.resolve('wit'),
            wasiImports: [],
            template: path.resolve('runtime.cpp.in'),
            header: path.resolve('plugin.h'),
            outDir: path.resolve('generated'),
        },
    ]);
});

it('forwards the consumer project root to the component build action', async () => {
    const calls: unknown[] = [];
    const program = programWith({
        componentBuild: (options) => {
            calls.push(options);
        },
    });
    await program.parseAsync(
        [
            'component',
            'build',
            '--bundle',
            'bundle.ts',
            '--wit',
            'wit',
            '--output',
            'plugin.wasm',
            '--workspace-root',
            'consumer',
            '--parse-ts',
            '--gc-variant',
            'malloc',
            '--event-types',
            '["server-tick-end-event"]',
        ],
        { from: 'user' },
    );

    expect(calls).toEqual([
        {
            bundle: path.resolve('bundle.ts'),
            wit: path.resolve('wit'),
            output: path.resolve('plugin.wasm'),
            workspaceRoot: path.resolve('consumer'),
            developmentMode: false,
            parseTypeScript: true,
            gcVariant: 'malloc',
            wasiImports: [],
            eventTypes: ['server-tick-end-event'],
        },
    ]);
});

it('propagates errors from command handlers', async () => {
    const failure = new Error('analysis failed');
    const program = programWith({
        analyze: () => {
            throw failure;
        },
    });

    await expect(program.parseAsync(['codegen', 'analyze', '--wit', 'wit'], { from: 'user' })).rejects.toBe(failure);
});

it('rejects a missing plugin WIT file before installing wasm-tools for codegen', async () => {
    const witDirectory = witFixture('static-hermes-cli-codegen-');
    vi.stubEnv('WASM_TOOLS', undefined);
    mocks.setupToolchain.mockReset().mockResolvedValue({ WASM_TOOLS: '/toolchain/wasm-tools' });

    await expect(
        createStaticHermesProgram().parseAsync(['codegen', 'analyze', '--wit', witDirectory], { from: 'user' }),
    ).rejects.toThrow('Prepared WIT package has no plugin.wit');
    expect(mocks.setupToolchain).not.toHaveBeenCalled();
});

it('rejects a codegen wasm-tools override when its pinned version is invalid', async () => {
    const witDirectory = witFixture('static-hermes-cli-override-', emptyPluginWit);
    vi.stubEnv('WASM_TOOLS', '/custom/wasm-tools');
    const invalidOverride = new Error('configured wasm-tools must be wasm-tools 1.261.0: wasm-tools 1.99.0');
    mocks.setupToolchain.mockReset().mockRejectedValue(invalidOverride);
    mocks.execFileSync.mockReset();

    await expect(
        createStaticHermesProgram().parseAsync(['codegen', 'analyze', '--wit', witDirectory], { from: 'user' }),
    ).rejects.toBe(invalidOverride);
    expect(mocks.execFileSync).not.toHaveBeenCalled();
});

it('uses a valid configured wasm-tools override for codegen', async () => {
    const witDirectory = witFixture('static-hermes-cli-valid-override-', emptyPluginWit);
    vi.stubEnv('WASM_TOOLS', '/custom/wasm-tools');
    mocks.setupToolchain.mockReset().mockResolvedValue({ WASM_TOOLS: '/custom/wasm-tools' });
    mocks.execFileSync.mockReset().mockReturnValue(emptyWitGraph);

    await createStaticHermesProgram().parseAsync(['codegen', 'analyze', '--wit', witDirectory], { from: 'user' });

    expect(mocks.execFileSync).toHaveBeenCalledWith(
        '/custom/wasm-tools',
        ['component', 'wit', witDirectory, '--json', '--all-features'],
        expect.objectContaining({ encoding: 'utf8' }),
    );
});

it('analyzes a WIT package without requiring or reading a JavaScript bundle', async () => {
    const witDirectory = witFixture('static-hermes-cli-without-bundle-', emptyPluginWit);
    vi.stubEnv('WASM_TOOLS', '/custom/wasm-tools');
    mocks.setupToolchain.mockReset().mockResolvedValue({ WASM_TOOLS: '/custom/wasm-tools' });
    mocks.execFileSync.mockReset().mockReturnValue(emptyWitGraph);
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
        await createStaticHermesProgram().parseAsync(['codegen', 'analyze', '--wit', witDirectory], { from: 'user' });
        const logged = output.mock.calls[0]?.[0];
        expect(typeof logged).toBe('string');
        if (typeof logged !== 'string') throw new Error('codegen analyze did not print its WIT analysis');
        expect(JSON.parse(logged)).toMatchObject({ apiInterfaces: [], apiMethods: [], eventFields: [] });
    } finally {
        output.mockRestore();
    }
});

it('uses the consumer working directory for codegen tool setup', async () => {
    const witDirectory = witFixture('static-hermes-cli-consumer-', emptyPluginWit);
    const originalWorkingDirectory = process.cwd();
    process.chdir(path.dirname(witDirectory));
    const expectedWorkspaceRoot = process.cwd();
    vi.stubEnv('WASM_TOOLS', undefined);
    mocks.setupToolchain.mockReset().mockResolvedValue({ WASM_TOOLS: '/toolchain/wasm-tools' });
    mocks.execFileSync.mockReset().mockReturnValue(emptyWitGraph);

    try {
        await createStaticHermesProgram().parseAsync(['codegen', 'analyze', '--wit', witDirectory], { from: 'user' });

        const setupOptions = mocks.setupToolchain.mock.calls[0]?.[0];
        expect(setupOptions?.workspaceRoot).toBe(expectedWorkspaceRoot);
        expect(setupOptions?.includeWasiSdk).toBe(false);
        expect(setupOptions?.includeWitBindgen).toBe(false);
        expect(setupOptions?.includeWasmTools).toBe(true);
    } finally {
        process.chdir(originalWorkingDirectory);
    }
});
