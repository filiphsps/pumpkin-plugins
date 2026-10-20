import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { discoverComponents } from '@pumpkin-plugins/docs/node';
import { Command } from 'commander';
// Import the harness modules directly: its index also loads instance.ts, which Node can't strip.
import { resolvePumpkinBinary as resolvePinnedPumpkinBinary } from '../tools/test-harness/src/binary.ts';
import { PUMPKIN_RELEASE } from '../tools/test-harness/src/pumpkin-version.ts';
import { assetName, isMuslLinux, parseChecksums } from '../tools/test-harness/src/util.ts';

const REPOSITORY = 'Pumpkin-MC/Pumpkin';
const RELEASES_API = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const NIGHTLY_API = `https://api.github.com/repos/${REPOSITORY}/releases/tags/nightly`;
const RELEASE_METADATA_TTL_MS = 24 * 60 * 60 * 1000;
const RELEASE_METADATA_FILE = 'latest-release.json';
const NIGHTLY_METADATA_FILE = 'latest-nightly.json';
const CHILD_SHUTDOWN_TIMEOUT_MS = 10_000;

/** Finds a release asset by name. */
export function releaseAsset(release, name) {
    const asset = release.assets?.find((candidate) => candidate.name === name);
    if (!asset?.browser_download_url) {
        throw new Error(`Pumpkin release ${release.tag_name ?? '(unknown)'} is missing ${name}`);
    }
    return asset;
}

/** Lists every plugin package and the WASM output declared in its manifest. */
export function listPluginBuilds(root) {
    return discoverComponents(root, 'packages')
        .map(({ slug, directory: packageDir, metadataFile: manifestPath }) => {
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
            return { name: slug, packageDir, outputPath };
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

function isValidRelease(release) {
    return (
        typeof release?.tag_name === 'string' &&
        release.tag_name.length > 0 &&
        release.prerelease === false &&
        release.draft === false &&
        Array.isArray(release.assets)
    );
}

function isValidNightlyRelease(release) {
    return (
        release?.tag_name === 'nightly' &&
        release.prerelease === true &&
        release.draft === false &&
        Array.isArray(release.assets)
    );
}

function readReleaseMetadata(metadataPath, isValid = isValidRelease) {
    try {
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        if (!Number.isFinite(metadata.fetchedAt) || !isValid(metadata.release)) return undefined;
        return metadata;
    } catch {
        return undefined;
    }
}

function writeReleaseMetadata(metadataPath, metadata) {
    fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
    const partial = `${metadataPath}.${process.pid}.partial`;
    try {
        fs.writeFileSync(partial, JSON.stringify(metadata));
        fs.renameSync(partial, metadataPath);
    } catch (error) {
        try {
            fs.rmSync(partial, { force: true });
        } catch {}
        throw error;
    }
}

async function isRateLimitResponse(response) {
    if (response.status === 429) return true;
    if (response.status !== 403) return false;
    if (
        response.headers?.get?.('x-ratelimit-remaining') === '0' ||
        (response.headers?.get?.('retry-after') !== null && response.headers?.get?.('retry-after') !== undefined)
    )
        return true;
    try {
        const body = await (response.clone?.() ?? response).json();
        return /rate limit/i.test(body?.message ?? '');
    } catch {
        return false;
    }
}

async function getLatestRelease(fetchImpl) {
    let response;
    try {
        response = await fetchImpl(RELEASES_API, {
            headers: {
                Accept: 'application/vnd.github+json',
                'User-Agent': 'pumpkin-plugins-dev',
            },
        });
    } catch (cause) {
        const error = new Error('Could not reach the latest stable Pumpkin release endpoint.', { cause });
        error.retryable = true;
        throw error;
    }
    if (!response.ok) {
        const error = new Error(`Could not get the latest stable Pumpkin release (HTTP ${response.status})`);
        error.retryable = await isRateLimitResponse(response);
        throw error;
    }
    const release = await response.json();
    if (release?.prerelease || release?.draft) {
        throw new Error(`GitHub returned a prerelease instead of a stable Pumpkin release (${release?.tag_name})`);
    }
    if (!isValidRelease(release)) throw new Error('GitHub returned invalid latest stable Pumpkin release metadata.');
    return release;
}

async function getLatestNightly(fetchImpl) {
    let response;
    try {
        response = await fetchImpl(NIGHTLY_API, {
            headers: {
                Accept: 'application/vnd.github+json',
                'User-Agent': 'pumpkin-plugins-dev',
            },
        });
    } catch (cause) {
        const error = new Error('Could not reach the latest Pumpkin nightly endpoint.', { cause });
        error.retryable = true;
        throw error;
    }
    if (!response.ok) {
        const error = new Error(`Could not get the latest Pumpkin nightly build (HTTP ${response.status})`);
        error.retryable = await isRateLimitResponse(response);
        throw error;
    }
    const release = await response.json();
    if (!isValidNightlyRelease(release)) {
        throw new Error(
            `GitHub returned invalid latest Pumpkin nightly metadata (${release?.tag_name ?? '(unknown)'})`,
        );
    }
    return release;
}

async function fetchText(fetchImpl, url) {
    const response = await fetchImpl(url);
    if (!response.ok) throw new Error(`GET ${url} failed: HTTP ${response.status}`);
    return response.text();
}

/** Resolves the newest stable or nightly Pumpkin binary, verifies its checksum, and caches it. */
export async function resolveLatestPumpkinBinary({
    root,
    platform = process.platform,
    arch = process.arch,
    musl = isMuslLinux(),
    env = process.env,
    fetchImpl = fetch,
    now = Date.now,
    nightly = false,
}) {
    if (env.PUMPKIN_BIN) {
        if (!fs.existsSync(env.PUMPKIN_BIN)) throw new Error(`PUMPKIN_BIN does not exist: ${env.PUMPKIN_BIN}`);
        return { binary: path.resolve(env.PUMPKIN_BIN), release: 'local PUMPKIN_BIN' };
    }

    const cacheDir = env.PUMPKIN_CACHE_DIR || path.join(root, '.cache', 'pumpkin');
    const metadataPath = path.join(cacheDir, nightly ? NIGHTLY_METADATA_FILE : RELEASE_METADATA_FILE);
    const isValidMetadata = nightly ? isValidNightlyRelease : isValidRelease;
    const cachedMetadata = readReleaseMetadata(metadataPath, isValidMetadata);
    const currentTime = now();
    const cacheIsFresh =
        !nightly &&
        cachedMetadata &&
        currentTime >= cachedMetadata.fetchedAt &&
        currentTime - cachedMetadata.fetchedAt < RELEASE_METADATA_TTL_MS;
    let release;
    if (cacheIsFresh && env.PUMPKIN_REFRESH_RELEASE !== '1') {
        release = cachedMetadata.release;
    } else {
        try {
            release = nightly ? await getLatestNightly(fetchImpl) : await getLatestRelease(fetchImpl);
            writeReleaseMetadata(metadataPath, { fetchedAt: now(), release });
        } catch (error) {
            if (!cachedMetadata || !error.retryable) throw error;
            console.warn(
                `Could not refresh Pumpkin release metadata (${error.message}); using cached release ${cachedMetadata.release.tag_name}.`,
            );
            release = cachedMetadata.release;
        }
    }
    const assetFile = assetName(platform, arch, musl);
    const binaryAsset = releaseAsset(release, assetFile);
    if (nightly && !Number.isSafeInteger(binaryAsset.id)) {
        throw new Error(`Pumpkin nightly asset ${assetFile} is missing its release asset ID`);
    }
    const safeTag = String(release.tag_name).replace(/[^\w.+-]/g, '_');
    const assetVersion = nightly ? `${safeTag}-${binaryAsset.id}` : safeTag;
    const target = path.join(cacheDir, `${assetVersion}-${assetFile}`);
    if (fs.existsSync(target)) return { binary: target, release: release.tag_name };

    let expected;
    if (nightly) {
        const digest = /^sha256:([0-9a-f]{64})$/i.exec(binaryAsset.digest ?? '');
        expected = digest?.[1].toLowerCase();
        if (!expected) throw new Error(`Pumpkin nightly metadata for ${assetFile} has no valid SHA-256 digest`);
    } else {
        const checksumAsset = releaseAsset(release, 'checksums.sha256');
        const sums = parseChecksums(await fetchText(fetchImpl, checksumAsset.browser_download_url));
        expected = sums.get(assetFile);
        if (!expected) throw new Error(`checksums.sha256 for ${release.tag_name} has no entry for ${assetFile}`);
    }

    console.log(`Downloading Pumpkin ${release.tag_name} (${assetFile})...`);
    const response = await fetchImpl(binaryAsset.browser_download_url);
    if (!response.ok) throw new Error(`Downloading ${assetFile} failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== expected) throw new Error(`Checksum mismatch for ${assetFile}: expected ${expected}, got ${actual}`);

    fs.mkdirSync(cacheDir, { recursive: true });
    const partial = `${target}.${process.pid}.partial`;
    fs.writeFileSync(partial, bytes, { mode: 0o755 });
    fs.renameSync(partial, target);
    return { binary: target, release: release.tag_name };
}

/** Resolves the pinned Pumpkin release, or the newest stable or nightly build when asked for one. */
export async function resolveDevPumpkinBinary({ root, latest = false, nightly = false }) {
    if (latest || nightly) return resolveLatestPumpkinBinary({ root, nightly });
    const binary = await resolvePinnedPumpkinBinary();
    return { binary, release: process.env.PUMPKIN_BIN ? 'local PUMPKIN_BIN' : PUMPKIN_RELEASE };
}

function fileHash(file) {
    try {
        return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    } catch (error) {
        if (error.code === 'ENOENT') return undefined;
        throw error;
    }
}

function watchBuildOutputs(plugins, serverPluginsDir, watchImpl) {
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
            setTimeout(() => inspect(plugin), 100),
        );
    };

    for (const plugin of plugins) {
        const outputDir = path.dirname(plugin.outputPath);
        fs.mkdirSync(outputDir, { recursive: true });
        const watcher = watchImpl(outputDir, (_eventType, filename) => {
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
        },
    };
}

function configureHotReload(config, hotReload) {
    const newline = config.includes('\r\n') ? '\r\n' : '\n';
    const lines = config === '' ? [] : config.split(/\r?\n/);
    const pluginsStart = lines.findIndex((line) =>
        /^\s*\[\s*(?:plugins|"plugins"|'plugins')\s*\]\s*(?:#.*)?$/.test(line),
    );

    if (pluginsStart === -1) {
        const section = ['[plugins]', `hot_reload = ${hotReload}`];
        if (lines.at(-1) === '') lines.splice(lines.length - 1, 0, ...section);
        else lines.push(...(lines.length > 0 ? ['', ...section] : section));
    } else {
        let pluginsEnd = lines.findIndex((line, index) => index > pluginsStart && /^\s*\[/.test(line));
        if (pluginsEnd === -1) pluginsEnd = lines.length;
        const hotReloadLine = lines.findIndex(
            (line, index) =>
                index > pluginsStart &&
                index < pluginsEnd &&
                /^\s*(?:hot_reload|"hot_reload"|'hot_reload')\s*=/.test(line),
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
    let exited = false;
    const done = new Promise((resolve, reject) => {
        child.on('error', (error) => {
            if (child.pid === undefined && !exited) {
                exited = true;
                reject(error);
            }
        });
        child.once('exit', (code, signal) => {
            exited = true;
            resolve({ code, signal });
        });
    });
    return {
        child,
        done,
        get exited() {
            return exited;
        },
    };
}

function signalChild(task, signal) {
    try {
        task.child.kill(signal);
    } catch (error) {
        console.warn(`Could not send ${signal} to a dev child process: ${error}`);
    }
}

async function stopChild(task, signal, timeoutMs) {
    if (task.exited) return task.done.catch(() => {});

    signalChild(task, signal);
    let timeout;
    const exited = await Promise.race([
        task.done.then(
            () => true,
            () => true,
        ),
        new Promise((resolve) => {
            timeout = setTimeout(() => resolve(false), timeoutMs);
        }),
    ]);
    clearTimeout(timeout);

    if (!exited && !task.exited) signalChild(task, 'SIGKILL');
    await task.done.catch(() => {});
}

function pnpmCommand() {
    return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

/** Starts the root build wrapper for all workspace plugins. */
export function startInitialBuild(root, spawnImpl = spawn, env = process.env, parseTypeScript = false, turboArgs = []) {
    return spawnChild(
        pnpmCommand(),
        ['run', 'build', '--', '--ui=stream', ...(parseTypeScript ? ['--parse-ts'] : []), ...turboArgs],
        {
            cwd: root,
            stdio: 'inherit',
            shell: process.platform === 'win32',
            env,
        },
        spawnImpl,
    );
}

/** Starts a dev server with optional plugin hot reload and release-mode builds. */
export async function runDev({
    root = path.resolve(import.meta.dirname, '..'),
    spawnImpl = spawn,
    watchImpl = fs.watch,
    resolveBinary = resolveDevPumpkinBinary,
    hotReload = true,
    latest = false,
    nightly = false,
    release = false,
    parseTypeScript = false,
    turboArgs = [],
    shutdownTimeoutMs = CHILD_SHUTDOWN_TIMEOUT_MS,
    signalSource = process,
} = {}) {
    const plugins = listPluginBuilds(root);
    if (plugins.length === 0) throw new Error('No plugin packages with pumpkinPlugin.output were found');

    const serverDir = path.join(root, '.cache', 'pumpkin-dev');
    const serverPluginsDir = createServerDirectory(serverDir, hotReload);
    const buildEnv = { ...process.env };
    // biome-ignore lint/performance/noDelete: dev script, performant isn't super important here.
    if (release) delete buildEnv.PUMPKIN_DEV_MODE;
    else buildEnv.PUMPKIN_DEV_MODE = '1';
    let outputs;
    const children = [];
    let shuttingDown = false;
    let shutdownSignal = 'SIGINT';
    let resolveShutdown;
    const shutdown = new Promise((resolve) => {
        resolveShutdown = resolve;
    });

    const stopChildren = (signal) => Promise.all(children.map((child) => stopChild(child, signal, shutdownTimeoutMs)));

    const handleSignal = (signal) => {
        if (shuttingDown) {
            for (const task of children) {
                if (!task.exited) signalChild(task, 'SIGKILL');
            }
            return;
        }

        shuttingDown = true;
        shutdownSignal = signal;
        process.exitCode = signal === 'SIGINT' ? 130 : 143;
        resolveShutdown();
    };
    const onInterrupt = () => handleSignal('SIGINT');
    const onTerminate = () => handleSignal('SIGTERM');
    signalSource.on('SIGINT', onInterrupt);
    signalSource.on('SIGTERM', onTerminate);

    try {
        const target = nightly
            ? 'the latest Pumpkin nightly build'
            : latest
              ? 'the latest stable Pumpkin release'
              : `Pumpkin ${PUMPKIN_RELEASE}`;
        console.log(`Building every plugin, then launching ${target}.`);
        const initialBuild = startInitialBuild(root, spawnImpl, buildEnv, parseTypeScript, turboArgs);
        children.push(initialBuild);
        const buildResult = initialBuild.done.then(({ code, signal }) => {
            if (!shuttingDown && (code !== 0 || signal)) {
                throw new Error(`pnpm run build exited (${signal ?? code ?? 'unknown status'})`);
            }
        });
        const startup = Promise.all([buildResult, resolveBinary({ root, latest, nightly })]);
        const startupResult = await Promise.race([startup, shutdown]);
        if (shuttingDown) return;
        const [, resolvedBinary] = startupResult;

        for (const plugin of plugins) copyPluginBuild(plugin, serverPluginsDir);
        const backgroundTasks = [];
        if (hotReload) {
            outputs = watchBuildOutputs(plugins, serverPluginsDir, watchImpl);
            const turbo = spawnChild(
                pnpmCommand(),
                ['turbo', 'watch', parseTypeScript ? 'build:parse-ts' : 'build', '--ui=stream', ...turboArgs],
                {
                    cwd: root,
                    stdio: 'inherit',
                    shell: process.platform === 'win32',
                    env: buildEnv,
                },
                spawnImpl,
            );
            children.push(turbo);
            const turboExit = turbo.done.then(({ code, signal }) => {
                if (!shuttingDown) throw new Error(`turbo watch build exited (${signal ?? code ?? 'unknown status'})`);
            });
            backgroundTasks.push(
                turboExit.then(() => new Promise(() => {})),
                outputs.failure,
            );
        }

        const { binary: serverBinary, release: serverRelease } = resolvedBinary;
        console.log(`Starting Pumpkin ${serverRelease} with ${plugins.length} plugins in ${serverDir}`);
        const server = spawnChild(serverBinary, [], { cwd: serverDir, stdio: 'inherit' }, spawnImpl);
        children.push(server);
        const serverResult = await Promise.race([server.done, ...backgroundTasks, shutdown]);
        if (serverResult && !shuttingDown) process.exitCode = serverResult.code ?? (serverResult.signal ? 1 : 0);
    } finally {
        signalSource.removeListener('SIGINT', onInterrupt);
        signalSource.removeListener('SIGTERM', onTerminate);
        outputs?.close();
        await stopChildren(shutdownSignal);
    }
}

/** Parses dev server command-line arguments. */
export function parseDevArgs(args) {
    const devArgs = [];
    const turboArgs = [];
    for (const arg of args) {
        if (arg === '--') continue;
        if (!['--no-hot-reload', '--latest', '--nightly', '--release', '--parse-ts', '-h', '--help'].includes(arg)) {
            turboArgs.push(arg);
        } else {
            devArgs.push(arg);
        }
    }

    const program = new Command()
        .name('pumpkin-plugins-dev')
        .description('Build plugins and launch a local Pumpkin server.')
        .option('--no-hot-reload', 'Disable plugin rebuilds while files change')
        .option('--latest', 'Use the latest stable Pumpkin release instead of the pinned one')
        .option('--nightly', 'Use the latest Pumpkin nightly build')
        .option('--release', 'Build plugins with release settings (includes Market update checks)')
        .option('--parse-ts', 'Use Hermes TypeScript parsing for plugin builds')
        .parse(devArgs, { from: 'user' });
    const options = program.opts();
    return {
        hotReload: options.hotReload ?? true,
        latest: options.latest ?? false,
        nightly: options.nightly ?? false,
        release: options.release ?? false,
        parseTypeScript: options.parseTs ?? false,
        turboArgs,
    };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    const options = parseDevArgs(process.argv.slice(2));
    const command = options.hotReload ? 'pnpm dev' : 'pnpm dev:no-hot-reload';
    runDev(options).catch((error) => {
        console.error(`${command}: ${error.message}`);
        process.exitCode = 1;
    });
}
