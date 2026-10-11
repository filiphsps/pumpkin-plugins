import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { copyPluginBuild, listPluginBuilds, parseDevArgs, runDev } from './dev.mjs';

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
        assert.deepEqual(parseDevArgs([]), { hotReload: true, nightly: false, apiTarget: 'release' });
        assert.deepEqual(parseDevArgs(['--nightly', '--no-hot-reload']), {
            hotReload: false,
            nightly: true,
            apiTarget: 'nightly'
        });
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
            prepareEnvironment: async (_root, env) => env,
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
            prepareEnvironment: async (_root, env) => env,
            spawnImpl,
            hotReload: false,
            nightly: true,
            resolveBinary: async (options) => {
                resolvedOptions = options;
                return { binary: '/fake/pumpkin', release: 'test release' };
            }
        });

        assert.equal(calls.length, 2);
        assert.deepEqual(resolvedOptions, { root, apiTarget: 'nightly' });
        assert.equal(calls[0].options.env.PUMPKIN_API_TARGET, 'nightly');
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
                prepareEnvironment: async (_root, env) => env,
                spawnImpl,
                resolveBinary: async () => ({ binary: '/fake/pumpkin', release: 'test release' })
            }),
            /turbo run build exited \(1\)/
        );
        assert.equal(calls.length, 1);
    });
});

describe('explicit API target', () => {
    it('selects a named profile and rejects an omitted value or conflicting nightly option', () => {
        assert.equal(parseDevArgs(['--api-target', 'future']).apiTarget, 'future');
        assert.throws(() => parseDevArgs(['--api-target']), /requires a target/);
        assert.throws(() => parseDevArgs(['--nightly', '--api-target', 'release']), /conflict/);
    });
});
it('rejects an unsupported first dev argument', () => {
    assert.throws(() => parseDevArgs(['--nigthly']), /Unknown dev argument/);
});
