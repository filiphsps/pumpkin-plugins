import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPOSITORY = 'Pumpkin-MC/Pumpkin';
const RELEASES_API = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;

/** Returns the Pumpkin release asset name for a platform. */
export function assetName(platform, arch) {
    const names = {
        'darwin-arm64': 'pumpkin-ARM64-macOS',
        'linux-x64': 'pumpkin-X64-Linux',
        'linux-arm64': 'pumpkin-ARM64-Linux',
        'win32-x64': 'pumpkin-X64-Windows.exe',
        'win32-arm64': 'pumpkin-ARM64-Windows.exe'
    };
    const asset = names[`${platform}-${arch}`];
    if (!asset) throw new Error(`No Pumpkin release binary for ${platform}-${arch}`);
    return asset;
}

/** Parses a sha256sum manifest into a map of asset name to digest. */
export function parseChecksums(text) {
    const checksums = new Map();
    for (const line of text.split('\n')) {
        const match = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line);
        if (match) checksums.set(match[2], match[1].toLowerCase());
    }
    return checksums;
}

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

async function getLatestRelease(fetchImpl) {
    const response = await fetchImpl(RELEASES_API, {
        headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'pumpkin-plugins-dev'
        }
    });
    if (!response.ok) throw new Error(`Could not get the latest stable Pumpkin release (HTTP ${response.status})`);
    const release = await response.json();
    if (release.prerelease || release.draft) {
        throw new Error(`GitHub returned a prerelease instead of a stable Pumpkin release (${release.tag_name})`);
    }
    return release;
}

async function fetchText(fetchImpl, url) {
    const response = await fetchImpl(url);
    if (!response.ok) throw new Error(`GET ${url} failed: HTTP ${response.status}`);
    return response.text();
}

/** Resolves the newest stable Pumpkin binary, verifies its checksum, and caches it. */
export async function resolvePumpkinBinary({
    root,
    platform = process.platform,
    arch = process.arch,
    env = process.env,
    fetchImpl = fetch
}) {
    if (env.PUMPKIN_BIN) {
        if (!fs.existsSync(env.PUMPKIN_BIN)) throw new Error(`PUMPKIN_BIN does not exist: ${env.PUMPKIN_BIN}`);
        return { binary: path.resolve(env.PUMPKIN_BIN), release: 'local PUMPKIN_BIN' };
    }

    const release = await getLatestRelease(fetchImpl);
    const assetFile = assetName(platform, arch);
    const binaryAsset = releaseAsset(release, assetFile);
    const checksumAsset = releaseAsset(release, 'checksums.sha256');
    const cacheDir = env.PUMPKIN_CACHE_DIR || path.join(root, '.cache', 'pumpkin');
    const safeTag = String(release.tag_name).replace(/[^\w.+-]/g, '_');
    const target = path.join(cacheDir, `${safeTag}-${assetFile}`);
    if (fs.existsSync(target)) return { binary: target, release: release.tag_name };

    const sums = parseChecksums(await fetchText(fetchImpl, checksumAsset.browser_download_url));
    const expected = sums.get(assetFile);
    if (!expected) throw new Error(`checksums.sha256 for ${release.tag_name} has no entry for ${assetFile}`);

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

function createServerDirectory(serverDir) {
    const pluginsDir = path.join(serverDir, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    const configFile = path.join(serverDir, 'pumpkin.toml');
    if (!fs.existsSync(configFile)) {
        fs.writeFileSync(configFile, '[plugins]\nhot_reload = true\n');
    }
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
export function startInitialBuild(root, spawnImpl = spawn) {
    return spawnChild(
        pnpmCommand(),
        ['exec', 'turbo', 'run', 'build', '--ui=stream', '--log-order=stream'],
        {
            cwd: root,
            stdio: 'inherit',
            shell: process.platform === 'win32'
        },
        spawnImpl
    );
}

/** Starts a server running all workspace plugins and watches builds for live updates. */
export async function runDev({
    root = path.resolve(import.meta.dirname, '..'),
    spawnImpl = spawn,
    resolveBinary = resolvePumpkinBinary
} = {}) {
    const plugins = listPluginBuilds(root);
    if (plugins.length === 0) throw new Error('No plugin packages with pumpkinPlugin.output were found');

    const serverDir = path.join(root, '.cache', 'pumpkin-dev');
    const serverPluginsDir = createServerDirectory(serverDir);
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
        console.log('Building every plugin, then launching the latest stable Pumpkin release.');
        const initialBuild = startInitialBuild(root, spawnImpl);
        turbo = initialBuild;
        const buildResult = initialBuild.done.then(({ code, signal }) => {
            if (!shuttingDown && (code !== 0 || signal)) {
                throw new Error(`turbo run build exited (${signal ?? code ?? 'unknown status'})`);
            }
        });
        const startup = Promise.all([buildResult, resolveBinary({ root })]);
        const startupResult = await Promise.race([startup, shutdown]);
        if (shuttingDown) return;
        const [, resolvedBinary] = startupResult;

        for (const plugin of plugins) copyPluginBuild(plugin, serverPluginsDir);
        outputs = watchBuildOutputs(plugins, serverPluginsDir);
        turbo = spawnChild(
            pnpmCommand(),
            ['exec', 'turbo', 'watch', 'build', '--ui=stream', '--log-order=stream'],
            {
                cwd: root,
                stdio: 'inherit',
                shell: process.platform === 'win32'
            },
            spawnImpl
        );
        const turboExit = turbo.done.then(({ code, signal }) => {
            if (!shuttingDown) throw new Error(`turbo watch build exited (${signal ?? code ?? 'unknown status'})`);
        });

        const { binary: serverBinary, release } = resolvedBinary;
        console.log(`Starting Pumpkin ${release} with ${plugins.length} plugins in ${serverDir}`);
        server = spawnChild(serverBinary, [], { cwd: serverDir, stdio: 'inherit' }, spawnImpl);
        const serverResult = await Promise.race([
            server.done,
            turboExit.then(() => new Promise(() => {})),
            outputs.failure
        ]);
        if (serverResult && !shuttingDown) process.exitCode = serverResult.code ?? (serverResult.signal ? 1 : 0);
    } finally {
        process.removeListener('SIGINT', onInterrupt);
        process.removeListener('SIGTERM', onTerminate);
        outputs?.close();
        stopChildren('SIGTERM');
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    runDev().catch((error) => {
        console.error(`pnpm dev: ${error.message}`);
        process.exitCode = 1;
    });
}
