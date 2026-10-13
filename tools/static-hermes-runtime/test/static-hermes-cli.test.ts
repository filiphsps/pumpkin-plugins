import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createStaticHermesProgram, parseJsonStringArray } from '../src/cli.ts';

const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageManifest = JSON.parse(readFileSync(path.join(runtimeRoot, 'package.json'), 'utf8')) as {
    bin: { 'static-hermes-runtime': string };
    files: string[];
};
const cli = path.join(runtimeRoot, packageManifest.bin['static-hermes-runtime']);

it('runs the compiled CLI advertised by the package', () => {
    expect(packageManifest.bin['static-hermes-runtime']).toBe('dist/cli.js');
    expect(packageManifest.files).toContain('src');
    expect(packageManifest.files).toContain('dist');
    expect(packageManifest.files).not.toContain('bin');

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
        requiredOptions: ['--wit <dir>', '--bundle <file>', '--wasi-imports <json-array>']
    },
    {
        args: ['codegen', 'generate', '--help'],
        requiredOptions: ['--wit <dir>', '--bundle <file>', '--template <file>', '--header <file>', '--out-dir <dir>']
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
    await program.parseAsync(
        ['codegen', 'analyze', '--wit', 'wit', '--bundle', 'plugin.js', '--wasi-imports', '["wasi:io/poll@0.2.3"]'],
        { from: 'user' }
    );

    expect(calls).toEqual([
        {
            wit: path.resolve('wit'),
            bundle: path.resolve('plugin.js'),
            wasiImports: ['wasi:io/poll@0.2.3']
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

    await expect(
        program.parseAsync(['codegen', 'analyze', '--wit', 'wit', '--bundle', 'plugin.js'], { from: 'user' })
    ).rejects.toBe(failure);
});

it('reports missing paths, unknown commands, and unknown options as CLI errors', async () => {
    const missing = run('codegen', 'analyze', '--bundle', 'plugin.js');
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("required option '--wit <dir>' not specified");

    const command = run('hermes', 'unknown');
    expect(command.status).toBe(1);
    expect(command.stderr).toContain("unknown command 'unknown'");

    const unknown = run('hermes', 'source', '--unknown');
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("unknown option '--unknown'");
});
