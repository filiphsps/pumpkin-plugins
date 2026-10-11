import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolvePumpkinBinary as resolvePinnedBinary } from '../tools/test-harness/src/binary.ts';
import { readTarget, targetEnvironment } from './pumpkin-targets.mjs';

/** Lists every plugin package and the WASM output declared in its manifest. */
export function listPluginBuilds(root) {
    const packagesDir = path.join(root, 'packages');
    return fs
        .readdirSync(packagesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => {
            const packageDir = path.join(packagesDir, entry.name);
            const manifestPath = path.join(packageDir, 'package.json');
            if (!fs.existsSync(manifestPath)) return undefined;
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            const output = manifest.pumpkinPlugin?.output;
            if (typeof output !== 'string') return undefined;
            const outputPath = path.resolve(packageDir, output);
            const relativeOutput = path.relative(packageDir, outputPath);
            if (
                relativeOutput.startsWith('..') ||
                path.isAbsolute(relativeOutput) ||
                path.extname(outputPath) !== '.wasm'
            ) {
                throw new Error(`${manifestPath} has an unsafe pumpkinPlugin.output: ${output}`);
            }
            return { name: entry.name, packageDir, outputPath };
        })
        .filter(Boolean)
        .sort((a, b) => a.name.localeCompare(b.name));
}

/** Copies a built plugin into Pumpkin's watched directory, overwriting regular files in place. */
export function copyPluginBuild(plugin, serverPluginsDir) {
    fs.mkdirSync(serverPluginsDir, { recursive: true });
    const destination = path.join(serverPluginsDir, `${plugin.name}.wasm`);
    try {
        if (fs.lstatSync(destination).isSymbolicLink()) fs.unlinkSync(destination);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    fs.copyFileSync(plugin.outputPath, destination);
    return destination;
}

/** Resolves the pinned server paired with the selected API profile. */
export async function resolvePumpkinBinary({ root = path.resolve(import.meta.dirname, '..'), apiTarget } = {}) {
    return {
        binary: await resolvePinnedBinary({ root, target: apiTarget }),
        release: readTarget(root, apiTarget).server.tag
    };
}

function fileHash(file) {
    try {
        return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    } catch (error) {
        if (error.code === 'ENOENT') return undefined;
        throw error;
    }
}

function watchBuildOutputs(plugins, serverPluginsDir) {
    const previousHashes = new Map(plugins.map((plugin) => [plugin.name, fileHash(plugin.outputPath)]));
    const watchers = [];
    const timers = new Map();
    let rejectFailure;
    const failure = new Promise((_, reject) => {
        rejectFailure = reject;
    });
    failure.catch(() => {});

    const fail = (error) => {
        rejectFailure(error);
    };

    const inspect = (plugin) => {
        timers.delete(plugin.name);
        try {
            const hash = fileHash(plugin.outputPath);
            if (hash === previousHashes.get(plugin.name)) return;
            previousHashes.set(plugin.name, hash);
            if (!hash) return;
            copyPluginBuild(plugin, serverPluginsDir);
            console.log(`Copied ${plugin.name}.wasm into the server plugins folder; Pumpkin should hot-reload it.`);
        } catch (error) {
            fail(error);
        }
    };

    const scheduleInspect = (plugin) => {
        clearTimeout(timers.get(plugin.name));
        timers.set(
            plugin.name,
            setTimeout(() => inspect(plugin), 100)
        );
    };

    for (const plugin of plugins) {
        const outputDir = path.dirname(plugin.outputPath);
        fs.mkdirSync(outputDir, { recursive: true });
        const watcher = fs.watch(outputDir, (_eventType, filename) => {
            if (!filename || filename.toString() === path.basename(plugin.outputPath)) scheduleInspect(plugin);
        });
        watcher.on('error', fail);
        watchers.push(watcher);
    }

    return {
        failure,
        close() {
            for (const timer of timers.values()) clearTimeout(timer);
            for (const watcher of watchers) watcher.close();
        }
    };
}

function configureHotReload(config, hotReload) {
    const newline = config.includes('\r\n') ? '\r\n' : '\n';
    const lines = config === '' ? [] : config.split(/\r?\n/);
    const pluginsStart = lines.findIndex((line) => /^\s*\[plugins\]\s*(?:#.*)?$/.test(line));

    if (pluginsStart === -1) {
        const section = ['[plugins]', `hot_reload = ${hotReload}`];
        if (lines.at(-1) === '') lines.splice(lines.length - 1, 0, ...section);
        else lines.push(...(lines.length > 0 ? ['', ...section] : section));
    } else {
        let pluginsEnd = lines.findIndex((line, index) => index > pluginsStart && /^\s*\[/.test(line));
        if (pluginsEnd === -1) pluginsEnd = lines.length;
        const hotReloadLine = lines.findIndex(
            (line, index) => index > pluginsStart && index < pluginsEnd && /^\s*hot_reload\s*=/.test(line)
        );
        if (hotReloadLine === -1) {
            lines.splice(pluginsStart + 1, 0, `hot_reload = ${hotReload}`);
        } else {
            const line = lines[hotReloadLine] ?? '';
            const indentation = line.match(/^\s*/)?.[0] ?? '';
            const comment = line.match(/\s+#.*$/)?.[0] ?? '';
            lines[hotReloadLine] = `${indentation}hot_reload = ${hotReload}${comment}`;
        }
    }

    return lines.join(newline);
}

function createServerDirectory(serverDir, hotReload) {
    const pluginsDir = path.join(serverDir, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    const configFile = path.join(serverDir, 'pumpkin.toml');
    const config = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : '[plugins]\n';
    fs.writeFileSync(configFile, configureHotReload(config, hotReload));
    return pluginsDir;
}

function spawnChild(command, args, options, spawnImpl = spawn) {
    const child = spawnImpl(command, args, options);
    const done = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    return { child, done };
}

function pnpmCommand() {
    return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

/** Starts Turbo's one-shot build for all workspace plugins. */
export function startInitialBuild(root, spawnImpl = spawn, env = process.env) {
    return spawnChild(
        pnpmCommand(),
        ['exec', 'turbo', 'run', 'build', '--ui=stream', '--log-order=stream'],
        {
            cwd: root,
            stdio: 'inherit',
            shell: process.platform === 'win32',
            env
        },
        spawnImpl
    );
}

/** Starts a server running all workspace plugins with optional build and plugin hot reload. */
export async function runDev({
    root = path.resolve(import.meta.dirname, '..'),
    spawnImpl = spawn,
    resolveBinary = resolvePumpkinBinary,
    hotReload = true,
    nightly = false,
    apiTarget = nightly ? 'nightly' : process.env.PUMPKIN_API_TARGET || 'release',
    prepareEnvironment = targetEnvironment
} = {}) {
    const plugins = listPluginBuilds(root);
    if (plugins.length === 0) throw new Error('No plugin packages with pumpkinPlugin.output were found');

    const serverDir = path.join(root, '.cache', 'pumpkin-dev');
    const serverPluginsDir = createServerDirectory(serverDir, hotReload);
    const devEnv = await prepareEnvironment(root, {
        ...process.env,
        PUMPKIN_API_TARGET: apiTarget,
        PUMPKIN_DEV_MODE: '1'
    });
    let outputs;
    let turbo;
    let server;
    let shuttingDown = false;
    let resolveShutdown;
    const shutdown = new Promise((resolve) => {
        resolveShutdown = resolve;
    });

    const stopChildren = (signal = 'SIGTERM') => {
        if (shuttingDown) return;
        shuttingDown = true;
        turbo?.child.kill(signal);
        server?.child.kill(signal);
    };
    const handleSignal = (signal) => {
        process.exitCode = signal === 'SIGINT' ? 130 : 143;
        stopChildren(signal);
        resolveShutdown();
    };
    const onInterrupt = () => handleSignal('SIGINT');
    const onTerminate = () => handleSignal('SIGTERM');
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onTerminate);

    try {
        console.log(`Building every plugin for Pumpkin target ${apiTarget}.`);
        const initialBuild = startInitialBuild(root, spawnImpl, devEnv);
        turbo = initialBuild;
        const buildResult = initialBuild.done.then(({ code, signal }) => {
            if (!shuttingDown && (code !== 0 || signal)) {
                throw new Error(`turbo run build exited (${signal ?? code ?? 'unknown status'})`);
            }
        });
        const startup = Promise.all([buildResult, resolveBinary({ root, apiTarget })]);
        const startupResult = await Promise.race([startup, shutdown]);
        if (shuttingDown) return;
        const [, resolvedBinary] = startupResult;

        for (const plugin of plugins) copyPluginBuild(plugin, serverPluginsDir);
        const backgroundTasks = [];
        if (hotReload) {
            outputs = watchBuildOutputs(plugins, serverPluginsDir);
            turbo = spawnChild(
                pnpmCommand(),
                ['exec', 'turbo', 'watch', 'build', '--force', '--ui=stream', '--log-order=stream'],
                {
                    cwd: root,
                    stdio: 'inherit',
                    shell: process.platform === 'win32',
                    env: devEnv
                },
                spawnImpl
            );
            const turboExit = turbo.done.then(({ code, signal }) => {
                if (!shuttingDown) throw new Error(`turbo watch build exited (${signal ?? code ?? 'unknown status'})`);
            });
            backgroundTasks.push(
                turboExit.then(() => new Promise(() => {})),
                outputs.failure
            );
        }

        const { binary: serverBinary, release } = resolvedBinary;
        console.log(`Starting Pumpkin ${release} with ${plugins.length} plugins in ${serverDir}`);
        server = spawnChild(serverBinary, [], { cwd: serverDir, stdio: 'inherit' }, spawnImpl);
        const serverResult = await Promise.race([server.done, ...backgroundTasks]);
        if (serverResult && !shuttingDown) process.exitCode = serverResult.code ?? (serverResult.signal ? 1 : 0);
    } finally {
        process.removeListener('SIGINT', onInterrupt);
        process.removeListener('SIGTERM', onTerminate);
        outputs?.close();
        stopChildren('SIGTERM');
    }
}

/** Parses dev server command-line arguments. */
export function parseDevArgs(args) {
    const index = args.indexOf('--api-target');
    if (index >= 0 && (!args[index + 1] || args[index + 1].startsWith('--')))
        throw new Error('--api-target requires a target');
    const nightly = args.includes('--nightly');
    const apiTarget = index >= 0 ? args[index + 1] : nightly ? 'nightly' : process.env.PUMPKIN_API_TARGET || 'release';
    if (nightly && apiTarget !== 'nightly') throw new Error('--nightly and --api-target conflict');
    const known = new Set(['--no-hot-reload', '--nightly', '--api-target']);
    const unknown = args.find((arg, i) => !(index >= 0 && i === index + 1) && !known.has(arg));
    if (unknown) throw new Error(`Unknown dev argument: ${unknown}`);
    return { hotReload: !args.includes('--no-hot-reload'), nightly, apiTarget };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    let command = 'pnpm dev';
    try {
        const options = parseDevArgs(process.argv.slice(2));
        if (!options.hotReload) command = 'pnpm dev:no-hot-reload';
        await runDev(options);
    } catch (error) {
        console.error(`${command}: ${error.message}`);
        process.exitCode = 1;
    }
}
