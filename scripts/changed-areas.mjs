// Classifies changed files for CI: plugin/repo code, action directories, extension directories, and documentation.
// Plugin code jobs, action tests, extension tests, integration suites, and the generator smoke test have separate gates.
// See the Jobs table in docs/ci-and-releases.md.
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { ignoredCommitShas } from './utils/ignored-commits.mjs';

/** A changed file matching any of these is documentation, which nothing that builds or tests reads. */
const DOCS = [/\.md$/, /^docs\//, /^LICENSE$/, /^(packages|tools|actions|extensions)\/[^/]+\/docs(?:\/|$)/];
/** Label and CodeRabbit settings affect automation configuration, not plugin or repository code. */
const LABEL_CONFIGURATION = new Set(['.github/labels.yml', '.coderabbit.yaml']);
const repositoryRoot = path.resolve(import.meta.dirname, '..');

/** Resolves the generator smoke test's inputs from the checked-out repository. */
function generatorInputs() {
    const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: repositoryRoot, encoding: 'utf8' });
    if (tracked.status !== 0) {
        throw new Error(`Could not list repository files for generator selection: ${tracked.stderr.trim()}`);
    }
    const files = tracked.stdout.split('\0').filter(Boolean);
    const relevantFiles = new Set();
    const relevantDirectories = new Set();
    const addPattern = (pattern) => {
        const normalized = path.posix.normalize(pattern.replace(/^\.\//, ''));
        if (!/[*?]/.test(normalized)) {
            relevantFiles.add(normalized);
            return;
        }
        let expression = '^';
        for (let index = 0; index < normalized.length; index += 1) {
            const character = normalized[index];
            if (character === '*' && normalized[index + 1] === '*') {
                expression += '.*';
                index += 1;
            } else if (character === '*') expression += '[^/]*';
            else if (character === '?') expression += '[^/]';
            else expression += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
        }
        const matches = new RegExp(`${expression}$`);
        for (const file of files) if (matches.test(file)) relevantFiles.add(file);
    };
    const readJson = (file) => JSON.parse(readFileSync(path.join(repositoryRoot, file), 'utf8'));
    const packageByName = new Map();
    for (const file of files.filter((entry) => entry.endsWith('/package.json'))) {
        const manifest = readJson(file);
        if (typeof manifest.name === 'string') {
            packageByName.set(manifest.name, { directory: path.posix.dirname(file), manifest });
        }
    }

    const generatorConfigs = files.filter((file) => {
        if (!/\.(?:c|m)?(?:j|t)s$/.test(file)) return false;
        return /^\s*[\w$]+\.setGenerator\(/m.test(readFileSync(path.join(repositoryRoot, file), 'utf8'));
    });
    for (const file of generatorConfigs) relevantDirectories.add(path.posix.dirname(file));

    const generatedPackageDependencies = new Set();
    for (const directory of relevantDirectories) {
        for (const file of files.filter(
            (entry) => entry.startsWith(`${directory}/`) && entry.endsWith('/package.json.hbs'),
        )) {
            const source = readFileSync(path.join(repositoryRoot, file), 'utf8');
            for (const section of source.matchAll(
                /"(?:dependencies|devDependencies|optionalDependencies|peerDependencies)"\s*:\s*\{([\s\S]*?)\}/g,
            )) {
                for (const [, name] of section[1].matchAll(/"([^"]+)"\s*:/g)) {
                    if (packageByName.has(name)) generatedPackageDependencies.add(name);
                }
            }
        }
    }
    const rootManifest = readJson('package.json');
    for (const dependencies of [rootManifest.dependencies, rootManifest.devDependencies]) {
        for (const name of Object.keys(dependencies ?? {})) {
            if (packageByName.has(name)) generatedPackageDependencies.add(name);
        }
    }
    const pendingPackages = [...generatedPackageDependencies];
    const visitedPackages = new Set();
    while (pendingPackages.length) {
        const name = pendingPackages.pop();
        if (visitedPackages.has(name)) continue;
        visitedPackages.add(name);
        const workspacePackage = packageByName.get(name);
        if (!workspacePackage) continue;
        relevantDirectories.add(workspacePackage.directory);
        for (const dependencies of [
            workspacePackage.manifest.dependencies,
            workspacePackage.manifest.devDependencies,
            workspacePackage.manifest.optionalDependencies,
            workspacePackage.manifest.peerDependencies,
        ]) {
            for (const dependency of Object.keys(dependencies ?? {})) {
                if (packageByName.has(dependency)) pendingPackages.push(dependency);
            }
        }
    }

    for (const file of files.filter((entry) => !entry.includes('/'))) {
        if (file === 'package.json' || /(?:lock|workspace)/i.test(file)) relevantFiles.add(file);
    }
    const turboConfig = files.find((file) => {
        if (file.includes('/') || !file.endsWith('.json')) return false;
        const config = readJson(file);
        return config.tasks && Array.isArray(config.globalDependencies);
    });
    if (turboConfig) {
        relevantFiles.add(turboConfig);
        for (const input of readJson(turboConfig).globalDependencies) addPattern(input);
    }

    const workflowFiles = files.filter((file) => file.startsWith('.github/workflows/') && /\.ya?ml$/.test(file));
    let generatorWorkflow;
    let generatorJob;
    for (const file of workflowFiles) {
        const lines = readFileSync(path.join(repositoryRoot, file), 'utf8').split('\n');
        const start = lines.findIndex((line) => /^ {4}generator:\s*$/.test(line));
        if (start === -1) continue;
        const nextJob = lines.findIndex((line, index) => index > start && /^ {4}[\w-]+:\s*$/.test(line));
        generatorWorkflow = file;
        generatorJob = lines.slice(start, nextJob === -1 ? undefined : nextJob).join('\n');
        break;
    }
    if (!generatorWorkflow) throw new Error('Could not find the generator job in a GitHub workflow.');
    relevantFiles.add(generatorWorkflow);
    for (const [, localPath] of generatorJob.matchAll(/^\s*(?:-\s*)?uses:\s+\.\/([^#\s@]+)/gm)) {
        relevantDirectories.add(path.posix.normalize(localPath));
    }

    const scripts = rootManifest.scripts ?? {};
    const pendingScripts = Object.keys(scripts).filter((name) => {
        const escapedName = name.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
        return new RegExp(`\\bpnpm\\s+(?:run\\s+)?${escapedName}(?=\\s|$)`).test(generatorJob);
    });
    const visitedScripts = new Set();
    while (pendingScripts.length) {
        const name = pendingScripts.pop();
        if (visitedScripts.has(name)) continue;
        visitedScripts.add(name);
        const command = scripts[name];
        for (const [, scriptPath] of command.matchAll(/\bnode\s+([^\s"'`]+\.mjs)/g)) addPattern(scriptPath);
        for (const [, nestedName] of command.matchAll(/\bpnpm\s+(?:run\s+)?([\w:-]+)/g)) {
            if (Object.hasOwn(scripts, nestedName)) pendingScripts.push(nestedName);
        }
    }

    if (generatorConfigs.length === 0) throw new Error('Could not find the repository generator configuration.');
    return { files: relevantFiles, directories: relevantDirectories };
}

/** Finds workspace inputs that participate in real-server tests and their build tasks. */
function integrationInputs() {
    const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: repositoryRoot, encoding: 'utf8' });
    if (tracked.status !== 0) {
        throw new Error(`Could not list repository files for integration selection: ${tracked.stderr.trim()}`);
    }
    const files = tracked.stdout.split('\0').filter(Boolean);
    const readJson = (file) => JSON.parse(readFileSync(path.join(repositoryRoot, file), 'utf8'));
    const packageByName = new Map();
    for (const file of files.filter((entry) => entry.endsWith('/package.json'))) {
        const manifest = readJson(file);
        if (typeof manifest.name === 'string') {
            packageByName.set(manifest.name, { directory: path.posix.dirname(file), manifest });
        }
    }

    const turboConfigFile = files.find((file) => {
        if (file.includes('/') || !file.endsWith('.json')) return false;
        const config = readJson(file);
        return config.tasks && Array.isArray(config.globalDependencies);
    });
    if (!turboConfigFile) throw new Error('Could not find the Turborepo configuration for integration selection.');
    const turboConfig = readJson(turboConfigFile);
    const globalFiles = new Set([turboConfigFile]);
    for (const file of files.filter((entry) => !entry.includes('/'))) {
        if (file === 'package.json') globalFiles.add(file);
    }
    for (const input of turboConfig.globalDependencies) {
        const normalized = path.posix.normalize(input);
        if (normalized !== 'pnpm-workspace.yaml') globalFiles.add(normalized);
    }

    const directories = new Set();
    const visitedPackages = new Set();
    const packageDependencies = (manifest) =>
        [manifest.dependencies, manifest.optionalDependencies, manifest.peerDependencies, manifest.devDependencies]
            .flatMap((dependencies) => Object.keys(dependencies ?? {}))
            .filter((name) => packageByName.has(name));
    const addRuntimePackage = (name) => {
        if (visitedPackages.has(name)) return;
        visitedPackages.add(name);
        const workspacePackage = packageByName.get(name);
        if (!workspacePackage) return;
        directories.add(workspacePackage.directory);
        for (const dependency of packageDependencies(workspacePackage.manifest)) addRuntimePackage(dependency);
    };
    const visitedTasks = new Set();
    const visitTask = (name, taskName) => {
        const key = `${name}#${taskName}`;
        if (visitedTasks.has(key)) return;
        visitedTasks.add(key);
        const workspacePackage = packageByName.get(name);
        if (!workspacePackage) return;
        if (workspacePackage.manifest.scripts?.[taskName]) directories.add(workspacePackage.directory);
        const task = turboConfig.tasks[key] ?? turboConfig.tasks[taskName];
        for (const dependency of task?.dependsOn ?? []) {
            const separator = dependency.indexOf('#');
            if (separator !== -1) {
                visitTask(dependency.slice(0, separator), dependency.slice(separator + 1));
            } else if (dependency.startsWith('^')) {
                const dependencyTask = dependency.slice(1);
                for (const child of packageDependencies(workspacePackage.manifest)) {
                    if (packageByName.get(child).manifest.scripts?.[dependencyTask]) visitTask(child, dependencyTask);
                }
            } else {
                visitTask(name, dependency);
            }
        }
    };

    for (const [name, workspacePackage] of packageByName) {
        if (workspacePackage.manifest.scripts?.['test:integration']) {
            addRuntimePackage(name);
            visitTask(name, 'test:integration');
        }
    }

    const allDirectories = new Set();
    for (const file of files.filter((entry) => entry.startsWith('.github/workflows/') && /\.ya?ml$/.test(entry))) {
        const lines = readFileSync(path.join(repositoryRoot, file), 'utf8').split('\n');
        const start = lines.findIndex((line) => /^ {4}integration:\s*$/.test(line));
        if (start === -1) continue;
        globalFiles.add(file);
        const nextJob = lines.findIndex((line, index) => index > start && /^ {4}[\w-]+:\s*$/.test(line));
        const job = lines.slice(start, nextJob === -1 ? undefined : nextJob).join('\n');
        for (const [, localPath] of job.matchAll(/^\s*(?:-\s*)?uses:\s+\.\/([^#\s@]+)/gm)) {
            allDirectories.add(path.posix.normalize(localPath));
        }
        break;
    }
    const packageByDirectory = new Map(
        [...packageByName].map(([name, workspacePackage]) => [
            workspacePackage.directory,
            { name, ...workspacePackage },
        ]),
    );
    return { directories, globalFiles, allDirectories, packageByDirectory };
}

/** Reads a tracked file at a revision, returning undefined when that revision has no such file. */
function readGitFile(revision, file) {
    const result = spawnSync('git', ['show', `${revision}:${file}`], {
        cwd: repositoryRoot,
        encoding: 'utf8',
    });
    if (result.status === 0) return result.stdout;
    return undefined;
}

/** Reads each workspace importer block from a pnpm lockfile. */
function lockfileImporters(contents) {
    const importers = new Map();
    let inImporters = false;
    let currentImporter;
    for (const line of contents.split('\n')) {
        if (!inImporters) {
            if (line === 'importers:') inImporters = true;
            continue;
        }
        if (line && !line.startsWith(' ')) {
            inImporters = false;
            currentImporter = undefined;
            continue;
        }
        const entry = line.match(/^ {2}([^ ].*?):(?:\s*(.*))?$/);
        if (entry) {
            currentImporter = entry[1].replace(/^['"]|['"]$/g, '');
            importers.set(currentImporter, [line]);
        } else if (currentImporter) {
            importers.get(currentImporter).push(line);
        }
    }
    return new Map([...importers].map(([key, lines]) => [key, lines.join('\n')]));
}

/** Returns the importer directories whose lockfile entries changed between two revisions. */
function changedLockfileImporters(base, head) {
    const before = readGitFile(base, 'pnpm-lock.yaml');
    const after = readGitFile(head, 'pnpm-lock.yaml');
    if (before === undefined || after === undefined) return undefined;
    const previousImporters = lockfileImporters(before);
    const currentImporters = lockfileImporters(after);
    const changedImporters = new Set([...previousImporters.keys(), ...currentImporters.keys()]);
    return [...changedImporters]
        .filter((importer) => previousImporters.get(importer) !== currentImporters.get(importer))
        .map((importer) => (importer === '.' ? importer : path.posix.normalize(importer)));
}

/** Returns workspace configuration with catalog entries removed. */
function workspaceLayout(contents) {
    let insideCatalogs = false;
    const retainedLines = [];
    for (const line of contents.split('\n')) {
        if (/^catalogs?:\s*$/.test(line)) {
            insideCatalogs = true;
            continue;
        }
        if (insideCatalogs && line && !line.startsWith(' ')) insideCatalogs = false;
        if (!insideCatalogs) retainedLines.push(line);
    }
    return retainedLines.join('\n').trim();
}

/** Checks whether workspace configuration changed outside its catalogs. */
function workspaceLayoutChanged(base, head) {
    const before = readGitFile(base, 'pnpm-workspace.yaml');
    const after = readGitFile(head, 'pnpm-workspace.yaml');
    return before === undefined || after === undefined || workspaceLayout(before) !== workspaceLayout(after);
}

const COMMON_CONSUMERS = [
    'publish-to-pumpkin-market',
    'sign-pumpkin-plugin',
    'update-pumpkin-market-listing',
    'verify-pumpkin-plugin',
];

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
if (configOnlyMode) {
    const changedFiles = diff.stdout.split('\n').filter(Boolean);
    const configOnly = changedFiles.length > 0 && changedFiles.every((file) => LABEL_CONFIGURATION.has(file));
    console.log(`Label configuration only: ${configOnly}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `config_only=${configOnly}\n`);
    process.exit(0);
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
    (file) =>
        !isDocs(file) &&
        !LABEL_CONFIGURATION.has(file) &&
        !/^actions\/[^/]+\//.test(file) &&
        !/^extensions\/[^/]+\//.test(file),
);
const native = code.some(
    (file) =>
        file.startsWith('native/') ||
        ['scripts/native-release.mjs', 'scripts/utils/native-targets.mjs', '.github/workflows/native.yml'].includes(
            file,
        ),
);
const nativeRuntime = code.some((file) => file.startsWith('native/'));
const generatorRelevant = code.length > 0 ? generatorInputs() : undefined;
const generator = Boolean(
    generatorRelevant &&
        changed.some(
            (file) =>
                !isDocs(file) &&
                (generatorRelevant.files.has(file) ||
                    [...generatorRelevant.directories].some((directory) => file.startsWith(`${directory}/`))),
        ),
);
const integrationRelevant = code.length > 0 ? integrationInputs() : undefined;
const lockfileChanged = code.includes('pnpm-lock.yaml');
const workspaceConfigChanged = code.includes('pnpm-workspace.yaml');
const lockfileImporterDirectories = lockfileChanged ? changedLockfileImporters(base, head) : [];
const lockfileWideChanged =
    lockfileChanged &&
    (!lockfileImporterDirectories ||
        lockfileImporterDirectories.length === 0 ||
        lockfileImporterDirectories.includes('.'));
const workspaceLayoutChangedForIntegration = workspaceConfigChanged && workspaceLayoutChanged(base, head);
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
        (nativeRuntime ||
            workspaceLayoutChangedForIntegration ||
            lockfileWideChanged ||
            code.some(
                (file) =>
                    integrationRelevant.globalFiles.has(file) ||
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
const integrationExtra = code.some((file) => file.startsWith('packages/upnpumpkin/'))
    ? '@pumpkin-plugins/bedrock-addon-manager'
    : '';
const integrationPackages = new Set();
if (integrationScope === 'affected') {
    for (const directory of integrationRelevant.directories) {
        const changedPackage = code.some((file) => file.startsWith(`${directory}/`));
        const changedImporter = lockfileImporterDirectories?.includes(directory);
        if (!changedPackage && !changedImporter) continue;
        let name = integrationRelevant.packageByDirectory.get(directory)?.name;
        if (!name && changedImporter) {
            const previousManifest = readGitFile(base, `${directory}/package.json`);
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
if (generatedReadmes) console.log('Generated README update commit detected.');
if (integrationExtra) console.log(`Additional integration package: ${integrationExtra}`);
if (integrationPackages.size) console.log(`Integration packages: ${[...integrationPackages].sort().join(', ')}`);

if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
        process.env.GITHUB_OUTPUT,
        `code=${code.length > 0}\nnative=${native}\nactions=${JSON.stringify(actions)}\nactions_to_test=${JSON.stringify(actionsToTest)}\nextensions=${JSON.stringify(extensions)}\nextensions_to_test=${JSON.stringify(extensionsToTest)}\ngenerated_readmes=${generatedReadmes}\ngenerator=${generator}\nintegration_scope=${integrationScope}\nintegration_extra=${integrationExtra}\n${integrationPackages.size ? `integration_packages=${JSON.stringify([...integrationPackages].sort())}\n` : ''}`,
    );
}
