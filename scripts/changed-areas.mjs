// Classifies changed files for CI: plugin/repo code, action directories, and documentation. Plugin
// code jobs and action tests have separate gates, so action-only changes don't run Pumpkin suites.
// See the Jobs table in docs/ci-and-releases.md.
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

/** A changed file matching any of these is documentation, which nothing that builds or tests reads. */
const DOCS = [/\.md$/, /^docs\//, /^LICENSE$/, /^(packages|tools|actions)\/[^/]+\/docs(?:\/|$)/];

const COMMON_CONSUMERS = [
    'publish-to-pumpkin-market',
    'sign-pumpkin-plugin',
    'update-pumpkin-market-listing',
    'verify-pumpkin-plugin'
];

const [base, head = 'HEAD'] = process.argv.slice(2);
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

const changed = diff.stdout.split('\n').filter((file) => file.length > 0);
const commitLog = spawnSync('git', ['log', '--format=%s', `${base}..${head}`], { encoding: 'utf8' });
if (commitLog.status !== 0) {
    console.error(`Could not read commits between ${base} and ${head}: ${commitLog.stderr.trim()}`);
    process.exit(1);
}
const generatedReadmes = commitLog.stdout.split('\n').includes('docs: update generated READMEs');
const isDocs = (file) => DOCS.some((pattern) => pattern.test(file));
const actionPaths = changed.filter((file) => !isDocs(file) && /^actions\/[^/]+\//.test(file));
const actions = [...new Set(actionPaths.map((file) => file.split('/')[1]))].filter((name) => name !== 'common').sort();
const actionCodePaths = actionPaths.filter((file) => !file.endsWith('/version.txt'));
const tests = new Set(actionCodePaths.map((file) => file.split('/')[1]));
if (tests.has('common')) for (const consumer of COMMON_CONSUMERS) tests.add(consumer);
const actionsToTest = [...tests].sort();
const code = changed.filter((file) => !isDocs(file) && !/^actions\/[^/]+\//.test(file));
const integrationScope =
    code.length > 0 &&
    code.every((file) =>
        /^(packages\/[^/]+|tools\/(build|config|plugin-kit|port-mapping|test-harness|upnpumpkin-api))(?:\/|$)/.test(
            file
        )
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
console.log(`Integration scope: ${integrationScope}`);
if (generatedReadmes) console.log('Generated README update commit detected.');
if (integrationExtra) console.log(`Additional integration package: ${integrationExtra}`);

if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
        process.env.GITHUB_OUTPUT,
        `code=${code.length > 0}\nactions=${JSON.stringify(actions)}\nactions_to_test=${JSON.stringify(actionsToTest)}\ngenerated_readmes=${generatedReadmes}\nintegration_scope=${integrationScope}\nintegration_extra=${integrationExtra}\n`
    );
}
