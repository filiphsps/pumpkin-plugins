import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { parse } from 'yaml';

const bootstrap = parse(fs.readFileSync(new URL('../.github/common/bootstrap/action.yml', import.meta.url), 'utf8'));
const comparison = parse(
    fs.readFileSync(new URL('../.github/workflows/engine-comparison.yml', import.meta.url), 'utf8'),
);

function expand(template, context) {
    return template.replace(/\$\{\{(.*?)\}\}/g, (_, expression) =>
        String(
            runInNewContext(
                expression.replace(/\.([a-zA-Z_][\w-]*)/g, (_match, name) => `[${JSON.stringify(name)}]`),
                context,
            ),
        ),
    );
}

function turboCache(variant, sha, runId, arch = 'X64', runAttempt = '1') {
    const context = {
        runner: { os: 'Linux', arch },
        github: { sha, run_id: runId, run_attempt: runAttempt, job: 'benchmark' },
        matrix: { variant },
    };
    const invocation = comparison.jobs.benchmark.steps.find((step) => step.uses === './.github/common/bootstrap');
    context.inputs = Object.fromEntries(
        Object.entries(bootstrap.inputs ?? {}).map(([name, input]) => [name, expand(input.default ?? '', context)]),
    );
    for (const [name, value] of Object.entries(invocation.with ?? {})) {
        context.inputs[name] = expand(value, context);
    }
    const cache = bootstrap.runs.steps.find((step) => step.with?.path === '.turbo').with;
    return {
        key: expand(cache.key, context),
        prefixes: expand(cache['restore-keys'], context)
            .trim()
            .split('\n')
            .map((line) => line.trim()),
    };
}

it('keeps parallel benchmark caches distinct and restores the same variant across commits', () => {
    const hades = turboCache('static-hermes-full-hades-js', 'previous', '100');
    const malloc = turboCache('static-hermes-full-malloc-js', 'previous', '100');
    assert.notEqual(hades.key, malloc.key, 'parallel variants must not compete for one immutable cache');

    const nextMalloc = turboCache('static-hermes-full-malloc-js', 'current', '101');
    const matchingPrefix = nextMalloc.prefixes.find((prefix) => malloc.key.startsWith(prefix));
    assert.ok(matchingPrefix, 'an unchanged variant must be reusable after a new commit');
    assert.equal(hades.key.startsWith(matchingPrefix), false, 'prefer this variant before shared fallback caches');
    assert.notEqual(nextMalloc.key, malloc.key, 'new task outputs must be saved after a source change');

    const armMalloc = turboCache('static-hermes-full-malloc-js', 'previous', '100', 'ARM64');
    assert.notEqual(armMalloc.key, malloc.key, 'compiled Turbo outputs must be isolated by runner architecture');
});

it('persists malloc archives independently of the immutable shared Hades snapshot', () => {
    const steps = comparison.jobs.benchmark.steps;
    const setup = steps.find((step) => step.uses === './.github/common/setup-static-hermes');
    const bootstrapStep = steps.find((step) => step.uses === './.github/common/bootstrap');
    const hadesCheck = steps.find((step) => step.run?.includes('prepare-hermes'));
    const caches = steps.filter((step) => step.with?.path?.includes('build-wasip2-malloc'));
    assert.ok(caches.length > 0, 'malloc compilation must survive the benchmark runner');

    const cachesFor = (variant, save) =>
        caches
            .filter(
                (step) =>
                    expand(`\${{ ${step.if} }}`, {
                        matrix: { variant },
                        contains: (a, b) => a.includes(b),
                        steps: { [bootstrapStep.id]: { outputs: { 'save-caches': String(save) } } },
                    }) === 'true',
            )
            .map((step) => step.uses.replace(/@.*/, ''));
    assert.deepEqual(cachesFor('static-hermes-full-malloc-js', true), ['actions/cache']);
    assert.deepEqual(cachesFor('static-hermes-lean-malloc-ts', false), ['actions/cache/restore']);
    assert.deepEqual(cachesFor('static-hermes-full-hades-js', true), []);
    assert.deepEqual(cachesFor('quickjs', true), []);

    const key = (cache, pin) =>
        expand(cache.with.key, { steps: { [setup.id]: { outputs: { 'hermes-cache-key': pin } } } });
    for (const cache of caches) {
        // The malloc fingerprint records the host compiler export that its build rewrites.
        assert.ok(steps.indexOf(cache) > steps.indexOf(hadesCheck), 'restore malloc after the Hades check');
        assert.ok(steps.indexOf(cache) < steps.findIndex((step) => step.env?.ENGINE_COMPARISON_VARIANT));
        assert.ok(cache.with.path.includes('build-host/ImportHostCompilers.cmake'), 'keep the host export it records');
        assert.ok(
            cache.with.path.includes('prepared-build-malloc.json'),
            'retain the fingerprint used to skip compilation',
        );
        assert.notEqual(key(cache, 'pinned-runtime-a'), 'pinned-runtime-a', 'never overwrite the Hades cache');
        assert.notEqual(
            key(cache, 'pinned-runtime-a'),
            key(cache, 'pinned-runtime-b'),
            'runtime changes must invalidate malloc archives',
        );
        assert.equal(key(cache, 'pin'), key(caches[0], 'pin'), 'restore the entry that default-branch runs save');
    }
});

/** Returns the `uses` of the bootstrap cache steps that run for one event, keyed by cached path. */
function bootstrapCacheSteps(github) {
    const context = { github, format: (template, ...values) => template.replace(/\{(\d+)\}/g, (_, i) => values[i]) };
    const outputs = {};
    for (const step of bootstrap.runs.steps.filter((candidate) => candidate.id)) {
        outputs[step.id] = {
            outputs: { save: expand(step.env?.SAVE_CACHES ?? '', context), 'pnpm-store': '/pnpm-store' },
        };
    }
    const used = {};
    for (const step of bootstrap.runs.steps) {
        if (!step.uses?.startsWith('actions/cache')) continue;
        if (step.if !== undefined && expand(`\${{ ${step.if} }}`, { steps: outputs }) !== 'true') continue;
        const cachedPath = expand(step.with.path, { steps: outputs });
        used[cachedPath] = [...(used[cachedPath] ?? []), step.uses.replace(/@.*/, '')];
    }
    return used;
}

it('saves bootstrap caches only from default-branch pushes and restores them everywhere', () => {
    const repository = { default_branch: 'master' };
    const restoreOnly = { '/pnpm-store': ['actions/cache/restore'], '.turbo': ['actions/cache/restore'] };
    assert.deepEqual(bootstrapCacheSteps({ event_name: 'push', ref: 'refs/heads/master', event: { repository } }), {
        '/pnpm-store': ['actions/cache'],
        '.turbo': ['actions/cache'],
    });
    for (const github of [
        { event_name: 'pull_request', ref: 'refs/pull/7/merge', event: { repository } },
        { event_name: 'push', ref: 'refs/heads/feature', event: { repository } },
        { event_name: 'workflow_run', ref: 'refs/heads/master', event: { repository } },
        { event_name: 'schedule', ref: 'refs/heads/master', event: {} },
    ]) {
        assert.deepEqual(bootstrapCacheSteps(github), restoreOnly, `${github.event_name} ${github.ref}`);
    }
});

it('reuses the Turborepo cache entry when a run is retried on the same commit', () => {
    const first = turboCache('quickjs', 'same', '100');
    const retry = turboCache('quickjs', 'same', '100', 'X64', '2');
    const rerun = turboCache('quickjs', 'same', '101');
    assert.equal(retry.key, first.key, 'a retry must hit the saved entry instead of adding another');
    assert.equal(rerun.key, first.key, 'a new run of the same commit must hit the saved entry');
});
