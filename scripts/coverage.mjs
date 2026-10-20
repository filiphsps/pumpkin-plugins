import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, 'coverage/process');
const manifestFile = path.join(directory, 'run.json');

function run(command, args) {
    const startedAt = new Date().toISOString();
    const result = spawnSync(command, args, {
        cwd: root,
        stdio: 'inherit',
        shell: process.platform === 'win32' && command === 'pnpm',
    });
    if (result.error) console.error(result.error.message);
    const exitCode = result.status ?? 1;
    const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : { commands: [] };
    manifest.commands.push({ command: [command, ...args], startedAt, exitCode, signal: result.signal });
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    return exitCode;
}

if (process.argv[2] === '--collect') {
    // Turbo must execute tests: cached LCOV does not contain raw coverage from their child processes.
    // Every suite runs even after one fails, so one failure doesn't hide the others; the first
    // failure's exit code fails the run. Turbo skips only the tasks whose own dependencies failed.
    const exitCodes = [
        run('pnpm', [
            'turbo',
            'run',
            'test:coverage',
            '--force',
            '--output-logs=errors-only',
            '--continue=dependencies-successful',
        ]),
        run('pnpm', ['test:scripts']),
        run(process.execPath, ['--test', ...fs.globSync('actions/*/src/*.test.mjs', { cwd: root })]),
    ];
    process.exitCode = exitCodes.find((code) => code !== 0) ?? 0;
} else {
    fs.rmSync(directory, { recursive: true, force: true });
    fs.mkdirSync(directory, { recursive: true });
    const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
    fs.writeFileSync(
        manifestFile,
        `${JSON.stringify({ revision: revision.stdout.trim(), node: process.version, command: 'pnpm coverage', commands: [] }, null, 2)}\n`,
    );
    process.exitCode = run('pnpm', [
        'exec',
        'c8',
        '--config',
        'coverage.config.json',
        '--temp-directory',
        path.join(directory, 'raw'),
        process.execPath,
        fileURLToPath(import.meta.url),
        '--collect',
    ]);
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    manifest.artifacts = {};
    for (const name of ['lcov.info', 'coverage-final.json', 'index.html']) {
        const file = path.join(directory, name);
        if (fs.existsSync(file))
            manifest.artifacts[name] = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        else process.exitCode ||= 1;
    }
    manifest.exitCode = process.exitCode;
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
}
