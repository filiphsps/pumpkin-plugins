// Works out whether a change can affect a build, a test or a plugin, and prints it as the `code`
// GitHub Actions output that the workflow gates the code jobs on. A change that touches only
// documentation can't break any of them, so a docs commit shouldn't have to run the suite. See the
// Jobs table in docs/ci-and-releases.md.
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

/** A changed file matching any of these is documentation, which nothing that builds or tests reads. */
const DOCS = [/\.md$/, /^docs\//, /^LICENSE$/];

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
const code = changed.filter((file) => !DOCS.some((isDocs) => isDocs.test(file)));
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
else console.log('Nothing but docs, so the code jobs are skipped.');
console.log(`Integration scope: ${integrationScope}`);
if (integrationExtra) console.log(`Additional integration package: ${integrationExtra}`);

if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
        process.env.GITHUB_OUTPUT,
        `code=${code.length > 0}\nintegration_scope=${integrationScope}\nintegration_extra=${integrationExtra}\n`
    );
}
