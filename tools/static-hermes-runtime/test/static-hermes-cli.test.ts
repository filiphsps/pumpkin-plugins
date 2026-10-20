import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageManifest = JSON.parse(readFileSync(path.join(runtimeRoot, 'package.json'), 'utf8')) as {
    bin: { 'static-hermes-runtime': string };
};
const cli = path.join(runtimeRoot, packageManifest.bin['static-hermes-runtime']);

it('runs the compiled CLI advertised by the package', () => {
    const result = run('--help');

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
        'file',
    );

    try {
        const result = spawnSync(process.execPath, [installedBin, '--help'], {
            cwd: consumerRoot,
            encoding: 'utf8',
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
        encoding: 'utf8',
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
        requiredOptions: ['--wit <dir>', '--wasi-imports <json-array>', '--event-types <json-array>'],
    },
    {
        args: ['codegen', 'generate', '--help'],
        requiredOptions: ['--wit <dir>', '--template <file>', '--header <file>', '--out-dir <dir>'],
    },
    {
        args: ['component', 'build', '--help'],
        requiredOptions: [
            '--bundle <file>',
            '--wit <dir>',
            '--output <file>',
            '--workspace-root <dir>',
            '--development-mode',
            '--parse-ts',
            '--event-types <json-array>',
            '--runtime-variant',
            '--gc-variant',
        ],
    },
])('documents $args command', ({ args, requiredOptions }) => {
    const result = run(...args);

    expect(result.status).toBe(0);
    for (const option of requiredOptions) expect(result.stdout).toContain(option);
});

function run(...args: string[]) {
    return spawnSync(process.execPath, [cli, ...args], {
        cwd: runtimeRoot,
        encoding: 'utf8',
    });
}

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
