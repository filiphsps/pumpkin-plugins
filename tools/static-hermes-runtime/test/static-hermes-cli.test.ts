import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { createStaticHermesProgram, parseJsonStringArray } from '../src/cli.ts';

const mocks = vi.hoisted(() => ({ setupToolchain: vi.fn(), execFileSync: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
    const original = await importOriginal<typeof import('node:child_process')>();
    return { ...original, execFileSync: mocks.execFileSync };
});
vi.mock('../src/hermes/toolchain-environment.ts', () => ({
    setupHermesToolchainEnvironment: mocks.setupToolchain
}));

const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageManifest = JSON.parse(readFileSync(path.join(runtimeRoot, 'package.json'), 'utf8')) as {
    bin: { 'static-hermes-runtime': string };
    files: string[];
};
const cli = path.join(runtimeRoot, packageManifest.bin['static-hermes-runtime']);

it('runs the compiled CLI advertised by the package', () => {
    expect(packageManifest.bin['static-hermes-runtime']).toBe('dist/cli.js');
    expect(packageManifest.files).toContain('src/**/*.ts');
    expect(packageManifest.files).toContain('!src/**/*.test.ts');
    expect(packageManifest.files).toContain('!src/**/*.spec.ts');
    expect(packageManifest.files).toContain('src/**/*.template');
    expect(packageManifest.files).not.toContain('src');
    expect(packageManifest.files).toContain('dist');
    expect(packageManifest.files).not.toContain('bin');
    expect(packageManifest.files).not.toContain('native');

    const result = spawnSync(
        process.execPath,
        [path.join(runtimeRoot, packageManifest.bin['static-hermes-runtime']), '--help'],
        {
            cwd: runtimeRoot,
            encoding: 'utf8'
        }
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Prepare and build Pumpkin Static Hermes components');
});

it.skipIf(process.platform === 'win32')('runs the CLI through an installed package bin symlink', () => {
    const consumerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-cli-consumer-'));
    const packageDirectory = path.join(consumerRoot, 'node_modules', '@pumpkin-plugins', 'static-hermes-runtime');
    const binDirectory = path.join(consumerRoot, 'node_modules', '.bin');
    fs.mkdirSync(path.dirname(packageDirectory), { recursive: true });
    fs.mkdirSync(binDirectory, { recursive: true });
    fs.symlinkSync(runtimeRoot, packageDirectory, 'dir');

    const installedBin = path.join(binDirectory, 'static-hermes-runtime');
    fs.symlinkSync(
        path.relative(binDirectory, path.join(packageDirectory, packageManifest.bin['static-hermes-runtime'])),
        installedBin,
        'file'
    );

    try {
        const result = spawnSync(process.execPath, [installedBin, '--help'], {
            cwd: consumerRoot,
            encoding: 'utf8'
        });

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Prepare and build Pumpkin Static Hermes components');
    } finally {
        fs.rmSync(consumerRoot, { recursive: true, force: true });
    }
});

it('runs the compiled CLI through pnpm exec in the monorepo', () => {
    const result = spawnSync('pnpm', ['exec', 'static-hermes-runtime', '--help'], {
        cwd: runtimeRoot,
        encoding: 'utf8'
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Prepare and build Pumpkin Static Hermes components');
});

it.each([
    { args: ['--help'], requiredOptions: ['hermes', 'codegen', 'component'] },
    { args: ['hermes', '--help'], requiredOptions: ['source', 'patch', 'build', 'prepare'] },
    { args: ['codegen', '--help'], requiredOptions: ['analyze', 'generate'] },
    { args: ['component', '--help'], requiredOptions: ['build'] },
    { args: ['hermes', 'source', '--help'], requiredOptions: ['STATIC_HERMES_SOURCE_DIR'] },
    {
        args: ['codegen', 'analyze', '--help'],
        requiredOptions: ['--wit <dir>', '--wasi-imports <json-array>']
    },
    {
        args: ['codegen', 'generate', '--help'],
        requiredOptions: ['--wit <dir>', '--template <file>', '--header <file>', '--out-dir <dir>']
    },
    {
        args: ['component', 'build', '--help'],
        requiredOptions: [
            '--bundle <file>',
            '--wit <dir>',
            '--output <file>',
            '--workspace-root <dir>',
            '--development-mode',
            '--runtime-variant'
        ]
    }
])('documents $args command', ({ args, requiredOptions }) => {
    const result = run(...args);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatchSnapshot();
    for (const option of requiredOptions) expect(result.stdout).toContain(option);
});

function run(...args: string[]) {
    return spawnSync(process.execPath, [cli, ...args], {
        cwd: runtimeRoot,
        encoding: 'utf8'
    });
}

it('deduplicates JSON string arrays and rejects malformed option values', () => {
    expect(parseJsonStringArray('["a","a","b"]', 'wasi-imports', 'module specifiers')).toEqual(['a', 'b']);
    expect(() => parseJsonStringArray('{', 'wasi-imports', 'module specifiers')).toThrow(
        '--wasi-imports must be a JSON array'
    );
    expect(() => parseJsonStringArray('["a",1]', 'wasi-imports', 'module specifiers')).toThrow(
        'a JSON array of module specifiers'
    );
});

it('forwards parsed options to the selected Commander action', async () => {
    const calls: unknown[] = [];
    const program = createStaticHermesProgram({
        hermesSource: () => undefined,
        hermesPatch: () => undefined,
        hermesBuild: () => undefined,
        hermesPrepare: () => undefined,
        analyze: (options) => {
            calls.push(options);
        },
        generate: () => undefined,
        componentBuild: () => undefined
    });
    await program.parseAsync(['codegen', 'analyze', '--wit', 'wit', '--wasi-imports', '["wasi:io/poll@0.2.3"]'], {
        from: 'user'
    });

    expect(calls).toEqual([
        {
            wit: path.resolve('wit'),
            wasiImports: ['wasi:io/poll@0.2.3']
        }
    ]);
});

it('forwards generated output paths without requiring a JavaScript bundle', async () => {
    const calls: unknown[] = [];
    const program = createStaticHermesProgram({
        hermesSource: () => undefined,
        hermesPatch: () => undefined,
        hermesBuild: () => undefined,
        hermesPrepare: () => undefined,
        analyze: () => undefined,
        generate: (options) => {
            calls.push(options);
        },
        componentBuild: () => undefined
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
            'generated'
        ],
        { from: 'user' }
    );

    expect(calls).toEqual([
        {
            wit: path.resolve('wit'),
            wasiImports: [],
            template: path.resolve('runtime.cpp.in'),
            header: path.resolve('plugin.h'),
            outDir: path.resolve('generated')
        }
    ]);
});

it('forwards the consumer project root to the component build action', async () => {
    const calls: unknown[] = [];
    const program = createStaticHermesProgram({
        hermesSource: () => undefined,
        hermesPatch: () => undefined,
        hermesBuild: () => undefined,
        hermesPrepare: () => undefined,
        analyze: () => undefined,
        generate: () => undefined,
        componentBuild: (options) => {
            calls.push(options);
        }
    });
    await program.parseAsync(
        [
            'component',
            'build',
            '--bundle',
            'bundle.js',
            '--wit',
            'wit',
            '--output',
            'plugin.wasm',
            '--workspace-root',
            'consumer'
        ],
        { from: 'user' }
    );

    expect(calls).toEqual([
        {
            bundle: path.resolve('bundle.js'),
            wit: path.resolve('wit'),
            output: path.resolve('plugin.wasm'),
            workspaceRoot: path.resolve('consumer'),
            developmentMode: false,
            wasiImports: []
        }
    ]);
});

it('propagates errors from command handlers', async () => {
    const failure = new Error('analysis failed');
    const program = createStaticHermesProgram({
        hermesSource: () => undefined,
        hermesPatch: () => undefined,
        hermesBuild: () => undefined,
        hermesPrepare: () => undefined,
        analyze: () => {
            throw failure;
        },
        generate: () => undefined,
        componentBuild: () => undefined
    });

    await expect(program.parseAsync(['codegen', 'analyze', '--wit', 'wit'], { from: 'user' })).rejects.toBe(failure);
});

it('rejects a missing plugin WIT file before installing wasm-tools for codegen', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-cli-codegen-'));
    const witDirectory = path.join(root, 'wit');
    const previousWasmTools = process.env.WASM_TOOLS;
    fs.mkdirSync(witDirectory);
    delete process.env.WASM_TOOLS;
    mocks.setupToolchain.mockReset().mockResolvedValue({ WASM_TOOLS: '/toolchain/wasm-tools' });

    try {
        const program = createStaticHermesProgram();
        await expect(
            program.parseAsync(['codegen', 'analyze', '--wit', witDirectory], { from: 'user' })
        ).rejects.toThrow('Prepared WIT package has no plugin.wit');
        expect(mocks.setupToolchain).not.toHaveBeenCalled();
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        if (previousWasmTools === undefined) delete process.env.WASM_TOOLS;
        else process.env.WASM_TOOLS = previousWasmTools;
    }
});

it('rejects a codegen wasm-tools override when its pinned version is invalid', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-cli-override-'));
    const witDirectory = path.join(root, 'wit');
    const previousWasmTools = process.env.WASM_TOOLS;
    fs.mkdirSync(witDirectory);
    fs.writeFileSync(path.join(witDirectory, 'plugin.wit'), 'package example:plugin@1.0.0; world plugin {}');
    process.env.WASM_TOOLS = '/custom/wasm-tools';
    const invalidOverride = new Error('configured wasm-tools must be wasm-tools 1.261.0: wasm-tools 1.99.0');
    mocks.setupToolchain.mockReset().mockRejectedValue(invalidOverride);
    mocks.execFileSync.mockReset();

    try {
        await expect(
            createStaticHermesProgram().parseAsync(['codegen', 'analyze', '--wit', witDirectory], { from: 'user' })
        ).rejects.toBe(invalidOverride);
        expect(mocks.execFileSync).not.toHaveBeenCalled();
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        if (previousWasmTools === undefined) delete process.env.WASM_TOOLS;
        else process.env.WASM_TOOLS = previousWasmTools;
    }
});

it('uses a valid configured wasm-tools override for codegen', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-cli-valid-override-'));
    const witDirectory = path.join(root, 'wit');
    const previousWasmTools = process.env.WASM_TOOLS;
    fs.mkdirSync(witDirectory);
    fs.writeFileSync(path.join(witDirectory, 'plugin.wit'), 'package example:plugin@1.0.0; world plugin {}');
    process.env.WASM_TOOLS = '/custom/wasm-tools';
    mocks.setupToolchain.mockReset().mockResolvedValue({ WASM_TOOLS: '/custom/wasm-tools' });
    mocks.execFileSync.mockReset().mockReturnValue(
        JSON.stringify({
            worlds: [{ name: 'plugin', package: 0, imports: {} }],
            interfaces: [],
            types: [],
            packages: [{ name: 'example:plugin@1.0.0', interfaces: {}, worlds: { plugin: 0 } }]
        })
    );

    try {
        await createStaticHermesProgram().parseAsync(['codegen', 'analyze', '--wit', witDirectory], { from: 'user' });

        expect(mocks.execFileSync).toHaveBeenCalledWith(
            '/custom/wasm-tools',
            ['component', 'wit', witDirectory, '--json', '--all-features'],
            expect.objectContaining({ encoding: 'utf8' })
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        if (previousWasmTools === undefined) delete process.env.WASM_TOOLS;
        else process.env.WASM_TOOLS = previousWasmTools;
    }
});

it('analyzes a WIT package without requiring or reading a JavaScript bundle', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-cli-without-bundle-'));
    const witDirectory = path.join(root, 'wit');
    const previousWasmTools = process.env.WASM_TOOLS;
    fs.mkdirSync(witDirectory);
    fs.writeFileSync(path.join(witDirectory, 'plugin.wit'), 'package example:plugin@1.0.0; world plugin {}');
    process.env.WASM_TOOLS = '/custom/wasm-tools';
    mocks.setupToolchain.mockReset().mockResolvedValue({ WASM_TOOLS: '/custom/wasm-tools' });
    mocks.execFileSync.mockReset().mockReturnValue(
        JSON.stringify({
            worlds: [{ name: 'plugin', package: 0, imports: {} }],
            interfaces: [],
            types: [],
            packages: [{ name: 'example:plugin@1.0.0', interfaces: {}, worlds: { plugin: 0 } }]
        })
    );
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
        await createStaticHermesProgram().parseAsync(['codegen', 'analyze', '--wit', witDirectory], { from: 'user' });
        const logged = output.mock.calls[0]?.[0];
        expect(typeof logged).toBe('string');
        if (typeof logged !== 'string') throw new Error('codegen analyze did not print its WIT analysis');
        expect(JSON.parse(logged)).toMatchObject({ apiInterfaces: [], apiMethods: [], eventFields: [] });
    } finally {
        output.mockRestore();
        fs.rmSync(root, { recursive: true, force: true });
        if (previousWasmTools === undefined) delete process.env.WASM_TOOLS;
        else process.env.WASM_TOOLS = previousWasmTools;
    }
});

it('uses the consumer working directory for codegen tool setup', async () => {
    const consumerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-cli-consumer-'));
    const witDirectory = path.join(consumerRoot, 'wit');
    const originalWorkingDirectory = process.cwd();
    const previousWasmTools = process.env.WASM_TOOLS;
    fs.mkdirSync(witDirectory);
    fs.writeFileSync(path.join(witDirectory, 'plugin.wit'), 'package example:plugin@1.0.0; world plugin {}');
    process.chdir(consumerRoot);
    const expectedWorkspaceRoot = process.cwd();
    delete process.env.WASM_TOOLS;
    mocks.setupToolchain.mockReset().mockResolvedValue({ WASM_TOOLS: '/toolchain/wasm-tools' });
    mocks.execFileSync.mockReset().mockReturnValue(
        JSON.stringify({
            worlds: [{ name: 'plugin', package: 0, imports: {} }],
            interfaces: [],
            types: [],
            packages: [{ name: 'example:plugin@1.0.0', interfaces: {}, worlds: { plugin: 0 } }]
        })
    );

    try {
        await createStaticHermesProgram().parseAsync(['codegen', 'analyze', '--wit', witDirectory], { from: 'user' });

        const setupOptions = mocks.setupToolchain.mock.calls[0]?.[0];
        expect(setupOptions?.workspaceRoot).toBe(expectedWorkspaceRoot);
        expect(setupOptions?.includeWasiSdk).toBe(false);
        expect(setupOptions?.includeWitBindgen).toBe(false);
        expect(setupOptions?.includeWasmTools).toBe(true);
    } finally {
        process.chdir(originalWorkingDirectory);
        fs.rmSync(consumerRoot, { recursive: true, force: true });
        if (previousWasmTools === undefined) delete process.env.WASM_TOOLS;
        else process.env.WASM_TOOLS = previousWasmTools;
    }
});

it('reports missing paths, unknown commands, and unknown options as CLI errors', async () => {
    const missing = run('codegen', 'analyze');
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("required option '--wit <dir>' not specified");

    const command = run('hermes', 'unknown');
    expect(command.status).toBe(1);
    expect(command.stderr).toContain("unknown command 'unknown'");

    const unknown = run('hermes', 'source', '--unknown');
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("unknown option '--unknown'");
});
