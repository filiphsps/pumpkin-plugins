import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const c8 = require.resolve('c8/bin/c8.js');
const config = path.resolve(import.meta.dirname, '../coverage.config.json');
const evidence = path.resolve(import.meta.dirname, '../coverage/verification/process-coverage');

test('runs the script and action suites after a package suite fails, and still fails the run', () => {
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pumpkin-coverage-collect-')));
    try {
        fs.mkdirSync(path.join(cwd, 'scripts'));
        fs.copyFileSync(path.join(import.meta.dirname, 'coverage.mjs'), path.join(cwd, 'scripts/coverage.mjs'));
        fs.mkdirSync(path.join(cwd, 'coverage/process'), { recursive: true });
        fs.mkdirSync(path.join(cwd, 'actions/demo/src'), { recursive: true });
        fs.writeFileSync(
            path.join(cwd, 'actions/demo/src/demo.test.mjs'),
            "import { test } from 'node:test';\ntest('passes', () => {});\n",
        );
        // A stand-in pnpm: one package's coverage task fails, the repository script tests pass.
        fs.mkdirSync(path.join(cwd, 'bin'));
        fs.writeFileSync(
            path.join(cwd, 'bin/pnpm'),
            '#!/bin/sh\nif [ "$1" = turbo ]; then echo "package suite failed" >&2; exit 3; fi\nexit 0\n',
            { mode: 0o755 },
        );

        const collect = spawnSync(process.execPath, ['scripts/coverage.mjs', '--collect'], {
            cwd,
            encoding: 'utf8',
            env: { ...process.env, PATH: `${path.join(cwd, 'bin')}${path.delimiter}${process.env.PATH}` },
        });

        assert.equal(collect.status, 3, 'the run must fail with the failing suite exit code');
        const { commands } = JSON.parse(fs.readFileSync(path.join(cwd, 'coverage/process/run.json'), 'utf8'));
        assert.deepEqual(
            commands.map(({ command, exitCode }) => [command.slice(0, 4).join(' '), exitCode]),
            [
                ['pnpm turbo run test:coverage', 3],
                ['pnpm test:scripts', 0],
                [`${process.execPath} --test actions/demo/src/demo.test.mjs`, 0],
            ],
        );
        assert.ok(
            commands[0].command.some((arg) => /^--continue(?:=|$)/.test(arg)),
            'Turbo must keep running the other packages after one fails',
        );
    } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
    }
});

test('process coverage includes child-only TypeScript, keeps unvisited source, and rejects failed runs', () => {
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pumpkin-process-coverage-')));
    const source = path.join(cwd, 'tools/fixture/src');
    fs.mkdirSync(source, { recursive: true });
    fs.rmSync(evidence, { recursive: true, force: true });
    fs.mkdirSync(evidence, { recursive: true });
    fs.writeFileSync(path.join(cwd, 'package.json'), '{"type":"module"}');
    fs.writeFileSync(path.join(source, 'child.ts'), 'const value: number = 42;\nconsole.log(value);\n');
    fs.writeFileSync(path.join(source, 'unvisited.ts'), 'export const missed: number = 7;\n');
    const vendor = path.join(cwd, 'tools/fixture/.cache/vendor/src');
    fs.mkdirSync(vendor, { recursive: true });
    fs.writeFileSync(path.join(vendor, 'dependency.ts'), 'export const downloaded: number = 9;\n');
    fs.writeFileSync(
        path.join(cwd, 'parent.mjs'),
        "import { spawnSync } from 'node:child_process';\n" +
            "const child = spawnSync(process.execPath, ['src/child.ts'], { cwd: 'tools/fixture', stdio: 'inherit' });\n" +
            'process.exitCode = child.status;\n',
    );
    const args = [
        c8,
        '--config',
        config,
        '--src',
        'tools',
        '--reports-dir',
        path.join(cwd, 'report'),
        '--temp-directory',
        path.join(cwd, 'raw'),
    ];
    try {
        const success = spawnSync(process.execPath, [...args, process.execPath, 'parent.mjs'], {
            cwd,
            encoding: 'utf8',
        });
        assert.equal(success.status, 0, success.stderr);
        const report = JSON.parse(fs.readFileSync(path.join(cwd, 'report/coverage-final.json'), 'utf8'));
        const child = report[path.join(source, 'child.ts')];
        const unvisited = report[path.join(source, 'unvisited.ts')];
        assert.ok(
            child,
            `child-only TypeScript must appear under its source path: ${JSON.stringify(Object.keys(report))}`,
        );
        assert.ok(
            Object.values(child.s).some((hits) => hits > 0),
            'child execution must contribute hits',
        );
        assert.ok(unvisited, 'unexecuted source must remain in the denominator');
        assert.ok(Object.values(unvisited.s).every((hits) => hits === 0));
        assert.ok(
            !report[path.join(vendor, 'dependency.ts')],
            'downloaded third-party caches are not repository source',
        );
        fs.copyFileSync(path.join(cwd, 'report/lcov.info'), path.join(evidence, 'child.lcov.info'));

        const failure = spawnSync(process.execPath, [...args, process.execPath, '-e', 'process.exitCode = 23'], {
            cwd,
            encoding: 'utf8',
        });
        assert.equal(failure.status, 23, 'coverage must preserve a failing test process exit code');
        const failedReport = JSON.parse(fs.readFileSync(path.join(cwd, 'report/coverage-final.json'), 'utf8'));
        assert.ok(
            Object.values(failedReport[path.join(source, 'child.ts')].s).every((hits) => hits === 0),
            'a fresh run must not reuse earlier child hits',
        );
        fs.writeFileSync(
            path.join(evidence, 'result.json'),
            JSON.stringify(
                {
                    command: 'pnpm exec node --test scripts/coverage.test.mjs',
                    childHits: child.s,
                    unvisitedHits: unvisited.s,
                    failureExit: failure.status,
                },
                null,
                2,
            ),
        );
    } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
    }
});
