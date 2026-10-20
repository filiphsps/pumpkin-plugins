#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Command } from 'commander';
import { withDefaultTurboFlags } from './utils/turbo-args.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const turboCli = path.join(workspaceRoot, 'node_modules/turbo/bin/turbo');
const alreadyPreparedVariable = 'PUMPKIN_PLUGINS_STATIC_HERMES_PREPARED';

/** Check whether the selected Turbo task graph contains a plugin that uses Static Hermes.
 * @param graph - Turbo's dry-run task graph.
 * @param root - Workspace root used to resolve plugin manifests.
 * @param taskName - Turbo task name selected for the build.
 * @returns Whether a selected build task belongs to a non-QuickJS plugin.
 */
export function hasStaticHermesBuild(graph, root = workspaceRoot, taskName = 'build') {
    const packagesDirectory = path.join(root, 'packages');
    const engines = new Map();
    for (const entry of fs.readdirSync(packagesDirectory, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const manifestPath = path.join(packagesDirectory, entry.name, 'package.json');
        if (!fs.existsSync(manifestPath)) continue;
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (manifest.pumpkinPlugin) engines.set(manifest.name, manifest.pumpkinPlugin.engine ?? 'static-hermes');
    }

    return graph.tasks.some(
        ({ package: packageName, task }) =>
            task === taskName && engines.has(packageName) && engines.get(packageName) !== 'quickjs',
    );
}

/** Remove pnpm's separator before forwarding the remaining arguments to Turbo.
 * @param args - Arguments received by this build script.
 * @returns Arguments with the first `--` separator removed.
 */
export function normalizeTurboArgs(args) {
    const separator = args.indexOf('--');
    return separator === -1 ? args : [...args.slice(0, separator), ...args.slice(separator + 1)];
}

/** Choose the Turbo task from the wrapper flags and retain all Turbo arguments for forwarding.
 * @param args - Arguments received by the root build script.
 * @returns The selected Turbo task, forwarded arguments, and dry-run mode.
 */
export function normalizeBuildRequest(args) {
    const program = new Command()
        .name('pumpkin-plugins-build')
        .description('Run the selected Turbo build tasks.')
        .allowUnknownOption()
        .allowExcessArguments()
        .option('--parse-ts', 'Run the build:parse-ts Turbo task')
        .option('--dry [format]', 'Forward Turbo dry-run mode without preparing Hermes')
        .parse(normalizeTurboArgs(args), { from: 'user' });
    const { parseTs, dry } = program.opts();
    const forwardedArgs = [...program.args];
    if (dry !== undefined) forwardedArgs.push(dry === true ? '--dry' : `--dry=${dry}`);
    return {
        task: parseTs ? 'build:parse-ts' : 'build',
        args: forwardedArgs,
        dryRun: dry !== undefined,
    };
}

/**
 * Build the runtime package, then import it. The package exports only `dist/`, which a fresh clone
 * does not have, so a static import would fail before any build could run.
 *
 * @param root - Workspace root that owns the runtime package.
 * @param env - Isolated environment for the runtime build.
 * @param spawn - Process runner, injectable for unit tests.
 * @returns The built runtime package module.
 * @throws {Error} If the runtime build exits unsuccessfully.
 */
export async function loadStaticHermesRuntime(root, env, spawn = spawnSync) {
    const build = spawn('pnpm', ['--filter', '@pumpkin-plugins/static-hermes-runtime', 'build'], {
        cwd: root,
        env,
        stdio: 'inherit',
        shell: process.platform === 'win32',
    });
    if (build.error) throw build.error;
    if (build.status !== 0) {
        throw new Error(`Static Hermes runtime build exited with ${build.signal ?? build.status ?? 'unknown status'}`);
    }
    return import(pathToFileURL(path.join(root, 'tools/static-hermes-runtime/dist/index.js')).href);
}

/**
 * Prepare pinned Hermes artifacts with the built runtime package CLI.
 *
 * @param root - Workspace root that owns the runtime package.
 * @param env - Isolated environment for Hermes preparation.
 * @param spawn - Process runner, injectable for unit tests.
 * @throws {Error} If Hermes preparation exits unsuccessfully.
 */
export function runStaticHermesPreparation(root, env, spawn = spawnSync) {
    const staticHermesCli = path.join(root, 'tools/static-hermes-runtime/dist/cli.js');
    const result = spawn(process.execPath, [staticHermesCli, 'hermes', 'prepare'], {
        cwd: root,
        env,
        stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`Static Hermes preparation exited with ${result.signal ?? result.status ?? 'unknown status'}`);
    }
}

/** Prepare Hermes in an isolated environment so toolchain defaults do not change Turbo cache keys.
 * Accepts an optional workspace root, base environment, setup hook, runtime loader, and preparation runner.
 * @returns The environment prepared for the selected Turbo build.
 */
export async function prepareHermesInIsolatedEnvironment({
    workspaceRoot: root = workspaceRoot,
    env = process.env,
    setupEnvironment,
    loadRuntime = (runtimeEnvironment) => loadStaticHermesRuntime(root, runtimeEnvironment),
    runPrepare = (prepareEnvironment) => runStaticHermesPreparation(root, prepareEnvironment),
}) {
    const prepareEnvironment = Object.fromEntries(
        Object.entries(env).filter(([name]) => name !== alreadyPreparedVariable),
    );
    const { prepareStaticHermesBuild } = await loadRuntime(prepareEnvironment);
    await prepareStaticHermesBuild({
        workspaceRoot: root,
        env: prepareEnvironment,
        setupEnvironment,
        prepare: () => runPrepare(prepareEnvironment),
    });
    return prepareEnvironment;
}

/** Run the root Turbo build and prepare its shared Hermes inputs once when needed. */
async function build() {
    const { task, args, dryRun: requestedDryRun } = normalizeBuildRequest(process.argv.slice(2));
    if (requestedDryRun) {
        process.exitCode = runTurbo(task, args).status ?? 1;
        return;
    }

    const dryRun = runTurbo(task, ['--dry=json', ...args], { captureOutput: true });
    if (dryRun.status !== 0) {
        process.exitCode = dryRun.status ?? 1;
        return;
    }

    const graph = JSON.parse(dryRun.stdout);
    if (!Array.isArray(graph.tasks)) throw new Error('Turbo dry run did not return a task graph.');

    let env = process.env;
    if (hasStaticHermesBuild(graph, workspaceRoot, task)) {
        const preparedEnvironment = await prepareHermesInIsolatedEnvironment({ workspaceRoot });
        env = buildTaskEnvironment(process.env, preparedEnvironment);
    }

    process.exitCode = runTurbo(task, args, { env }).status ?? 1;
}

/** Pass the shared cache location to Turbo without exposing host-specific toolchain defaults.
 * @param env - Environment inherited by the Turbo build.
 * @param preparedEnvironment - Environment returned by Hermes preparation.
 * @returns The Turbo environment with the shared cache and preparation marker.
 */
export function buildTaskEnvironment(env, preparedEnvironment) {
    const cacheDirectory = preparedEnvironment.STATIC_HERMES_CACHE_DIR;
    if (!cacheDirectory) throw new Error('Static Hermes preparation did not configure STATIC_HERMES_CACHE_DIR');
    return { ...env, STATIC_HERMES_CACHE_DIR: cacheDirectory, [alreadyPreparedVariable]: '1' };
}

/** Run the selected Turbo task, optionally capturing its JSON task graph.
 * @param task - Turbo task to run.
 * @param args - Arguments forwarded to Turbo.
 * @param options - Output and environment options.
 * @returns Turbo's process result.
 */
function runTurbo(task, args, { captureOutput = false, env = process.env } = {}) {
    const result = spawnSync(process.execPath, [turboCli, ...withDefaultTurboFlags(['run', task, ...args])], {
        cwd: workspaceRoot,
        env,
        encoding: 'utf8',
        stdio: captureOutput ? ['inherit', 'pipe', 'inherit'] : 'inherit',
    });
    if (result.error) throw result.error;
    return result;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    build().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
