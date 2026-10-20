import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { collectPlugins } from './collect-plugins.mjs';

const dirs = [];

afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture({ info = 'src/info.mjs', name = 'Example Plugin' } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'collect-plugins-'));
    dirs.push(root);
    const pluginDir = path.join(root, 'packages', 'example-plugin');
    const wasm = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    fs.mkdirSync(path.join(pluginDir, 'build'), { recursive: true });
    fs.mkdirSync(path.join(pluginDir, 'src'), { recursive: true });
    fs.writeFileSync(
        path.join(pluginDir, 'package.json'),
        JSON.stringify({
            version: '1.2.3',
            pumpkinPlugin: { output: 'build/example-plugin.wasm', info },
        }),
    );
    fs.writeFileSync(path.join(pluginDir, 'build/example-plugin.wasm'), wasm);
    fs.writeFileSync(path.join(pluginDir, 'src/info.mjs'), `export const info = { name: ${JSON.stringify(name)} };`);
    return { root, wasm };
}

describe('collect-plugins', () => {
    it('copies built WASM and can write a signing manifest', async () => {
        const { root, wasm } = fixture();
        const dist = path.join(root, 'dist');
        const manifestFile = path.join(root, 'temporary', 'plugins.json');

        await collectPlugins({ root, dist, manifestFile });

        assert.deepEqual(fs.readFileSync(path.join(dist, 'example-plugin.wasm')), wasm);
        assert.equal(
            fs.readFileSync(path.join(dist, 'example-plugin.wasm.sha256'), 'utf8'),
            `${createHash('sha256').update(wasm).digest('hex')}  example-plugin.wasm\n`,
        );
        assert.deepEqual(JSON.parse(fs.readFileSync(manifestFile, 'utf8')), [
            {
                'plugin-name': 'Example Plugin',
                version: '1.2.3',
                'wasm-file': path.join(dist, 'example-plugin.wasm'),
            },
        ]);
    });

    it('rejects a multi-line plugin name instead of writing it to the signing manifest', async () => {
        const { root } = fixture({ name: 'Example Plugin\nplugin-name=Other' });
        const manifestFile = path.join(root, 'plugins.json');

        await assert.rejects(collectPlugins({ root, manifestFile }), /single-line name/);
        assert.equal(fs.existsSync(manifestFile), false);
    });

    it('rejects an info module outside the plugin package', async () => {
        const { root } = fixture({ info: '../outside.mjs' });
        fs.writeFileSync(path.join(root, 'packages/outside.mjs'), 'export const info = { name: "Outside" };');

        await assert.rejects(
            collectPlugins({ root, manifestFile: path.join(root, 'plugins.json') }),
            /info path escapes the package/,
        );
    });
});
