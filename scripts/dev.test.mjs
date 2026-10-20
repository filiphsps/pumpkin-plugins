import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { PUMPKIN_RELEASE } from '../tools/test-harness/src/pumpkin-version.ts';
import { assetName } from '../tools/test-harness/src/util.ts';
import {
    copyPluginBuild,
    listPluginBuilds,
    parseDevArgs,
    releaseAsset,
    resolveLatestPumpkinBinary,
    runDev,
} from './dev.mjs';

const configRequire = createRequire(new URL('../tools/config/package.json', import.meta.url));
const { parse: parseToml } = await import(pathToFileURL(configRequire.resolve('smol-toml')));
const tempDirs = [];

function tempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pumpkin-dev-test-'));
    tempDirs.push(dir);
    return dir;
}

function addPluginFixture(root) {
    const packageDir = path.join(root, 'packages', 'plugin');
    const output = path.join(packageDir, 'build', 'plugin.wasm');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(
        path.join(packageDir, 'package.json'),
        JSON.stringify({ pumpkinPlugin: { output: 'build/plugin.wasm' } }),
    );
    fs.writeFileSync(output, 'built plugin');
}

async function configureDevServer(config) {
    const root = tempDir();
    addPluginFixture(root);
    const serverDir = path.join(root, '.cache', 'pumpkin-dev');
    fs.mkdirSync(serverDir, { recursive: true });
    fs.writeFileSync(path.join(serverDir, 'pumpkin.toml'), config);
    const spawnImpl = (command, args) => {
        const child = new EventEmitter();
        child.kill = (signal) => process.nextTick(() => child.emit('exit', null, signal));
        if (args.includes('run') || command === '/fake/pumpkin') {
            process.nextTick(() => child.emit('exit', 0, null));
        }
        return child;
    };

    await runDev({
        root,
        spawnImpl,
        resolveBinary: async () => ({ binary: '/fake/pumpkin', release: 'test release' }),
    });

    return fs.readFileSync(path.join(serverDir, 'pumpkin.toml'), 'utf8');
}

afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('parseDevArgs', () => {
    it('selects the server and plugin build modes from command-line arguments', () => {
        assert.deepEqual(parseDevArgs([]), {
            hotReload: true,
            latest: false,
            nightly: false,
            release: false,
            parseTypeScript: false,
            turboArgs: [],
        });
        assert.deepEqual(parseDevArgs(['--nightly', '--no-hot-reload']), {
            hotReload: false,
            latest: false,
            nightly: true,
            release: false,
            parseTypeScript: false,
            turboArgs: [],
        });
        assert.deepEqual(parseDevArgs(['--release', '--parse-ts', '--', '--output-logs=errors-only']), {
            hotReload: true,
            latest: false,
            nightly: false,
            release: true,
            parseTypeScript: true,
            turboArgs: ['--output-logs=errors-only'],
        });
    });
});

describe('releaseAsset', () => {
    it('finds assets by exact name and reports missing files', () => {
        const release = {
            tag_name: 'v1',
            assets: [{ name: 'server', browser_download_url: 'https://example.test/server' }],
        };
        assert.equal(releaseAsset(release, 'server').browser_download_url, 'https://example.test/server');
        assert.throws(() => releaseAsset(release, 'nightly'), /release v1 is missing nightly/);
    });
});

describe('resolveLatestPumpkinBinary', () => {
    const release = {
        tag_name: '0.2.0',
        prerelease: false,
        draft: false,
        assets: [
            { name: 'pumpkin-X64-Linux', browser_download_url: 'https://example.test/pumpkin' },
            { name: 'checksums.sha256', browser_download_url: 'https://example.test/checksums' },
        ],
    };
    const nightlyRelease = {
        tag_name: 'nightly',
        prerelease: true,
        draft: false,
        assets: [
            {
                id: 42,
                name: 'pumpkin-X64-Linux',
                browser_download_url: 'https://example.test/nightly-pumpkin',
            },
        ],
    };

    function seedReleaseCache(root, cachedRelease = release, fetchedAt = Date.now()) {
        const cacheDir = path.join(root, '.cache', 'pumpkin');
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(
            path.join(cacheDir, 'latest-release.json'),
            JSON.stringify({ fetchedAt, release: cachedRelease }),
        );
        const binary = path.join(cacheDir, `${cachedRelease.tag_name}-pumpkin-X64-Linux`);
        fs.writeFileSync(binary, 'cached binary');
        return { cacheDir, binary };
    }

    it('uses the stable latest endpoint and verifies the downloaded binary', async () => {
        const root = tempDir();
        const bytes = Buffer.from('pumpkin binary');
        const digest = createHash('sha256').update(bytes).digest('hex');
        const calls = [];
        const fetchImpl = async (url) => {
            calls.push(url);
            if (url.endsWith('/releases/latest')) {
                return {
                    ok: true,
                    json: async () => ({
                        tag_name: '0.2.0',
                        prerelease: false,
                        draft: false,
                        assets: [
                            { name: 'pumpkin-X64-Linux', browser_download_url: 'https://example.test/pumpkin' },
                            { name: 'checksums.sha256', browser_download_url: 'https://example.test/checksums' },
                        ],
                    }),
                };
            }
            if (url.endsWith('/checksums')) {
                return { ok: true, text: async () => `${digest}  pumpkin-X64-Linux\n` };
            }
            return {
                ok: true,
                arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
            };
        };

        const result = await resolveLatestPumpkinBinary({ root, platform: 'linux', arch: 'x64', env: {}, fetchImpl });

        assert.equal(result.release, '0.2.0');
        assert.equal(fs.readFileSync(result.binary).toString(), bytes.toString());
        assert.equal(calls[0], 'https://api.github.com/repos/Pumpkin-MC/Pumpkin/releases/latest');
        const metadata = JSON.parse(
            fs.readFileSync(path.join(root, '.cache', 'pumpkin', 'latest-release.json'), 'utf8'),
        );
        assert.equal(metadata.release.tag_name, release.tag_name);
        assert.equal(typeof metadata.fetchedAt, 'number');
    });

    it('downloads the musl build on musl Linux', async () => {
        const root = tempDir();
        const bytes = Buffer.from('musl pumpkin binary');
        const digest = createHash('sha256').update(bytes).digest('hex');
        const calls = [];
        const fetchImpl = async (url) => {
            calls.push(url);
            if (url.endsWith('/releases/latest')) {
                return {
                    ok: true,
                    json: async () => ({
                        ...release,
                        assets: [
                            ...release.assets,
                            {
                                name: 'pumpkin-X64-Linux-musl',
                                browser_download_url: 'https://example.test/pumpkin-musl',
                            },
                        ],
                    }),
                };
            }
            if (url.endsWith('/checksums')) {
                return { ok: true, text: async () => `${digest}  pumpkin-X64-Linux-musl\n` };
            }
            return {
                ok: true,
                arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
            };
        };

        const result = await resolveLatestPumpkinBinary({
            root,
            platform: 'linux',
            arch: 'x64',
            musl: true,
            env: {},
            fetchImpl,
        });

        assert.equal(path.basename(result.binary), '0.2.0-pumpkin-X64-Linux-musl');
        assert.ok(calls.includes('https://example.test/pumpkin-musl'));
    });

    it('resolves the nightly tag and uses its asset id for the binary cache key', async () => {
        const root = tempDir();
        const bytes = Buffer.from('nightly pumpkin binary');
        const digest = createHash('sha256').update(bytes).digest('hex');
        const releaseWithDigest = {
            ...nightlyRelease,
            assets: nightlyRelease.assets.map((asset) =>
                asset.name === 'pumpkin-X64-Linux' ? { ...asset, digest: `sha256:${digest}` } : asset,
            ),
        };
        const calls = [];
        const fetchImpl = async (url) => {
            calls.push(url);
            if (url.endsWith('/releases/tags/nightly')) {
                return { ok: true, json: async () => releaseWithDigest };
            }
            return {
                ok: true,
                arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
            };
        };

        const result = await resolveLatestPumpkinBinary({
            root,
            platform: 'linux',
            arch: 'x64',
            env: {},
            fetchImpl,
            nightly: true,
        });

        assert.equal(result.release, 'nightly');
        assert.equal(path.basename(result.binary), 'nightly-42-pumpkin-X64-Linux');
        assert.equal(fs.readFileSync(result.binary).toString(), bytes.toString());
        assert.equal(calls[0], 'https://api.github.com/repos/Pumpkin-MC/Pumpkin/releases/tags/nightly');
        const metadata = JSON.parse(
            fs.readFileSync(path.join(root, '.cache', 'pumpkin', 'latest-nightly.json'), 'utf8'),
        );
        assert.equal(metadata.release.tag_name, 'nightly');
    });

    it('refreshes nightly metadata on every run to discover replaced nightly assets', async () => {
        const root = tempDir();
        const cacheDir = path.join(root, '.cache', 'pumpkin');
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(
            path.join(cacheDir, 'latest-nightly.json'),
            JSON.stringify({ fetchedAt: Date.now(), release: nightlyRelease }),
        );
        fs.writeFileSync(path.join(cacheDir, 'nightly-42-pumpkin-X64-Linux'), 'old nightly binary');
        const latestBytes = Buffer.from('new nightly pumpkin binary');
        const digest = createHash('sha256').update(latestBytes).digest('hex');
        const calls = [];
        const updatedNightly = {
            ...nightlyRelease,
            assets: nightlyRelease.assets.map((asset) => ({
                ...asset,
                id: asset.id + 2,
                ...(asset.name === 'pumpkin-X64-Linux' ? { digest: `sha256:${digest}` } : {}),
            })),
        };
        const fetchImpl = async (url) => {
            calls.push(url);
            if (url.endsWith('/releases/tags/nightly')) {
                return { ok: true, json: async () => updatedNightly };
            }
            return {
                ok: true,
                arrayBuffer: async () =>
                    latestBytes.buffer.slice(latestBytes.byteOffset, latestBytes.byteOffset + latestBytes.byteLength),
            };
        };

        const result = await resolveLatestPumpkinBinary({
            root,
            platform: 'linux',
            arch: 'x64',
            env: {},
            fetchImpl,
            nightly: true,
        });

        assert.equal(result.binary, path.join(cacheDir, 'nightly-44-pumpkin-X64-Linux'));
        assert.equal(fs.readFileSync(result.binary).toString(), latestBytes.toString());
        assert.deepEqual(calls, [
            'https://api.github.com/repos/Pumpkin-MC/Pumpkin/releases/tags/nightly',
            'https://example.test/nightly-pumpkin',
        ]);
    });

    it('rejects a prerelease response', async () => {
        await assert.rejects(
            resolveLatestPumpkinBinary({
                root: tempDir(),
                env: {},
                fetchImpl: async () => ({
                    ok: true,
                    json: async () => ({ tag_name: 'nightly', prerelease: true, draft: false }),
                }),
            }),
            /instead of a stable Pumpkin release \(nightly\)/,
        );
    });

    it('rejects malformed release metadata before caching it', async () => {
        const root = tempDir();
        await assert.rejects(
            resolveLatestPumpkinBinary({
                root,
                env: {},
                fetchImpl: async () => ({
                    ok: true,
                    json: async () => ({ tag_name: 'stable', prerelease: false, draft: false }),
                }),
            }),
            /invalid latest stable Pumpkin release metadata/,
        );
        assert.equal(fs.existsSync(path.join(root, '.cache', 'pumpkin', 'latest-release.json')), false);
    });

    it('uses fresh release metadata without making a GitHub request', async () => {
        const root = tempDir();
        const { binary } = seedReleaseCache(root, release, 1_000_000);
        const result = await resolveLatestPumpkinBinary({
            root,
            platform: 'linux',
            arch: 'x64',
            env: {},
            now: () => 1_000_001,
            fetchImpl: async () => assert.fail('fresh metadata should avoid GitHub'),
        });

        assert.equal(result.binary, binary);
        assert.equal(result.release, release.tag_name);
    });

    it('refreshes release metadata when forced, even while the cache is fresh', async () => {
        const root = tempDir();
        seedReleaseCache(root, release, 1_000_000);
        const calls = [];
        const result = await resolveLatestPumpkinBinary({
            root,
            platform: 'linux',
            arch: 'x64',
            env: { PUMPKIN_REFRESH_RELEASE: '1' },
            now: () => 1_000_001,
            fetchImpl: async (url) => {
                calls.push(url);
                return { ok: true, json: async () => release };
            },
        });

        assert.equal(result.release, release.tag_name);
        assert.deepEqual(calls, ['https://api.github.com/repos/Pumpkin-MC/Pumpkin/releases/latest']);
    });

    it('refreshes expired release metadata', async () => {
        const root = tempDir();
        seedReleaseCache(root, release, 1_000_000);
        const calls = [];
        await resolveLatestPumpkinBinary({
            root,
            platform: 'linux',
            arch: 'x64',
            env: {},
            now: () => 1_000_000 + 24 * 60 * 60 * 1000,
            fetchImpl: async (url) => {
                calls.push(url);
                return { ok: true, json: async () => release };
            },
        });

        assert.deepEqual(calls, ['https://api.github.com/repos/Pumpkin-MC/Pumpkin/releases/latest']);
    });

    it('uses valid stale metadata after a rate-limit response', async () => {
        const root = tempDir();
        const { binary } = seedReleaseCache(root, release, 1_000_000);
        const warnings = [];
        const originalWarn = console.warn;
        console.warn = (...args) => warnings.push(args.join(' '));
        try {
            const result = await resolveLatestPumpkinBinary({
                root,
                platform: 'linux',
                arch: 'x64',
                env: { PUMPKIN_REFRESH_RELEASE: '1' },
                now: () => 2_000_000,
                fetchImpl: async () => ({
                    ok: false,
                    status: 403,
                    headers: { get: (name) => (name === 'x-ratelimit-remaining' ? '0' : null) },
                }),
            });
            assert.equal(result.binary, binary);
            assert.match(warnings.join(' '), /using cached release/i);
        } finally {
            console.warn = originalWarn;
        }
    });

    it('uses valid stale metadata after a network failure', async () => {
        const root = tempDir();
        const { binary } = seedReleaseCache(root, release, 1_000_000);
        const originalWarn = console.warn;
        console.warn = () => {};
        try {
            const result = await resolveLatestPumpkinBinary({
                root,
                platform: 'linux',
                arch: 'x64',
                env: {},
                now: () => 1_000_000 + 24 * 60 * 60 * 1000,
                fetchImpl: async () => {
                    throw new TypeError('network unavailable');
                },
            });
            assert.equal(result.binary, binary);
        } finally {
            console.warn = originalWarn;
        }
    });

    it('does not treat an unrelated forbidden response as a rate limit', async () => {
        const root = tempDir();
        seedReleaseCache(root, release, 1_000_000);
        await assert.rejects(
            resolveLatestPumpkinBinary({
                root,
                platform: 'linux',
                arch: 'x64',
                env: { PUMPKIN_REFRESH_RELEASE: '1' },
                now: () => 2_000_000,
                fetchImpl: async () => ({ ok: false, status: 403, headers: { get: () => null } }),
            }),
            /Could not get the latest stable Pumpkin release \(HTTP 403\)/,
        );
    });

    it('keeps network failures as errors when there is no cached release', async () => {
        await assert.rejects(
            resolveLatestPumpkinBinary({
                root: tempDir(),
                env: {},
                fetchImpl: async () => {
                    throw new TypeError('network unavailable');
                },
            }),
            /Could not reach the latest stable Pumpkin release endpoint/,
        );
    });

    it('uses PUMPKIN_BIN without making GitHub requests', async () => {
        const root = tempDir();
        const binary = path.join(root, 'pumpkin');
        fs.writeFileSync(binary, 'local binary');
        const result = await resolveLatestPumpkinBinary({
            root,
            env: { PUMPKIN_BIN: binary },
            fetchImpl: async () => assert.fail('PUMPKIN_BIN should avoid GitHub'),
        });

        assert.equal(result.binary, binary);
        assert.equal(result.release, 'local PUMPKIN_BIN');
    });
});

describe('listPluginBuilds', () => {
    it('collects plugin outputs from package manifests in stable order', () => {
        const root = tempDir();
        for (const name of ['z-plugin', 'a-plugin']) {
            const dir = path.join(root, 'packages', name);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(
                path.join(dir, 'package.json'),
                JSON.stringify({ pumpkinPlugin: { output: `build/${name}.wasm` } }),
            );
        }
        fs.mkdirSync(path.join(root, 'packages', 'ordinary-folder'));
        const builds = listPluginBuilds(root);
        assert.deepEqual(
            builds.map(({ name }) => name),
            ['a-plugin', 'z-plugin'],
        );
        assert.equal(builds[0].outputPath, path.join(root, 'packages', 'a-plugin', 'build', 'a-plugin.wasm'));
    });

    it('rejects output paths that escape the package', () => {
        const root = tempDir();
        const dir = path.join(root, 'packages', 'unsafe');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'package.json'),
            JSON.stringify({ pumpkinPlugin: { output: '../outside.wasm' } }),
        );
        assert.throws(() => listPluginBuilds(root), /unsafe pumpkinPlugin.output/);
    });
});

describe('copyPluginBuild', () => {
    it('updates an existing plugin file and replaces symlinks without writing through them', () => {
        const root = tempDir();
        const source = path.join(root, 'built.wasm');
        const serverPlugins = path.join(root, 'server', 'plugins');
        const target = path.join(serverPlugins, 'plugin.wasm');
        const external = path.join(root, 'external.wasm');
        fs.writeFileSync(source, 'built bytes');
        fs.writeFileSync(external, 'leave this alone');
        fs.mkdirSync(serverPlugins, { recursive: true });
        fs.symlinkSync(external, target);

        copyPluginBuild({ name: 'plugin', outputPath: source }, serverPlugins);

        assert.equal(fs.readFileSync(target, 'utf8'), 'built bytes');
        assert.equal(fs.readFileSync(external, 'utf8'), 'leave this alone');
        assert.equal(fs.lstatSync(target).isSymbolicLink(), false);
    });
});

describe('runDev', () => {
    it('updates a quoted hot-reload key without adding a duplicate', async () => {
        const config = await configureDevServer('[plugins]\n"hot_reload" = false # keep\n');

        assert.equal(parseToml(config).plugins.hot_reload, true);
        assert.match(config, /hot_reload = true # keep/);
    });

    it('updates a quoted plugins table without adding a duplicate', async () => {
        const config = await configureDevServer('["plugins"]\nhot_reload = false # keep\n');

        assert.equal(parseToml(config).plugins.hot_reload, true);
        assert.match(config, /hot_reload = true # keep/);
    });

    it('waits for build watchers to exit after asking them to shut down gracefully', async () => {
        const root = tempDir();
        addPluginFixture(root);
        let watcherExited = false;
        const watcherSignals = [];
        const spawnImpl = (command, args) => {
            const child = new EventEmitter();
            child.kill = (signal) => {
                if (!args.includes('watch')) return;
                watcherSignals.push(signal);
                if (signal === 'SIGINT') {
                    setTimeout(() => {
                        watcherExited = true;
                        child.emit('exit', null, signal);
                    }, 20);
                }
            };
            if (args.includes('run') || command === '/fake/pumpkin') {
                process.nextTick(() => child.emit('exit', 0, null));
            }
            return child;
        };

        await runDev({
            root,
            spawnImpl,
            resolveBinary: async () => ({ binary: '/fake/pumpkin', release: 'test release' }),
        });

        assert.deepEqual(watcherSignals, ['SIGINT']);
        assert.equal(watcherExited, true);
    });

    it('force-kills unresponsive children after graceful shutdown and waits for them to exit', async () => {
        const root = tempDir();
        addPluginFixture(root);
        const signalSource = new EventEmitter();
        const previousExitCode = process.exitCode;
        const childSignals = new Map();
        const exitedChildren = new Set();
        const children = [];
        let watcher;
        let server;
        const spawnImpl = (command, args) => {
            const child = new EventEmitter();
            child.once('exit', () => exitedChildren.add(child));
            child.kill = (signal) => {
                if (args.includes('watch') || command === '/fake/pumpkin') {
                    const signals = childSignals.get(child) ?? [];
                    signals.push(signal);
                    childSignals.set(child, signals);
                    if (signal === 'SIGKILL') {
                        setTimeout(() => child.emit('exit', null, signal), 20);
                    }
                }
            };
            children.push(child);
            if (args.includes('watch')) watcher = child;
            if (command === '/fake/pumpkin') server = child;
            if (args.includes('run')) process.nextTick(() => child.emit('exit', 0, null));
            if (command === '/fake/pumpkin') {
                process.nextTick(() => signalSource.emit('SIGINT'));
            }
            return child;
        };

        let completed;
        const running = runDev({
            root,
            spawnImpl,
            resolveBinary: async () => ({ binary: '/fake/pumpkin', release: 'test release' }),
            signalSource,
            shutdownTimeoutMs: 5,
        }).then(() => {
            completed = true;
        });

        try {
            let timeout;
            const finishedInTime = await Promise.race([
                running.then(() => true),
                new Promise((resolve) => {
                    timeout = setTimeout(() => resolve(false), 1000);
                }),
            ]);
            clearTimeout(timeout);
            if (!finishedInTime) {
                for (const child of children) child.emit('exit', 0, null);
                await running;
            }

            assert.equal(finishedInTime, true);
            assert.deepEqual(childSignals.get(watcher), ['SIGINT', 'SIGKILL']);
            assert.deepEqual(childSignals.get(server), ['SIGINT', 'SIGKILL']);
            assert.equal(exitedChildren.has(watcher), true);
            assert.equal(exitedChildren.has(server), true);
            assert.equal(completed, true);
        } finally {
            process.exitCode = previousExitCode;
        }
    });

    it('starts the server when cached plugin outputs do not change during the initial build', async () => {
        const root = tempDir();
        const packageDir = path.join(root, 'packages', 'plugin');
        const output = path.join(packageDir, 'build', 'plugin.wasm');
        fs.mkdirSync(packageDir, { recursive: true });
        fs.writeFileSync(
            path.join(packageDir, 'package.json'),
            JSON.stringify({ pumpkinPlugin: { output: 'build/plugin.wasm' } }),
        );
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, 'cached build');
        const serverDir = path.join(root, '.cache', 'pumpkin-dev');
        fs.mkdirSync(serverDir, { recursive: true });
        fs.writeFileSync(
            path.join(serverDir, 'pumpkin.toml'),
            '[plugins]\nhot_reload = false # reset\n\n[server]\nname = "test"\n',
        );
        const calls = [];
        const spawnImpl = (command, args, options) => {
            const child = new EventEmitter();
            child.kill = (signal) => process.nextTick(() => child.emit('exit', null, signal));
            calls.push({ command, args, options });
            if (args.includes('run') || command === '/fake/pumpkin') {
                process.nextTick(() => child.emit('exit', 0, null));
            }
            return child;
        };

        await runDev({
            root,
            spawnImpl,
            resolveBinary: async () => ({ binary: '/fake/pumpkin', release: 'test release' }),
        });

        assert.deepEqual(calls[0].args, ['run', 'build', '--', '--ui=stream']);
        assert.equal(calls[0].options.env.PUMPKIN_DEV_MODE, '1');
        assert.equal(calls[1].options.env.PUMPKIN_DEV_MODE, '1');
        assert.equal(calls.at(-1).command, '/fake/pumpkin');
        const config = fs.readFileSync(path.join(serverDir, 'pumpkin.toml'), 'utf8');
        assert.match(config, /hot_reload = true # reset/);
        assert.match(config, /\[server\]\nname = "test"/);
        assert.equal(
            fs.readFileSync(path.join(root, '.cache', 'pumpkin-dev', 'plugins', 'plugin.wasm'), 'utf8'),
            'cached build',
        );
    });

    it('builds release plugins for the initial and watch builds', async () => {
        const root = tempDir();
        addPluginFixture(root);
        const calls = [];
        const previousDevMode = process.env.PUMPKIN_DEV_MODE;
        process.env.PUMPKIN_DEV_MODE = '1';
        const spawnImpl = (command, args, options) => {
            const child = new EventEmitter();
            child.kill = (signal) => process.nextTick(() => child.emit('exit', null, signal));
            calls.push({ command, args, options });
            if (args.includes('run') || command === '/fake/pumpkin') {
                process.nextTick(() => child.emit('exit', 0, null));
            }
            return child;
        };

        try {
            await runDev({
                root,
                spawnImpl,
                release: true,
                resolveBinary: async () => ({ binary: '/fake/pumpkin', release: 'test release' }),
            });

            assert.equal(calls[0].options.env.PUMPKIN_DEV_MODE, undefined);
            assert.equal(calls[1].options.env.PUMPKIN_DEV_MODE, undefined);
            assert.deepEqual(calls[1].args, ['turbo', 'watch', 'build', '--ui=stream']);
            assert.equal(calls.at(-1).command, '/fake/pumpkin');
        } finally {
            if (previousDevMode === undefined) delete process.env.PUMPKIN_DEV_MODE;
            else process.env.PUMPKIN_DEV_MODE = previousDevMode;
        }
    });

    it('uses pnpm-forwarded release and parser flags without hot reload', async () => {
        const root = tempDir();
        const packageDir = path.join(root, 'packages', 'plugin');
        const output = path.join(packageDir, 'build', 'plugin.wasm');
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(
            path.join(packageDir, 'package.json'),
            JSON.stringify({ pumpkinPlugin: { output: 'build/plugin.wasm' } }),
        );
        fs.writeFileSync(output, 'cached build');
        const calls = [];
        let resolvedOptions;
        const previousDevMode = process.env.PUMPKIN_DEV_MODE;
        process.env.PUMPKIN_DEV_MODE = '1';
        const spawnImpl = (command, args, options) => {
            const child = new EventEmitter();
            child.kill = (signal) => process.nextTick(() => child.emit('exit', null, signal));
            calls.push({ command, args, options });
            if (args.includes('run') || command === '/fake/pumpkin') {
                process.nextTick(() => child.emit('exit', 0, null));
            }
            return child;
        };

        try {
            await runDev({
                root,
                spawnImpl,
                ...parseDevArgs(['--no-hot-reload', '--nightly', '--', '--parse-ts', '--release']),
                resolveBinary: async (options) => {
                    resolvedOptions = options;
                    return { binary: '/fake/pumpkin', release: 'test release' };
                },
            });
        } finally {
            if (previousDevMode === undefined) delete process.env.PUMPKIN_DEV_MODE;
            else process.env.PUMPKIN_DEV_MODE = previousDevMode;
        }

        assert.equal(calls.length, 2);
        assert.equal(resolvedOptions.root, root);
        assert.equal(resolvedOptions.nightly, true);
        assert.equal(calls[0].options.env.PUMPKIN_DEV_MODE, undefined);
        assert.ok(calls[0].args.includes('--parse-ts'));
        assert.equal(calls[0].args.includes('--release'), false);
        assert.equal(calls.at(-1).command, '/fake/pumpkin');
        assert.match(
            fs.readFileSync(path.join(root, '.cache', 'pumpkin-dev', 'pumpkin.toml'), 'utf8'),
            /hot_reload = false/,
        );
        assert.equal(
            calls.some(({ args }) => args.includes('watch')),
            false,
        );
    });

    it('runs the pinned Pumpkin release unless --latest or --nightly asks for another one', async () => {
        const asset = assetName(process.platform, process.arch);
        const bytes = Buffer.from('pumpkin binary');
        const digest = createHash('sha256').update(bytes).digest('hex');
        const latestRelease = {
            tag_name: '9.9.9',
            prerelease: false,
            draft: false,
            assets: [
                { name: asset, browser_download_url: 'https://example.test/latest-pumpkin' },
                { name: 'checksums.sha256', browser_download_url: 'https://example.test/latest-checksums' },
            ],
        };
        const startServer = async (args) => {
            const root = tempDir();
            addPluginFixture(root);
            const cacheDir = path.join(root, 'pumpkin-cache');
            const requests = [];
            let serverCommand;
            const spawnImpl = (command, spawnArgs) => {
                const child = new EventEmitter();
                child.kill = (signal) => process.nextTick(() => child.emit('exit', null, signal));
                if (spawnArgs.includes('run') || spawnArgs.length === 0) {
                    if (spawnArgs.length === 0) serverCommand = command;
                    process.nextTick(() => child.emit('exit', 0, null));
                }
                return child;
            };
            const originalFetch = globalThis.fetch;
            const originalEnv = { ...process.env };
            globalThis.fetch = async (url) => {
                requests.push(String(url));
                if (String(url).endsWith('/releases/latest')) return Response.json(latestRelease);
                if (/checksums(\.sha256)?$/.test(String(url))) return new Response(`${digest}  ${asset}\n`);
                return new Response(bytes);
            };
            process.env.PUMPKIN_CACHE_DIR = cacheDir;
            delete process.env.PUMPKIN_BIN;
            delete process.env.PUMPKIN_REFRESH_RELEASE;
            let error;
            try {
                await runDev({ root, spawnImpl, ...parseDevArgs(['--no-hot-reload', ...args]) });
            } catch (caught) {
                error = caught;
            } finally {
                globalThis.fetch = originalFetch;
                for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
                Object.assign(process.env, originalEnv);
            }
            return { serverCommand, cacheDir, requests, error };
        };

        // The fake binary can't match the SHA-256 pinned for the real release, so the pinned run stops
        // after downloading it.
        const pinned = await startServer([]);
        assert.match(String(pinned.error?.message), new RegExp(`Checksum mismatch for ${asset}`));
        assert.ok(
            pinned.requests.includes(
                `https://github.com/Pumpkin-MC/Pumpkin/releases/download/${encodeURIComponent(PUMPKIN_RELEASE)}/${asset}`,
            ),
        );
        assert.equal(
            pinned.requests.some((url) => url.startsWith('https://api.github.com/')),
            false,
        );

        const latest = await startServer(['--latest']);
        assert.equal(latest.error, undefined);
        assert.equal(latest.serverCommand, path.join(latest.cacheDir, `9.9.9-${asset}`));
        assert.ok(latest.requests.includes('https://api.github.com/repos/Pumpkin-MC/Pumpkin/releases/latest'));
    });

    it('copies a rebuilt plugin into the server once when the build renames it into place', async (t) => {
        const root = tempDir();
        addPluginFixture(root);
        const output = path.join(root, 'packages', 'plugin', 'build', 'plugin.wasm');
        const copied = path.join(root, '.cache', 'pumpkin-dev', 'plugins', 'plugin.wasm');
        const signalSource = new EventEmitter();
        const previousExitCode = process.exitCode;
        let serverStarted;
        const serverRunning = new Promise((resolve) => {
            serverStarted = resolve;
        });
        const spawnImpl = (command, args) => {
            const child = new EventEmitter();
            child.kill = (signal) => process.nextTick(() => child.emit('exit', null, signal));
            if (args.includes('run')) process.nextTick(() => child.emit('exit', 0, null));
            if (command === '/fake/pumpkin') serverStarted();
            return child;
        };
        // fs.watch delivers events late on a loaded machine and can miss changes made just after it
        // starts, so stand in for it and report what the OS reports for each change in the directory.
        const listeners = new Map();
        const watchImpl = (directory, listener) => {
            listeners.set(directory, listener);
            return Object.assign(new EventEmitter(), { close() {} });
        };
        const notify = (filename) => listeners.get(path.dirname(output))?.('rename', filename);
        // Publish the way tools/build does: write into a temporary folder beside the output, then rename.
        const publish = (bytes) => {
            const temporary = fs.mkdtempSync(path.join(path.dirname(output), '.tmp-'));
            notify(path.basename(temporary));
            fs.writeFileSync(path.join(temporary, 'plugin.wasm'), bytes);
            fs.renameSync(path.join(temporary, 'plugin.wasm'), output);
            notify('plugin.wasm');
            fs.rmSync(temporary, { recursive: true });
            notify(path.basename(temporary));
        };
        const copyLogs = [];
        const originalLog = console.log;
        console.log = (...args) => {
            const message = args.join(' ');
            if (message.startsWith('Copied plugin.wasm')) copyLogs.push(message);
        };

        const running = runDev({
            root,
            spawnImpl,
            watchImpl,
            resolveBinary: async () => ({ binary: '/fake/pumpkin', release: 'test release' }),
            signalSource,
        });
        try {
            await serverRunning;
            assert.equal(fs.readFileSync(copied, 'utf8'), 'built plugin');

            // The dev loop checks the output 100 ms after its last change event.
            t.mock.timers.enable({ apis: ['setTimeout'] });
            publish('rebuilt plugin');
            t.mock.timers.tick(100);
            assert.equal(fs.readFileSync(copied, 'utf8'), 'rebuilt plugin');
            publish('rebuilt plugin');
            t.mock.timers.tick(100);
        } finally {
            t.mock.timers.reset();
            signalSource.emit('SIGINT');
            await running;
            console.log = originalLog;
            process.exitCode = previousExitCode;
        }
        assert.equal(fs.readFileSync(copied, 'utf8'), 'rebuilt plugin');
        assert.equal(copyLogs.length, 1);
    });

    it('reports an initial build failure without starting Pumpkin', async () => {
        const root = tempDir();
        const packageDir = path.join(root, 'packages', 'plugin');
        fs.mkdirSync(path.join(packageDir, 'build'), { recursive: true });
        fs.writeFileSync(
            path.join(packageDir, 'package.json'),
            JSON.stringify({ pumpkinPlugin: { output: 'build/plugin.wasm' } }),
        );
        const calls = [];
        const spawnImpl = (command, args) => {
            const child = new EventEmitter();
            child.kill = () => {};
            calls.push({ command, args });
            process.nextTick(() => child.emit('exit', 1, null));
            return child;
        };

        await assert.rejects(
            runDev({
                root,
                spawnImpl,
                resolveBinary: async () => ({ binary: '/fake/pumpkin', release: 'test release' }),
            }),
            /pnpm run build exited \(1\)/,
        );
        assert.equal(calls.length, 1);
    });
});
