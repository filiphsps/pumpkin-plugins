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

function turboCache(variant, sha, runId, arch = 'X64') {
    const context = {
        runner: { os: 'Linux', arch },
        github: { sha, run_id: runId, run_attempt: '1', job: 'benchmark' },
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
    const cache = steps.find((step) => step.with?.path?.includes('build-wasip2-malloc'));
    assert.ok(cache, 'malloc compilation must survive the benchmark runner');
    assert.equal(cache.uses, 'actions/cache@v6.1.0');
    assert.ok(steps.indexOf(cache) > steps.indexOf(setup), 'restore malloc after the shared snapshot');
    assert.ok(steps.indexOf(cache) < steps.findIndex((step) => step.env?.ENGINE_COMPARISON_VARIANT));

    const enabled = (variant) => runInNewContext(cache.if, { matrix: { variant }, contains: (a, b) => a.includes(b) });
    assert.equal(enabled('static-hermes-full-malloc-js'), true);
    assert.equal(enabled('static-hermes-lean-malloc-ts'), true);
    assert.equal(enabled('static-hermes-full-hades-js'), false);
    assert.equal(enabled('quickjs'), false);

    const key = (pin) => expand(cache.with.key, { steps: { [setup.id]: { outputs: { 'hermes-cache-key': pin } } } });
    assert.notEqual(key('pinned-runtime-a'), 'pinned-runtime-a', 'never overwrite the Hades cache');
    assert.notEqual(
        key('pinned-runtime-a'),
        key('pinned-runtime-b'),
        'runtime changes must invalidate malloc archives',
    );
    assert.ok(
        cache.with.path.includes('prepared-build-malloc.json'),
        'retain the fingerprint used to skip compilation',
    );
});
