// Classifies changed files for CI: plugin/repo code, action directories, extension directories, and documentation.
// scripts/ci-gate.mjs turns these outputs into the list of CI jobs the change needs.
// See the Jobs table in docs/ci-and-releases.md.
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import * as path from 'node:path';
import { COMMIT_LOG_ARGS, parseCommitLog } from './utils/commit-log.mjs';
import { generatorInputs } from './utils/generator-inputs.mjs';
import { benchmarkInputs, externalConsumerInputs, integrationInputs } from './utils/integration-inputs.mjs';
import { changedLockfileImporters, readGitFile, workspaceLayoutChanged } from './utils/workspace-changes.mjs';
import { commonHelperConsumers, discoverWorkspace } from './utils/workspace-discovery.mjs';

/** A changed file matching any of these is documentation, which nothing that builds or tests reads. */
const DOCS = [/\.md$/, /^docs\//, /^LICENSE$/, /^(packages|tools|actions|extensions)\/[^/]+\/docs(?:\/|$)/];
/** Label and CodeRabbit settings affect automation configuration, not plugin or repository code. */
const LABEL_CONFIGURATION = new Set(['.github/labels.yml', '.coderabbit.yaml']);
const repositoryRoot = path.resolve(import.meta.dirname, '..');
/** The subject of the release workflow's generated README commit, which reruns the docs checks. */
const GENERATED_READMES_SUBJECT = 'docs: update generated READMEs';
/**
 * Commit subjects that a merged release PR brings to the default branch. The release-pr job in
 * .github/workflows/release.yml writes the follow-up commits; keep these in step with it.
 */
const RELEASE_PR_SUBJECTS = {
    release: [/^chore\(master\): release /, /^chore: retire first-release pins$/],
    followUp: [/^fix\(create-pumpkin-plugin\): sync starter tool versions$/, /^docs: update generated READMEs$/],
};

const args = process.argv.slice(2);
const configOnlyMode = args[0] === '--config-only';
const positionalArgs = configOnlyMode ? args.slice(1) : args;
if (positionalArgs.includes('--help') || positionalArgs.includes('-h')) {
    console.log('Usage: changed-areas.mjs <base> [head]');
    process.exit(0);
}
const [base, head = 'HEAD'] = positionalArgs;
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
const changedFiles = diff.stdout.split('\n').filter(Boolean);
const configOnly = changedFiles.length > 0 && changedFiles.every((file) => LABEL_CONFIGURATION.has(file));
if (configOnlyMode) {
    console.log(`Label configuration only: ${configOnly}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `config_only=${configOnly}\n`);
    process.exit(0);
}

const commitLog = spawnSync('git', [...COMMIT_LOG_ARGS, `${base}..${head}`], { encoding: 'utf8' });
if (commitLog.status !== 0) {
    console.error(`Could not read commits between ${base} and ${head}: ${commitLog.stderr.trim()}`);
    process.exit(1);
}
const { commits, files: changedByNonIgnoredCommits } = parseCommitLog(commitLog.stdout);
const subjects = commits.map(({ subject }) => subject);
const generatedReadmes = commits.some(({ subject, ignored }) => !ignored && subject === GENERATED_READMES_SUBJECT);
const isRelease = (subject) => RELEASE_PR_SUBJECTS.release.some((pattern) => pattern.test(subject));
const isFollowUp = (subject) => RELEASE_PR_SUBJECTS.followUp.some((pattern) => pattern.test(subject));
// A merged release PR only bumps versions and regenerates files from commits that already passed
// CI, so its push skips the expensive suites. CI's push trigger only covers the default branch.
const skipExpensiveChecks =
    process.env.GITHUB_EVENT_NAME === 'push' &&
    subjects.some(isRelease) &&
    subjects.every((subject) => isRelease(subject) || isFollowUp(subject));
const changed = diff.stdout.split('\n').filter((file) => file.length > 0 && changedByNonIgnoredCommits.has(file));
const isDocs = (file) => DOCS.some((pattern) => pattern.test(file));
const actionPaths = changed.filter((file) => !isDocs(file) && /^actions\/[^/]+\//.test(file));
const actions = [...new Set(actionPaths.map((file) => file.split('/')[1]))].filter((name) => name !== 'common').sort();
const actionCodePaths = actionPaths.filter((file) => !file.endsWith('/version.txt'));
const tests = new Set(actionCodePaths.map((file) => file.split('/')[1]));
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
    (file) =>
        !isDocs(file) &&
        !LABEL_CONFIGURATION.has(file) &&
        !/^actions\/[^/]+\//.test(file) &&
        !/^extensions\/[^/]+\//.test(file),
);
// Discover the workspace once, and only when a check below reads it.
const workspace = code.length > 0 || tests.has('common') ? discoverWorkspace(repositoryRoot) : undefined;
if (tests.has('common')) for (const consumer of commonHelperConsumers(workspace)) tests.add(consumer);
const actionsToTest = [...tests].sort();
const generatorRelevant = code.length > 0 ? generatorInputs(workspace) : undefined;
const generator = Boolean(
    generatorRelevant &&
        changed.some(
            (file) =>
                !isDocs(file) &&
                (generatorRelevant.files.has(file) ||
                    [...generatorRelevant.directories].some((directory) => file.startsWith(`${directory}/`))),
        ),
);
const integrationRelevant = code.length > 0 ? integrationInputs(workspace) : undefined;
/** Checks a changed file against the workspace-wide inputs, which can be Turborepo globs. */
const isGlobalInput = (file) =>
    [...(integrationRelevant?.globalFiles ?? [])].some((input) => path.posix.matchesGlob(file, input));
const lockfileChanged = code.includes('pnpm-lock.yaml');
const workspaceConfigChanged = code.includes('pnpm-workspace.yaml');
const lockfileImporterDirectories = lockfileChanged ? changedLockfileImporters(repositoryRoot, base, head) : [];
const lockfileWideChanged =
    lockfileChanged &&
    (!lockfileImporterDirectories ||
        lockfileImporterDirectories.length === 0 ||
        lockfileImporterDirectories.includes('.'));
const workspaceLayoutChangedForIntegration =
    workspaceConfigChanged && workspaceLayoutChanged(repositoryRoot, base, head);
/** Keep the benchmark comparison scoped to its dedicated real-server workflow. */
const benchmarkOnly = code.length > 0 && code.every((file) => file.startsWith('benchmarks/engine-comparison/'));
const integrationRuntimeChanged = Boolean(
    integrationRelevant &&
        (code.some((file) =>
            [...integrationRelevant.directories].some((directory) => file.startsWith(`${directory}/`)),
        ) ||
            lockfileImporterDirectories?.some((directory) => integrationRelevant.directories.has(directory))),
);
const integrationAllChanged = Boolean(
    integrationRelevant &&
        (workspaceLayoutChangedForIntegration ||
            lockfileWideChanged ||
            code.some(
                (file) =>
                    isGlobalInput(file) ||
                    [...integrationRelevant.allDirectories].some((directory) => file.startsWith(`${directory}/`)),
            )),
);
let integrationScope = benchmarkOnly
    ? 'benchmark'
    : integrationAllChanged
      ? 'all'
      : integrationRuntimeChanged
        ? 'affected'
        : 'none';
/** Checks whether the change touches workspace-wide inputs or the given files and directories. */
const touchesInputs = (inputs) =>
    workspaceLayoutChangedForIntegration ||
    lockfileWideChanged ||
    lockfileImporterDirectories?.some((directory) => inputs.directories.has(directory)) ||
    code.some(
        (file) =>
            inputs.files.has(file) ||
            (isGlobalInput(file) && !file.startsWith('.github/')) ||
            [...inputs.directories].some((directory) => file.startsWith(`${directory}/`)),
    );
const benchmark = Boolean(integrationRelevant && touchesInputs(benchmarkInputs(workspace)));
// Pull requests test macOS and Windows only when packed tools or the test itself change; pushes test all.
const externalConsumerFull =
    process.env.GITHUB_EVENT_NAME === 'push' ||
    Boolean(integrationRelevant && touchesInputs(externalConsumerInputs(workspace)));
const integrationPackages = new Set();
if (integrationScope === 'affected') {
    for (const directory of integrationRelevant.directories) {
        const changedPackage = code.some((file) => file.startsWith(`${directory}/`));
        const changedImporter = lockfileImporterDirectories?.includes(directory);
        if (!changedPackage && !changedImporter) continue;
        let name = [...workspace.packages.values()].find((entry) => entry.directory === directory)?.name;
        if (!name && changedImporter) {
            const previousManifest = readGitFile(repositoryRoot, base, `${directory}/package.json`);
            try {
                name = JSON.parse(previousManifest ?? '').name;
            } catch {
                name = undefined;
            }
        }
        if (name) integrationPackages.add(name);
    }
    if (integrationPackages.size === 0) integrationScope = 'all';
}

console.log(`${changed.length} changed file(s) between ${base} and ${head}`);
if (code.length) console.log(`Code: ${code.join(', ')}`);
else console.log('No plugin or repository code, so the plugin code jobs are skipped.');
if (actions.length) console.log(`Changed actions: ${actions.join(', ')}`);
if (actionsToTest.length) console.log(`Actions to test: ${actionsToTest.join(', ')}`);
if (extensions.length) console.log(`Changed extensions: ${extensions.join(', ')}`);
if (extensionsToTest.length) console.log(`Extensions to test: ${extensionsToTest.join(', ')}`);
console.log(`Generator smoke test: ${generator ? 'selected' : 'skipped'}`);
console.log(`Integration scope: ${integrationScope}`);
console.log(`Engine comparison inputs changed: ${benchmark}`);
console.log(`External consumer platforms: ${externalConsumerFull ? 'all' : 'Linux only'}`);
if (generatedReadmes) console.log('Generated README update commit detected.');
if (skipExpensiveChecks) console.log('Release merge: the expensive suites are skipped.');
if (integrationPackages.size) console.log(`Integration packages: ${[...integrationPackages].sort().join(', ')}`);

if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
        process.env.GITHUB_OUTPUT,
        `code=${code.length > 0}\nconfig_only=${configOnly}\nactions=${JSON.stringify(actions)}\nactions_to_test=${JSON.stringify(actionsToTest)}\nextensions=${JSON.stringify(extensions)}\nextensions_to_test=${JSON.stringify(extensionsToTest)}\ngenerated_readmes=${generatedReadmes}\ngenerator=${generator}\nintegration_scope=${integrationScope}\nskip_expensive_checks=${skipExpensiveChecks}\nbenchmark=${benchmark}\nexternal_consumer_full=${externalConsumerFull}\n${integrationPackages.size ? `integration_packages=${JSON.stringify([...integrationPackages].sort())}\n` : ''}`,
    );
}
