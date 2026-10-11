import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';

// This repository-level contract uses the root's declared workflow parser.
const require = createRequire(resolve(import.meta.dirname, '../../../package.json'));
const { parse } = require('yaml') as typeof import('yaml');
interface Step {
    id?: string;
    name?: string;
    run?: string;
    uses?: string;
    env?: Record<string, string>;
    if?: string;
}
interface Job {
    if: string;
    'runs-on': string;
    needs: string[];
    steps: Step[];
    permissions: Record<string, string>;
}
const workflow = parse(readFileSync(resolve(import.meta.dirname, '../../../.github/workflows/ci.yml'), 'utf8')) as {
    jobs: Record<string, Job>;
};
const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});
function job() {
    const job = workflow.jobs['runtime-provenance'];
    expect(job, 'CI must verify runtime provenance independently').toBeDefined();
    return job;
}

describe('runtime provenance CI', () => {
    it('uses the measured host, pinned SDK archive and two isolated builds without write permissions', () => {
        const configured = job();
        expect(configured['runs-on']).toBe('macos-15');
        expect(configured.permissions).toEqual({ contents: 'read' });
        expect(configured.needs).toEqual(['changes']);
        const build = configured.steps.find((step) => step.id === 'verify');
        expect(build?.if).toBe("steps.scope.outputs.required == 'true'");
        expect(build?.run).toContain('rustup toolchain install 1.99.0');
        expect(build?.run).toContain('9c59398106b417f8f14913380fdf0097a8cc0ff4af9eb3ce0065a859e88d49e9');
        expect(build?.run).toContain('shasum -a 256 -c');
        expect(build?.run).toContain('for attempt in a b');
        expect(build?.run).toContain('tools/build/runtime/build.sh');
        expect(build?.run).toContain('provenance.mjs verify');
        expect(build?.run).toContain('provenance.mjs verify-candidate');
        expect(build?.run).toContain('cmp -s');
        expect(build?.run).not.toMatch(/git push|GH_TOKEN|secrets\./);
    });
    it('loads the matching candidate runtime in real Pumpkin integration tests', () => {
        const configured = job();
        expect(configured.steps.some((step) => step.uses === './.github/common/bootstrap')).toBe(true);
        const integration = configured.steps.find((step) => step.id === 'integration');
        expect(integration?.run).toContain('candidate-a/quickjs-runtime-bigint.wasm');
        expect(integration?.run).toContain('tools/build/runtime/quickjs-runtime-bigint.wasm');
        expect(integration?.run).toContain('pnpm exec turbo run test:integration');
        expect(integration?.run).toContain('--force');
        for (const plugin of [
            'apple-skin-pumpkin',
            'bedrock-addon-manager',
            'distant-horizons-support-pumpkin',
            'dynamic-lights-pumpkin',
            'upnpumpkin',
            'waypoints'
        ]) {
            expect(integration?.run).toContain(`@pumpkin-plugins/${plugin}`);
        }
        expect(integration?.env?.PUMPKIN_TEST_LOG_DIR).toContain('pumpkin-logs');
        expect(configured.steps.some((step) => step.uses === 'actions/upload-artifact@v7.0.2')).toBe(true);
    });
    it.each(['success', 'failure', 'cancelled', 'skipped'])(
        'permits a code release only after runtime verification: %s',
        (result) => {
            const release = workflow.jobs.release;
            expect(release.needs).toContain('runtime-provenance');
            const needs = {
                changes: { result: 'success', outputs: { code: 'true', actions: '[]' } },
                docs: { result: 'success' },
                build: { result: 'success' },
                test: { result: 'success' },
                integration: { result: 'success' },
                'action-gate': { result: 'success' },
                'runtime-provenance': { result }
            };
            const permitted = runInNewContext(release.if.trim().replace(/^\$\{\{|\}\}$/g, ''), {
                always: () => true,
                github: { event_name: 'push' },
                needs
            });
            expect(permitted).toBe(result === 'success');
        }
    );
    it.each([
        ['tools/build/runtime/provenance.json', true],
        ['tools/build/runtime/componentize-qjs-bigint.patch', true],
        ['tools/build/src/runtime-ci.test.ts', true],
        ['.github/workflows/ci.yml', true],
        ['packages/waypoints/src/plugin.ts', false],
        ['actions/common/src/utils.mjs', false]
    ])('selects the runtime job for %s: %s', (file, required) => {
        const script = job().steps.find((step) => step.id === 'scope')?.run;
        expect(script).toBeDefined();
        const dir = mkdtempSync(join(tmpdir(), 'runtime-ci-'));
        dirs.push(dir);
        const git = (...args: string[]) =>
            execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
        git('init', '-q');
        writeFileSync(join(dir, 'initial'), 'baseline');
        git('add', '.');
        const commit = () =>
            git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
        commit();
        const base = git('rev-parse', 'HEAD');
        mkdirSync(resolve(dir, file, '..'), { recursive: true });
        writeFileSync(join(dir, file), 'changed');
        git('add', '.');
        commit();
        const head = git('rev-parse', 'HEAD');
        const output = join(dir, 'scope-output');
        const result = spawnSync('bash', ['-e', '-c', script ?? 'exit 99'], {
            cwd: dir,
            encoding: 'utf8',
            env: { ...process.env, BASE: base, HEAD: head, GITHUB_OUTPUT: output },
            timeout: 5000
        });
        expect(result.status, result.stderr).toBe(0);
        expect(readFileSync(output, 'utf8').trim()).toBe(`required=${required}`);
    });
});
