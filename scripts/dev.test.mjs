import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
    assetName,
    copyPluginBuild,
    listPluginBuilds,
    parseChecksums,
    parseDevArgs,
    releaseAsset,
    resolvePumpkinBinary,
    runDev
} from './dev.mjs';

const tempDirs = [];

function tempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pumpkin-dev-test-'));
    tempDirs.push(dir);
    return dir;
}

afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('parseDevArgs', () => {
    it('selects the nightly build and hot reload mode from command-line arguments', () => {
        assert.deepEqual(parseDevArgs([]), { hotReload: true, nightly: false });
        assert.deepEqual(parseDevArgs(['--nightly', '--no-hot-reload']), { hotReload: false, nightly: true });
    });
});

describe('assetName', () => {
    it('maps supported operating systems and architectures to release assets', () => {
        assert.equal(assetName('darwin', 'arm64'), 'pumpkin-ARM64-macOS');
        assert.equal(assetName('linux', 'x64'), 'pumpkin-X64-Linux');
        assert.equal(assetName('win32', 'x64'), 'pumpkin-X64-Windows.exe');
    });

    it('explains unsupported platforms', () => {
        assert.throws(() => assetName('freebsd', 'x64'), /No Pumpkin release binary for freebsd-x64/);
    });
});

describe('parseChecksums', () => {
    it('parses sha256sum entries with and without the binary marker', () => {
        const digest = 'A'.repeat(64);
        assert.deepEqual(
            parseChecksums(`${digest}  pumpkin-X64-Linux\n${digest} *pumpkin-X64-Windows.exe\n`),
            new Map([
                ['pumpkin-X64-Linux', digest.toLowerCase()],
                ['pumpkin-X64-Windows.exe', digest.toLowerCase()]
            ])
        );
    });
});

describe('releaseAsset', () => {
    it('finds assets by exact name and reports missing files', () => {
        const release = {
            tag_name: 'v1',
            assets: [{ name: 'server', browser_download_url: 'https://example.test/server' }]
        };
        assert.equal(releaseAsset(release, 'server').browser_download_url, 'https://example.test/server');
        assert.throws(() => releaseAsset(release, 'nightly'), /release v1 is missing nightly/);
    });
});

describe('resolvePumpkinBinary', () => {
    const release = {
        tag_name: '0.2.0',
        prerelease: false,
        draft: false,
        assets: [
            { name: 'pumpkin-X64-Linux', browser_download_url: 'https://example.test/pumpkin' },
            { name: 'checksums.sha256', browser_download_url: 'https://example.test/checksums' }
        ]
    };
    const nightlyRelease = {
        tag_name: 'nightly',
        prerelease: true,
        draft: false,
        assets: [
            {
                id: 42,
                name: 'pumpkin-X64-Linux',
                browser_download_url: 'https://example.test/nightly-pumpkin'
            }
        ]
    };

    function seedReleaseCache(root, cachedRelease = release, fetchedAt = Date.now()) {
        const cacheDir = path.join(root, '.cache', 'pumpkin');
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(
            path.join(cacheDir, 'latest-release.json'),
            JSON.stringify({ fetchedAt, release: cachedRelease })
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
                            { name: 'checksums.sha256', browser_download_url: 'https://example.test/checksums' }
                        ]
                    })
                };
            }
            if (url.endsWith('/checksums')) {
                return { ok: true, text: async () => `${digest}  pumpkin-X64-Linux\n` };
            }
            return {
                ok: true,
                arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
            };
        };

        const result = await resolvePumpkinBinary({ root, platform: 'linux', arch: 'x64', env: {}, fetchImpl });

        assert.equal(result.release, '0.2.0');
        assert.equal(fs.readFileSync(result.binary).toString(), bytes.toString());
        assert.equal(calls[0], 'https://api.github.com/repos/Pumpkin-MC/Pumpkin/releases/latest');
        const metadata = JSON.parse(
            fs.readFileSync(path.join(root, '.cache', 'pumpkin', 'latest-release.json'), 'utf8')
        );
        assert.equal(metadata.release.tag_name, release.tag_name);
        assert.equal(typeof metadata.fetchedAt, 'number');
    });

    it('resolves the nightly tag and uses its asset id for the binary cache key', async () => {
        const root = tempDir();
        const bytes = Buffer.from('nightly pumpkin binary');
        const digest = createHash('sha256').update(bytes).digest('hex');
        const releaseWithDigest = {
            ...nightlyRelease,
            assets: nightlyRelease.assets.map((asset) =>
                asset.name === 'pumpkin-X64-Linux' ? { ...asset, digest: `sha256:${digest}` } : asset
            )
        };
        const calls = [];
        const fetchImpl = async (url) => {
            calls.push(url);
            if (url.endsWith('/releases/tags/nightly')) {
                return { ok: true, json: async () => releaseWithDigest };
            }
            return {
                ok: true,
                arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
            };
        };

        const result = await resolvePumpkinBinary({
            root,
            platform: 'linux',
            arch: 'x64',
            env: {},
            fetchImpl,
            nightly: true
        });

        assert.equal(result.release, 'nightly');
        assert.equal(path.basename(result.binary), 'nightly-42-pumpkin-X64-Linux');
        assert.equal(fs.readFileSync(result.binary).toString(), bytes.toString());
        assert.equal(calls[0], 'https://api.github.com/repos/Pumpkin-MC/Pumpkin/releases/tags/nightly');
        const metadata = JSON.parse(
            fs.readFileSync(path.join(root, '.cache', 'pumpkin', 'latest-nightly.json'), 'utf8')
        );
        assert.equal(metadata.release.tag_name, 'nightly');
    });

    it('refreshes nightly metadata on every run to discover replaced nightly assets', async () => {
        const root = tempDir();
        const cacheDir = path.join(root, '.cache', 'pumpkin');
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(
            path.join(cacheDir, 'latest-nightly.json'),
            JSON.stringify({ fetchedAt: Date.now(), release: nightlyRelease })
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
                ...(asset.name === 'pumpkin-X64-Linux' ? { digest: `sha256:${digest}` } : {})
            }))
        };
        const fetchImpl = async (url) => {
            calls.push(url);
            if (url.endsWith('/releases/tags/nightly')) {
                return { ok: true, json: async () => updatedNightly };
            }
            return {
                ok: true,
                arrayBuffer: async () =>
                    latestBytes.buffer.slice(latestBytes.byteOffset, latestBytes.byteOffset + latestBytes.byteLength)
            };
        };

        const result = await resolvePumpkinBinary({
            root,
            platform: 'linux',
            arch: 'x64',
            env: {},
            fetchImpl,
            nightly: true
        });

        assert.equal(result.binary, path.join(cacheDir, 'nightly-44-pumpkin-X64-Linux'));
        assert.equal(fs.readFileSync(result.binary).toString(), latestBytes.toString());
        assert.deepEqual(calls, [
            'https://api.github.com/repos/Pumpkin-MC/Pumpkin/releases/tags/nightly',
            'https://example.test/nightly-pumpkin'
        ]);
    });

    it('rejects a prerelease response', async () => {
        await assert.rejects(
            resolvePumpkinBinary({
                root: tempDir(),
                env: {},
                fetchImpl: async () => ({
                    ok: true,
                    json: async () => ({ tag_name: 'nightly', prerelease: true, draft: false })
                })
            }),
            /instead of a stable Pumpkin release \(nightly\)/
        );
    });

    it('rejects malformed release metadata before caching it', async () => {
        const root = tempDir();
        await assert.rejects(
            resolvePumpkinBinary({
                root,
                env: {},
                fetchImpl: async () => ({
                    ok: true,
                    json: async () => ({ tag_name: 'stable', prerelease: false, draft: false })
                })
            }),
            /invalid latest stable Pumpkin release metadata/
        );
        assert.equal(fs.existsSync(path.join(root, '.cache', 'pumpkin', 'latest-release.json')), false);
    });

    it('uses fresh release metadata without making a GitHub request', async () => {
        const root = tempDir();
        const { binary } = seedReleaseCache(root, release, 1_000_000);
        const result = await resolvePumpkinBinary({
            root,
            platform: 'linux',
            arch: 'x64',
            env: {},
            now: () => 1_000_001,
            fetchImpl: async () => assert.fail('fresh metadata should avoid GitHub')
        });

        assert.equal(result.binary, binary);
        assert.equal(result.release, release.tag_name);
    });

    it('refreshes release metadata when forced, even while the cache is fresh', async () => {
        const root = tempDir();
        seedReleaseCache(root, release, 1_000_000);
        const calls = [];
        const result = await resolvePumpkinBinary({
            root,
            platform: 'linux',
            arch: 'x64',
            env: { PUMPKIN_REFRESH_RELEASE: '1' },
            now: () => 1_000_001,
            fetchImpl: async (url) => {
                calls.push(url);
                return { ok: true, json: async () => release };
            }
        });

        assert.equal(result.release, release.tag_name);
        assert.deepEqual(calls, ['https://api.github.com/repos/Pumpkin-MC/Pumpkin/releases/latest']);
    });

    it('refreshes expired release metadata', async () => {
        const root = tempDir();
        seedReleaseCache(root, release, 1_000_000);
        const calls = [];
        await resolvePumpkinBinary({
            root,
            platform: 'linux',
            arch: 'x64',
            env: {},
            now: () => 1_000_000 + 24 * 60 * 60 * 1000,
            fetchImpl: async (url) => {
                calls.push(url);
                return { ok: true, json: async () => release };
            }
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
            const result = await resolvePumpkinBinary({
                root,
                platform: 'linux',
                arch: 'x64',
                env: { PUMPKIN_REFRESH_RELEASE: '1' },
                now: () => 2_000_000,
                fetchImpl: async () => ({
                    ok: false,
                    status: 403,
                    headers: { get: (name) => (name === 'x-ratelimit-remaining' ? '0' : null) }
                })
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
            const result = await resolvePumpkinBinary({
                root,
                platform: 'linux',
                arch: 'x64',
                env: {},
                now: () => 1_000_000 + 24 * 60 * 60 * 1000,
                fetchImpl: async () => {
                    throw new TypeError('network unavailable');
                }
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
            resolvePumpkinBinary({
                root,
                platform: 'linux',
                arch: 'x64',
                env: { PUMPKIN_REFRESH_RELEASE: '1' },
                now: () => 2_000_000,
                fetchImpl: async () => ({ ok: false, status: 403, headers: { get: () => null } })
            }),
            /Could not get the latest stable Pumpkin release \(HTTP 403\)/
        );
    });

    it('keeps network failures as errors when there is no cached release', async () => {
        await assert.rejects(
            resolvePumpkinBinary({
                root: tempDir(),
                env: {},
                fetchImpl: async () => {
                    throw new TypeError('network unavailable');
                }
            }),
            /Could not reach the latest stable Pumpkin release endpoint/
        );
    });

    it('uses PUMPKIN_BIN without making GitHub requests', async () => {
        const root = tempDir();
        const binary = path.join(root, 'pumpkin');
        fs.writeFileSync(binary, 'local binary');
        const result = await resolvePumpkinBinary({
            root,
            env: { PUMPKIN_BIN: binary },
            fetchImpl: async () => assert.fail('PUMPKIN_BIN should avoid GitHub')
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
                JSON.stringify({ pumpkinPlugin: { output: `build/${name}.wasm` } })
            );
        }
        fs.mkdirSync(path.join(root, 'packages', 'ordinary-folder'));
        const builds = listPluginBuilds(root);
        assert.deepEqual(
            builds.map(({ name }) => name),
            ['a-plugin', 'z-plugin']
        );
        assert.equal(builds[0].outputPath, path.join(root, 'packages', 'a-plugin', 'build', 'a-plugin.wasm'));
    });

    it('rejects output paths that escape the package', () => {
        const root = tempDir();
        const dir = path.join(root, 'packages', 'unsafe');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'package.json'),
            JSON.stringify({ pumpkinPlugin: { output: '../outside.wasm' } })
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
    it('starts the server when cached plugin outputs do not change during the initial build', async () => {
        const root = tempDir();
        const packageDir = path.join(root, 'packages', 'plugin');
        const output = path.join(packageDir, 'build', 'plugin.wasm');
        fs.mkdirSync(packageDir, { recursive: true });
        fs.writeFileSync(
            path.join(packageDir, 'package.json'),
            JSON.stringify({ pumpkinPlugin: { output: 'build/plugin.wasm' } })
        );
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, 'cached build');
        const serverDir = path.join(root, '.cache', 'pumpkin-dev');
        fs.mkdirSync(serverDir, { recursive: true });
        fs.writeFileSync(
            path.join(serverDir, 'pumpkin.toml'),
            '[plugins]\nhot_reload = false # reset\n\n[server]\nname = "test"\n'
        );
        const calls = [];
        const spawnImpl = (command, args, options) => {
            const child = new EventEmitter();
            child.kill = () => {};
            calls.push({ command, args, options });
            if (args.includes('run') || command === '/fake/pumpkin') {
                process.nextTick(() => child.emit('exit', 0, null));
            }
            return child;
        };

        await runDev({
            root,
            spawnImpl,
            resolveBinary: async () => ({ binary: '/fake/pumpkin', release: 'test release' })
        });

        assert.deepEqual(calls[0].args, ['exec', 'turbo', 'run', 'build', '--ui=stream', '--log-order=stream']);
        assert.equal(calls[0].options.env.PUMPKIN_DEV_MODE, '1');
        assert.equal(calls[1].options.env.PUMPKIN_DEV_MODE, '1');
        assert.equal(calls.at(-1).command, '/fake/pumpkin');
        const config = fs.readFileSync(path.join(serverDir, 'pumpkin.toml'), 'utf8');
        assert.match(config, /hot_reload = true # reset/);
        assert.match(config, /\[server\]\nname = "test"/);
        assert.equal(
            fs.readFileSync(path.join(root, '.cache', 'pumpkin-dev', 'plugins', 'plugin.wasm'), 'utf8'),
            'cached build'
        );
    });

    it('starts without hot reload or build watchers when disabled', async () => {
        const root = tempDir();
        const packageDir = path.join(root, 'packages', 'plugin');
        const output = path.join(packageDir, 'build', 'plugin.wasm');
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(
            path.join(packageDir, 'package.json'),
            JSON.stringify({ pumpkinPlugin: { output: 'build/plugin.wasm' } })
        );
        fs.writeFileSync(output, 'cached build');
        const calls = [];
        let resolvedOptions;
        const spawnImpl = (command, args, options) => {
            const child = new EventEmitter();
            child.kill = () => {};
            calls.push({ command, args, options });
            if (args.includes('run') || command === '/fake/pumpkin') {
                process.nextTick(() => child.emit('exit', 0, null));
            }
            return child;
        };

        await runDev({
            root,
            spawnImpl,
            hotReload: false,
            nightly: true,
            resolveBinary: async (options) => {
                resolvedOptions = options;
                return { binary: '/fake/pumpkin', release: 'test release' };
            }
        });

        assert.equal(calls.length, 2);
        assert.deepEqual(resolvedOptions, { root, nightly: true });
        assert.equal(calls[0].options.env.PUMPKIN_DEV_MODE, '1');
        assert.equal(calls.at(-1).command, '/fake/pumpkin');
        assert.match(
            fs.readFileSync(path.join(root, '.cache', 'pumpkin-dev', 'pumpkin.toml'), 'utf8'),
            /hot_reload = false/
        );
        assert.equal(
            calls.some(({ args }) => args.includes('watch')),
            false
        );
    });

    it('reports an initial Turbo build failure without starting Pumpkin', async () => {
        const root = tempDir();
        const packageDir = path.join(root, 'packages', 'plugin');
        fs.mkdirSync(path.join(packageDir, 'build'), { recursive: true });
        fs.writeFileSync(
            path.join(packageDir, 'package.json'),
            JSON.stringify({ pumpkinPlugin: { output: 'build/plugin.wasm' } })
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
                resolveBinary: async () => ({ binary: '/fake/pumpkin', release: 'test release' })
            }),
            /turbo run build exited \(1\)/
        );
        assert.equal(calls.length, 1);
    });
});
