#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareStaticHermesBuild } from '../tools/static-hermes-runtime/bin/toolchain-environment.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const turboCli = path.join(workspaceRoot, 'node_modules/turbo/bin/turbo');
const alreadyPreparedVariable = 'PUMPKIN_PLUGINS_STATIC_HERMES_PREPARED';

/** Check whether the selected Turbo build graph contains a Static Hermes plugin. */
export function hasStaticHermesBuild(graph, root = workspaceRoot) {
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
            task === 'build' && engines.has(packageName) && engines.get(packageName) !== 'quickjs'
    );
}

/** Remove the separator pnpm uses to delimit script arguments from its own options. */
export function normalizeTurboArgs(args) {
    const separator = args.indexOf('--');
    return separator === -1 ? args : [...args.slice(0, separator), ...args.slice(separator + 1)];
}

/** Prepare Hermes in a private environment so toolchain defaults do not change Turbo cache keys. */
export async function prepareHermesInIsolatedEnvironment({
    workspaceRoot: root = workspaceRoot,
    env = process.env,
    setupEnvironment,
    runPrepare = (prepareEnvironment) => {
        const prepareScript = path.join(root, 'tools/static-hermes-runtime/bin/prepare-hermes.mjs');
        const result = spawnSync(process.execPath, [prepareScript], {
            cwd: root,
            env: prepareEnvironment,
            stdio: 'inherit'
        });
        if (result.error) throw result.error;
        if (result.status !== 0) {
            throw new Error(
                `Static Hermes preparation exited with ${result.signal ?? result.status ?? 'unknown status'}`
            );
        }
    }
}) {
    const prepareEnvironment = Object.fromEntries(
        Object.entries(env).filter(([name]) => name !== alreadyPreparedVariable)
    );
    await prepareStaticHermesBuild({
        workspaceRoot: root,
        env: prepareEnvironment,
        setupEnvironment,
        prepare: () => runPrepare(prepareEnvironment)
    });
    return prepareEnvironment;
}

/** Run the root Turbo build and prepare its shared Hermes inputs once when needed. */
async function build() {
    const args = normalizeTurboArgs(process.argv.slice(2));
    if (args.some((argument) => argument === '--dry' || argument.startsWith('--dry='))) {
        process.exitCode = runTurbo(args).status ?? 1;
        return;
    }

    const dryRun = runTurbo(['--dry=json', ...args], { captureOutput: true });
    if (dryRun.status !== 0) {
        process.exitCode = dryRun.status ?? 1;
        return;
    }

    const graph = JSON.parse(dryRun.stdout);
    if (!Array.isArray(graph.tasks)) throw new Error('Turbo dry run did not return a task graph.');

    let env = process.env;
    if (hasStaticHermesBuild(graph)) {
        await prepareHermesInIsolatedEnvironment({ workspaceRoot });
        env = { ...process.env, [alreadyPreparedVariable]: '1' };
    }

    process.exitCode = runTurbo(args, { env }).status ?? 1;
}

/** Run Turbo, optionally capturing its JSON task graph instead of printing it. */
function runTurbo(args, { captureOutput = false, env = process.env } = {}) {
    const result = spawnSync(process.execPath, [turboCli, 'run', 'build', ...args], {
        cwd: workspaceRoot,
        env,
        encoding: 'utf8',
        stdio: captureOutput ? ['inherit', 'pipe', 'inherit'] : 'inherit'
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
