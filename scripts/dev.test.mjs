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
        assert.equal(calls.at(-1).command, '/fake/pumpkin');
        assert.equal(
            fs.readFileSync(path.join(root, '.cache', 'pumpkin-dev', 'plugins', 'plugin.wasm'), 'utf8'),
            'cached build'
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
