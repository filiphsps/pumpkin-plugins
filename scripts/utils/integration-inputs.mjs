// Finds what the real-server CI jobs read, so scripts/changed-areas.mjs can select the integration
// suites, the engine comparison and the external consumer platforms that a change needs.
import * as path from 'node:path';
import { DEPENDENCY_FIELDS, dependencyClosure, localUses, workflowJob } from './workspace-discovery.mjs';

/** The dependency fields followed from the packages a reusable CI workflow builds; peer dependencies aren't. */
const BUILD_DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'];

/**
 * Finds workspace inputs that participate in real-server tests and their build tasks.
 *
 * @returns The package directories whose changes select their own suites (`directories`), the
 *     workspace-wide inputs, which can be Turborepo globs (`globalFiles`), and the local actions of
 *     the `integration` job, whose changes select every suite (`allDirectories`).
 * @throws When the repository has no Turborepo configuration.
 */
export function integrationInputs(workspace) {
    const { files, packages, turboConfig, turboConfigFile } = workspace;
    if (!turboConfigFile) throw new Error('Could not find the Turborepo configuration for integration selection.');
    const globalFiles = new Set([turboConfigFile]);
    if (files.includes('package.json')) globalFiles.add('package.json');
    for (const input of turboConfig.globalDependencies) {
        const normalized = path.posix.normalize(input);
        if (normalized !== 'pnpm-workspace.yaml') globalFiles.add(normalized);
    }

    const suites = [...packages.values()]
        .filter(({ manifest }) => manifest.scripts?.['test:integration'])
        .map(({ name }) => name);
    const directories = dependencyClosure(packages, suites);
    const workspaceDependencies = (manifest) =>
        DEPENDENCY_FIELDS.flatMap((field) => Object.keys(manifest[field] ?? {})).filter((name) => packages.has(name));
    const visitedTasks = new Set();
    const visitTask = (name, taskName) => {
        const key = `${name}#${taskName}`;
        if (visitedTasks.has(key)) return;
        visitedTasks.add(key);
        const workspacePackage = packages.get(name);
        if (!workspacePackage) return;
        if (workspacePackage.manifest.scripts?.[taskName]) directories.add(workspacePackage.directory);
        const task = turboConfig.tasks[key] ?? turboConfig.tasks[taskName];
        for (const dependency of task?.dependsOn ?? []) {
            const separator = dependency.indexOf('#');
            if (separator !== -1) {
                visitTask(dependency.slice(0, separator), dependency.slice(separator + 1));
            } else if (dependency.startsWith('^')) {
                const dependencyTask = dependency.slice(1);
                for (const child of workspaceDependencies(workspacePackage.manifest)) {
                    if (packages.get(child).manifest.scripts?.[dependencyTask]) visitTask(child, dependencyTask);
                }
            } else {
                visitTask(name, dependency);
            }
        }
    };
    for (const name of suites) visitTask(name, 'test:integration');

    const allDirectories = new Set();
    const job = workflowJob(workspace, 'integration');
    if (job) {
        globalFiles.add(job.file);
        for (const localPath of localUses(job.source)) allDirectories.add(localPath);
    }
    return { directories, globalFiles, allDirectories };
}

/**
 * Finds what the reusable workflow behind a CI job reads: the workflow file, its local actions, and
 * the root scripts it runs through `pnpm run` with their relative imports.
 */
function calledWorkflowInputs(workspace, jobName) {
    const files = new Set();
    const directories = new Set();
    const scripts = workspace.rootManifest.scripts ?? {};
    const job = workflowJob(workspace, jobName);
    for (const [, workflow] of job?.source.matchAll(/^\s*uses:\s+\.\/(\.github\/workflows\/[^#\s@]+)/gm) ?? []) {
        files.add(workflow);
        const source = workspace.read(workflow);
        for (const localPath of localUses(source)) directories.add(localPath);
        for (const [, name] of source.matchAll(/\bpnpm\s+run\s+([\w:-]+)/g)) {
            for (const [, script] of (scripts[name] ?? '').matchAll(/\bnode\s+([^\s"'`]+\.mjs)/g)) {
                files.add(path.posix.normalize(script));
                for (const [, specifier] of workspace
                    .read(script)
                    .matchAll(/\bimport\s[^'"]*['"](\.{1,2}\/[^'"]+)['"]/g)) {
                    files.add(path.posix.join(path.posix.dirname(script), specifier));
                }
            }
        }
    }
    return { files, directories };
}

/** Combines a set of workspace packages with the reusable workflow a CI job calls for them. */
function jobInputs(workspace, jobName, selectsPackage) {
    const names = [...workspace.packages.values()].filter(selectsPackage).map(({ name }) => name);
    const workflow = calledWorkflowInputs(workspace, jobName);
    const directories = dependencyClosure(workspace.packages, names, BUILD_DEPENDENCY_FIELDS);
    for (const directory of workflow.directories) directories.add(directory);
    return { files: workflow.files, directories };
}

/** Finds what the engine comparison builds and runs: the benchmark packages and their workflow. */
export function benchmarkInputs(workspace) {
    return jobInputs(workspace, 'engine-comparison', ({ directory }) => directory.startsWith('benchmarks/'));
}

/**
 * Finds what the external consumer test packs and runs: the public tools, which set
 * `publishConfig.access: "public"` as scripts/utils/tool-packages.mjs reads them, and the workflow.
 */
export function externalConsumerInputs(workspace) {
    return jobInputs(
        workspace,
        'external-consumer',
        ({ directory, manifest }) =>
            directory.startsWith('tools/') && manifest.private !== true && manifest.publishConfig?.access === 'public',
    );
}
