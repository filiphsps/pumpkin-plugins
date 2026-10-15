// Classifies changed files for CI: plugin/repo code, action directories, extension directories, and documentation.
// Plugin code jobs, action tests, extension tests, and the generator smoke test have separate gates.
// See the Jobs table in docs/ci-and-releases.md.
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import * as path from 'node:path';
import { ignoredCommitShas } from './utils/ignored-commits.mjs';

/** A changed file matching any of these is documentation, which nothing that builds or tests reads. */
const DOCS = [/\.md$/, /^docs\//, /^LICENSE$/, /^(packages|tools|actions|extensions)\/[^/]+\/docs(?:\/|$)/];
const GENERATOR_RELEVANT_DIRECTORIES = [
    'turbo/generators/',
    'tools/apis/',
    'tools/build/',
    'tools/docs/',
    'tools/plugin-kit/',
    'tools/pumpkin-api/',
    'tools/static-hermes-runtime/',
    'tools/test-harness/',
    '.github/common/bootstrap/',
    '.github/common/setup-static-hermes/',
];
const GENERATOR_RELEVANT_FILES = new Set([
    '.github/workflows/ci.yml',
    '.node-version',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'scripts/turbo.mjs',
    'tsconfig.base.json',
    'turbo.json',
]);

const COMMON_CONSUMERS = [
    'publish-to-pumpkin-market',
    'sign-pumpkin-plugin',
    'update-pumpkin-market-listing',
    'verify-pumpkin-plugin',
];

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: changed-areas.mjs <base> [head]');
    process.exit(0);
}
const [base, head = 'HEAD'] = args;
if (!base) {
    console.error('Usage: changed-areas.mjs <base> [head]');
    process.exit(1);
}

const diff = spawnSync('git', ['diff', '--name-only', `${base}...${head}`], { encoding: 'utf8' });
if (diff.status !== 0) {
    // Failing here rather than reporting no changes: the code jobs must not be skipped by accident.
    console.error(`Could not diff ${base}...${head}: ${diff.stderr.trim()}`);
    process.exit(1);
}

const commitLog = spawnSync(
    'git',
    ['log', '--format=%H%x09%s', '--name-only', '--no-renames', '--diff-merges=first-parent', `${base}..${head}`],
    { encoding: 'utf8' },
);
if (commitLog.status !== 0) {
    console.error(`Could not read commits between ${base} and ${head}: ${commitLog.stderr.trim()}`);
    process.exit(1);
}
const changedByNonIgnoredCommits = new Set();
let currentSha;
let generatedReadmes = false;
for (const line of commitLog.stdout.split('\n')) {
    const separator = line.indexOf('\t');
    if (separator !== -1 && /^[a-f\d]{40}$/.test(line.slice(0, separator))) {
        currentSha = line.slice(0, separator);
        const subject = line.slice(separator + 1);
        if (!ignoredCommitShas.has(currentSha) && subject === 'docs: update generated READMEs') {
            generatedReadmes = true;
        }
        continue;
    }
    if (currentSha && !ignoredCommitShas.has(currentSha) && line) changedByNonIgnoredCommits.add(line);
}
const changed = diff.stdout.split('\n').filter((file) => file.length > 0 && changedByNonIgnoredCommits.has(file));
const isDocs = (file) => DOCS.some((pattern) => pattern.test(file));
const actionPaths = changed.filter((file) => !isDocs(file) && /^actions\/[^/]+\//.test(file));
const actions = [...new Set(actionPaths.map((file) => file.split('/')[1]))].filter((name) => name !== 'common').sort();
const actionCodePaths = actionPaths.filter((file) => !file.endsWith('/version.txt'));
const tests = new Set(actionCodePaths.map((file) => file.split('/')[1]));
if (tests.has('common')) for (const consumer of COMMON_CONSUMERS) tests.add(consumer);
const actionsToTest = [...tests].sort();
const extensionPaths = changed.filter((file) => !isDocs(file) && /^extensions\/[^/]+\//.test(file));
const extensions = [...new Set(extensionPaths.map((file) => file.split('/')[1]))].sort();
const extensionsToTest = [
    ...new Set(
        extensionPaths
            .filter((file) => !['README.md', 'CHANGELOG.md', 'LICENSE'].includes(path.basename(file)))
            .map((file) => file.split('/')[1]),
    ),
].sort();
const code = changed.filter(
    (file) => !isDocs(file) && !/^actions\/[^/]+\//.test(file) && !/^extensions\/[^/]+\//.test(file),
);
const generator = changed.some(
    (file) =>
        !isDocs(file) &&
        (GENERATOR_RELEVANT_FILES.has(file) || GENERATOR_RELEVANT_DIRECTORIES.some((dir) => file.startsWith(dir))),
);
/** Keep the benchmark comparison scoped to its dedicated real-server workflow. */
const benchmarkOnly = code.length > 0 && code.every((file) => file.startsWith('benchmarks/engine-comparison/'));
const integrationScope = benchmarkOnly
    ? 'benchmark'
    : code.length > 0 &&
        code.every((file) =>
            /^(packages\/[^/]+|tools\/(build|config|plugin-kit|port-mapping|test-harness|apis\/upnpumpkin-api))(?:\/|$)/.test(
                file,
            ),
        )
      ? 'affected'
      : 'all';
const integrationExtra = code.some((file) => file.startsWith('packages/upnpumpkin/'))
    ? '@pumpkin-plugins/bedrock-addon-manager'
    : '';

console.log(`${changed.length} changed file(s) between ${base} and ${head}`);
if (code.length) console.log(`Code: ${code.join(', ')}`);
else console.log('No plugin or repository code, so the plugin code jobs are skipped.');
if (actions.length) console.log(`Changed actions: ${actions.join(', ')}`);
if (actionsToTest.length) console.log(`Actions to test: ${actionsToTest.join(', ')}`);
if (extensions.length) console.log(`Changed extensions: ${extensions.join(', ')}`);
if (extensionsToTest.length) console.log(`Extensions to test: ${extensionsToTest.join(', ')}`);
console.log(`Generator smoke test: ${generator ? 'selected' : 'skipped'}`);
console.log(`Integration scope: ${integrationScope}`);
if (generatedReadmes) console.log('Generated README update commit detected.');
if (integrationExtra) console.log(`Additional integration package: ${integrationExtra}`);

if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
        process.env.GITHUB_OUTPUT,
        `code=${code.length > 0}\nactions=${JSON.stringify(actions)}\nactions_to_test=${JSON.stringify(actionsToTest)}\nextensions=${JSON.stringify(extensions)}\nextensions_to_test=${JSON.stringify(extensionsToTest)}\ngenerated_readmes=${generatedReadmes}\ngenerator=${generator}\nintegration_scope=${integrationScope}\nintegration_extra=${integrationExtra}\n`,
    );
}
