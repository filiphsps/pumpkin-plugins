import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { resolvePluginRelease } from './resolve-plugin-release.mjs';

function fixture({
    packageVersion = '0.0.8',
    manifestVersion = '0.0.8',
    engine,
    includeStaticHermesRuntime = true,
    pluginName = 'UPnPumpkin',
} = {}) {
    const root = mkdtempSync(join(tmpdir(), 'resolve-plugin-release-'));
    mkdirSync(join(root, 'packages/upnpumpkin/src'), { recursive: true });
    if (includeStaticHermesRuntime) {
        mkdirSync(join(root, 'tools/static-hermes-runtime'), { recursive: true });
        writeFileSync(
            join(root, 'tools/static-hermes-runtime/package.json'),
            JSON.stringify({ name: '@pumpkin-plugins/static-hermes-runtime' }),
        );
    }
    writeFileSync(
        join(root, 'release-please-config.json'),
        JSON.stringify({ packages: { 'packages/upnpumpkin': { component: 'upnpumpkin', 'release-type': 'node' } } }),
    );
    writeFileSync(
        join(root, '.release-please-manifest.json'),
        JSON.stringify({ 'packages/upnpumpkin': manifestVersion }),
    );
    writeFileSync(
        join(root, 'packages/upnpumpkin/package.json'),
        JSON.stringify({
            version: packageVersion,
            pumpkinPlugin: { info: 'src/info.mjs', output: 'build/upnpumpkin.wasm', engine },
        }),
    );
    writeFileSync(
        join(root, 'packages/upnpumpkin/src/info.mjs'),
        `export const info = { name: ${JSON.stringify(pluginName)} };\n`,
    );
    return root;
}

it('resolves a plugin tag to the registered plugin, version and collected WASM path', async () => {
    const root = fixture();
    try {
        assert.deepEqual(await resolvePluginRelease(root, 'upnpumpkin-v0.0.8'), {
            path: 'packages/upnpumpkin',
            component: 'upnpumpkin',
            version: '0.0.8',
            engine: 'static-hermes',
            pluginName: 'UPnPumpkin',
            wasmFile: 'dist/upnpumpkin.wasm',
        });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

it('preserves the selected engine so release recovery can prepare its toolchain', async () => {
    const root = fixture({ engine: 'quickjs' });
    try {
        assert.equal((await resolvePluginRelease(root, 'upnpumpkin-v0.0.8')).engine, 'quickjs');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

it('uses QuickJS for legacy release sources without the Static Hermes Runtime', async () => {
    const root = fixture({ includeStaticHermesRuntime: false });
    try {
        assert.equal((await resolvePluginRelease(root, 'upnpumpkin-v0.0.8')).engine, 'quickjs');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

it('rejects release metadata with an unsupported plugin engine', async () => {
    const root = fixture({ engine: 'hermes' });
    try {
        await assert.rejects(
            resolvePluginRelease(root, 'upnpumpkin-v0.0.8'),
            /declares an unsupported plugin engine: "hermes"/,
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

it('rejects unknown tags and versions inconsistent with the tagged source', async () => {
    const root = fixture();
    try {
        await assert.rejects(resolvePluginRelease(root, 'unknown-v0.0.8'), /No plugin release matches tag/);
        await assert.rejects(resolvePluginRelease(root, 'upnpumpkin-v0.0.9'), /package version is 0\.0\.8/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

it('rejects tags whose manifest and package versions disagree', async () => {
    const root = fixture({ manifestVersion: '0.0.7' });
    try {
        await assert.rejects(resolvePluginRelease(root, 'upnpumpkin-v0.0.8'), /manifest version is 0\.0\.7/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

it('rejects a plugin name with a Unicode line separator', async () => {
    const root = fixture({ pluginName: 'UPnPumpkin\u2028plugin_name=Other' });
    try {
        await assert.rejects(resolvePluginRelease(root, 'upnpumpkin-v0.0.8'), /single-line name/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
