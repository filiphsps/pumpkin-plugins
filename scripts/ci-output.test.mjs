import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, it } from 'node:test';
import { parse } from 'yaml';
import { requiredEnvironment, setOutput } from './utils/ci-output.mjs';

const temporaryDirectories = [];
afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-output-'));
    temporaryDirectories.push(directory);
    const summary = path.join(directory, 'summary.md');
    const env = {
        ...process.env,
        GITHUB_STEP_SUMMARY: summary,
        PUMPKIN_CI_OUTPUT_DIR: path.join(directory, 'reports'),
    };
    return { directory, summary, env };
}

function run(script, args, env) {
    return spawnSync(process.execPath, [path.join(import.meta.dirname, script), ...args], { env, encoding: 'utf8' });
}

const passingReport = `## Vitest Test Report

### Summary

- **Test Files**: ✅ **2 passes** · 2 total
- **Test Results**: ✅ **8 passes** · 🔵 **1 expected failure** · 9 total
- **Other**: 2 skips · 1 todo · 3 total
`;

it('combines package reports once, keeps annotations in logs, and preserves command exit codes', () => {
    const { summary, env } = fixture();
    const command = `console.log('::error file=src/example.ts,line=3::failure detail');
        require('node:fs').appendFileSync(process.env.GITHUB_STEP_SUMMARY, ${JSON.stringify(passingReport.repeat(2))});
        process.exit(7);`;
    const result = run('ci-run.mjs', ['Unit tests', '--', process.execPath, '-e', command], env);
    assert.equal(result.status, 7, result.stderr);
    assert.match(result.stdout, /::error file=src\/example.ts,line=3::failure detail/);
    assert.equal(fs.existsSync(summary), false, 'child reports must not leak into the job summary');

    const rendered = run('ci-summary.mjs', ['--title', 'Unit tests', '--tests'], env);
    assert.equal(rendered.status, 0, rendered.stderr);
    const markdown = fs.readFileSync(summary, 'utf8');
    assert.equal(markdown.match(/## Unit tests/g)?.length, 1);
    assert.doesNotMatch(markdown, /Vitest Test Report/);
    assert.match(markdown, /16 passed/);
    assert.match(markdown, /2 expected failures/);
    assert.match(markdown, /4 skipped/);
    assert.match(markdown, /2 todo/);
    assert.match(markdown, /Failed \(exit 7\)/);
});

it('keeps flaky-test links and unfamiliar reporter output available without inventing totals', () => {
    const { summary, env } = fixture();
    const report = `${passingReport}\n### Flaky Tests\n\n- [\`retries once\`](https://github.com/example/repo/blob/sha/test.ts#L3)\n`;
    const result = run(
        'ci-run.mjs',
        [
            'Smoke | test',
            '--',
            process.execPath,
            '-e',
            `require('node:fs').appendFileSync(process.env.GITHUB_STEP_SUMMARY, ${JSON.stringify(`${report}\n## Future reporter\nunknown statistics\n`)});`,
        ],
        env,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(run('ci-summary.mjs', ['--title', 'Integration', '--tests'], env).status, 0);
    const markdown = fs.readFileSync(summary, 'utf8');
    assert.match(markdown, /Flaky Tests/);
    assert.match(markdown, /https:\/\/github.com\/example\/repo\/blob\/sha\/test.ts#L3/);
    assert.match(markdown, /unknown statistics/);
    assert.match(markdown, /Smoke &#124; test/);
});

it('keeps build summaries focused on artifacts and records a failed command that cannot start', () => {
    const { summary, env } = fixture();
    assert.equal(
        run(
            'ci-run.mjs',
            [
                'Runtime smoke test',
                '--',
                process.execPath,
                '-e',
                `require('node:fs').appendFileSync(process.env.GITHUB_STEP_SUMMARY, ${JSON.stringify(passingReport)});`,
            ],
            env,
        ).status,
        0,
    );
    const missing = run('ci-run.mjs', ['Missing compiler', '--', 'pumpkin-ci-command-does-not-exist'], env);
    assert.notEqual(missing.status, 0);
    assert.equal(run('ci-summary.mjs', ['--title', 'Plugin build'], env).status, 0);
    const markdown = fs.readFileSync(summary, 'utf8');
    assert.match(markdown, /Runtime smoke test.*Passed/);
    assert.match(markdown, /Missing compiler.*Failed/);
    assert.doesNotMatch(markdown, /Vitest Test Report|Test Files|Test Results/);
});

it('combines the installed Vitest reporter output, including retries and expected failures', () => {
    const { directory, summary, env } = fixture();
    const require = createRequire(import.meta.url);
    const vitestDirectory = path.dirname(
        require.resolve('vitest/package.json', { paths: [path.join(import.meta.dirname, '../tools/config')] }),
    );
    fs.mkdirSync(path.join(directory, 'node_modules'));
    fs.symlinkSync(
        vitestDirectory,
        path.join(directory, 'node_modules/vitest'),
        process.platform === 'win32' ? 'junction' : 'dir',
    );
    fs.writeFileSync(
        path.join(directory, 'report.test.mjs'),
        `
        import { it, expect } from 'vitest';
        it('passes', () => expect(2 + 2).toBe(4));
        it('fails unexpectedly', () => expect(1).toBe(3));
        it.skip('is skipped', () => {});
        it.todo('is unfinished');
        it.fails('fails as expected', () => expect(1).toBe(2));
        let attempt = 0;
        it('retries once', { retry: 1 }, () => expect(++attempt).toBe(2));
    `,
    );
    const result = run(
        'ci-run.mjs',
        [
            'Reporter compatibility',
            '--',
            process.execPath,
            path.join(vitestDirectory, 'vitest.mjs'),
            'run',
            '--root',
            directory,
            '--reporter=default',
            '--reporter=github-actions',
        ],
        { ...env, CI: 'true', GITHUB_ACTIONS: 'true' },
    );
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.equal(run('ci-summary.mjs', ['--title', 'Real Vitest output', '--tests'], env).status, 0);
    const markdown = fs.readFileSync(summary, 'utf8');
    assert.match(markdown, /2 passed · 1 failed · 1 expected failure · 1 skipped · 1 todo/);
    assert.match(markdown, /retries once/);
    assert.doesNotMatch(markdown, /Vitest Test Report/);
});

it('preserves signal termination as a failing exit status', () => {
    const { summary, env } = fixture();
    const result = run(
        'ci-run.mjs',
        ['Terminated test process', '--', process.execPath, '-e', "process.kill(process.pid, 'SIGTERM')"],
        env,
    );
    assert.equal(result.status, 143, result.stderr);
    assert.equal(run('ci-summary.mjs', ['--title', 'Interrupted tests'], env).status, 0);
    assert.match(fs.readFileSync(summary, 'utf8'), /Failed \(exit 143, SIGTERM\)/);
});

it('shows cached work honestly and indexes downloadable plugin artifacts', () => {
    const { directory, summary, env } = fixture();
    const component = path.join(directory, 'sample.wasm');
    fs.writeFileSync(component, Buffer.alloc(2048));
    const manifest = path.join(directory, 'plugins.json');
    fs.writeFileSync(
        manifest,
        JSON.stringify([{ 'plugin-name': 'Sample <plugin>', version: '1.2.3', 'wasm-file': component }]),
    );
    assert.equal(run('ci-run.mjs', ['Cached tests', '--', process.execPath, '-e', ''], env).status, 0);
    const result = run('ci-summary.mjs', ['--title', 'Build and smoke tests', '--tests'], {
        ...env,
        CI_ARTIFACT_URL: 'https://github.com/example/repo/actions/runs/123/artifacts/456',
        CI_LINK_LABEL: 'Download signed plugins',
        CI_SUMMARY_NOTE: 'CI key; expires after one day.',
        CI_PLUGINS_MANIFEST: manifest,
    });
    assert.equal(result.status, 0, result.stderr);
    const markdown = fs.readFileSync(summary, 'utf8');
    assert.match(markdown, /Cached tests.*Passed.*—/);
    assert.match(markdown, /Download signed plugins/);
    assert.match(markdown, /Sample &lt;plugin&gt;.*1\.2\.3.*2\.0 KiB.*sample\.wasm/);
    assert.match(markdown, /expires after one day/);
    assert.doesNotMatch(markdown, /0 passed/);
});

it('keeps large Release Please outputs out of the release summary process environment', () => {
    const { summary, env } = fixture();
    const workflow = parse(fs.readFileSync(path.join(import.meta.dirname, '../.github/workflows/release.yml'), 'utf8'));
    const summaryStep = workflow.jobs.release.steps.find((step) => step.id === 'release-summary');
    const stepContext = {
        release: { outputs: { release_notes: 'x'.repeat(512 * 1024), release_count: '2' } },
        'release-prs': { outputs: { open_pr_count: '1' } },
    };
    const factsJson = summaryStep.with.facts.replace(
        /\$\{\{\s*toJSON\((steps(?:\.[\w-]+)*)\)\s*\}\}/g,
        (_match, contextPath) =>
            JSON.stringify(
                contextPath
                    .split('.')
                    .slice(1)
                    .reduce((value, key) => value?.[key], stepContext) ?? null,
            ),
    );
    assert.equal(Buffer.byteLength(factsJson) < 128 * 1024, true);
    const action = parse(
        fs.readFileSync(path.join(import.meta.dirname, '../.github/common/job-summary/action.yml'), 'utf8'),
    );
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', action.runs.steps[0].run], {
        env: {
            ...env,
            CI_SUMMARY_TITLE: 'Release orchestration',
            CI_SUMMARY_TESTS: 'false',
            CI_JOB_STATUS: 'success',
            CI_ARTIFACT_URL: '',
            CI_LINK_LABEL: 'Browse published releases and downloads',
            CI_SUMMARY_NOTE: '',
            CI_PLUGINS_MANIFEST: '',
            CI_SUMMARY_FACTS: factsJson,
            GITHUB_ACTION_PATH: path.resolve(import.meta.dirname, '../.github/common/job-summary'),
        },
        encoding: 'utf8',
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    const markdown = fs.readFileSync(summary, 'utf8');
    assert.match(markdown, /\| Release records created \| 2 \|/);
    assert.match(markdown, /\| Open release PRs \| 1 \|/);
});

it('renders the deployment summary after the Pages mirror replaces the checkout', () => {
    const { directory, summary, env } = fixture();
    const workspace = path.join(directory, 'checkout');
    fs.mkdirSync(path.join(workspace, 'scripts/utils'), { recursive: true });
    for (const file of ['ci-summary.mjs', 'utils/ci-output.mjs']) {
        fs.copyFileSync(path.join(import.meta.dirname, file), path.join(workspace, 'scripts', file));
    }
    const workflow = parse(fs.readFileSync(path.join(import.meta.dirname, '../.github/workflows/docs.yml'), 'utf8'));
    const steps = workflow.jobs.publish.steps;
    const prepared = spawnSync(
        'bash',
        ['-euo', 'pipefail', '-c', steps.find((step) => step.id === 'preserve-deployment-summary-tools').run],
        {
            cwd: workspace,
            env: { ...env, RUNNER_TEMP: directory },
            encoding: 'utf8',
        },
    );
    assert.equal(prepared.status, 0, prepared.stderr);
    fs.rmSync(workspace, { recursive: true });
    const rendered = spawnSync(
        'bash',
        ['-euo', 'pipefail', '-c', steps.find((step) => step.id === 'job-summary').run],
        {
            cwd: directory,
            env: {
                ...env,
                RUNNER_TEMP: directory,
                CI_JOB_STATUS: 'success',
                CI_ARTIFACT_URL: 'https://example.github.io/docs/',
                CI_LINK_LABEL: 'Open the published documentation',
            },
            encoding: 'utf8',
        },
    );
    assert.equal(rendered.status, 0, rendered.stderr);
    assert.match(
        fs.readFileSync(summary, 'utf8'),
        /\[Open the published documentation\]\(https:\/\/example.github.io\/docs\/\)/,
    );
});

it('writes step outputs that keep line breaks and equals signs inside their values', () => {
    const { directory } = fixture();
    const outputFile = path.join(directory, 'output');
    const previous = process.env.GITHUB_OUTPUT;
    process.env.GITHUB_OUTPUT = outputFile;
    try {
        setOutput('report', 'first line\nsecond=line');
        setOutput('url', 'https://example.test/chart.svg');
    } finally {
        if (previous === undefined) delete process.env.GITHUB_OUTPUT;
        else process.env.GITHUB_OUTPUT = previous;
    }

    // Read the file the way the runner does: `name<<delimiter`, value lines, then the delimiter.
    const outputs = Object.fromEntries(
        [...fs.readFileSync(outputFile, 'utf8').matchAll(/^([\w-]+)<<(.+)\n([\s\S]*?)\n\2$/gm)].map(
            ([, name, , value]) => [name, value],
        ),
    );
    assert.deepEqual(outputs, { report: 'first line\nsecond=line', url: 'https://example.test/chart.svg' });

    delete process.env.GITHUB_OUTPUT;
    try {
        assert.throws(() => setOutput('report', 'value'), /GITHUB_OUTPUT is required/);
    } finally {
        if (previous !== undefined) process.env.GITHUB_OUTPUT = previous;
    }

    process.env.CI_OUTPUT_TEST_VALUE = '  value  ';
    process.env.CI_OUTPUT_TEST_BLANK = ' ';
    try {
        assert.equal(requiredEnvironment('CI_OUTPUT_TEST_VALUE'), 'value');
        assert.throws(() => requiredEnvironment('CI_OUTPUT_TEST_BLANK'), /CI_OUTPUT_TEST_BLANK is required/);
        assert.throws(() => requiredEnvironment('CI_OUTPUT_TEST_MISSING'), /CI_OUTPUT_TEST_MISSING is required/);
    } finally {
        delete process.env.CI_OUTPUT_TEST_VALUE;
        delete process.env.CI_OUTPUT_TEST_BLANK;
    }
});
