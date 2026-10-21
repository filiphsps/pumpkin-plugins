import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { bundlePlugin } from '../../../tools/build/src/bundle.ts';
import { ensurePumpkinWit } from '../../../tools/pumpkin-api/src/wit.mjs';
import { startPumpkin } from '../../../tools/test-harness/src/index.ts';

const root = path.resolve(import.meta.dirname, '../../..');
const target = path.resolve(root, process.env.CARGO_TARGET_DIR ?? 'native/pumpkin-plus-plus/target');
const nativeArtifact =
    process.env.PUMPKIN_PLUS_PLUS_ARTIFACT ??
    path.join(
        target,
        'debug',
        process.platform === 'win32'
            ? 'pumpkin_plus_plus.dll'
            : process.platform === 'darwin'
              ? 'libpumpkin_plus_plus.dylib'
              : 'libpumpkin_plus_plus.so',
    );
const inspector =
    process.env.PUMPKIN_PLUS_PLUS_INSPECTOR ??
    path.join(
        target,
        'debug/examples',
        process.platform === 'win32'
            ? 'lifecycle_observer.dll'
            : process.platform === 'darwin'
              ? 'liblifecycle_observer.dylib'
              : 'liblifecycle_observer.so',
    );
const output = path.join(import.meta.dirname, 'artifacts/distant-horizons-consumer.wasm');
const fixtureName = 'DistantHorizonsPumpkinPlusPlusFixture';

beforeAll(async () => {
    expect(fs.existsSync(nativeArtifact), `Build native artifact first: ${nativeArtifact}`).toBe(true);
    expect(fs.existsSync(inspector), `Build lifecycle observer first: ${inspector}`).toBe(true);
    await bundlePlugin({
        entry: path.join(import.meta.dirname, 'distant-horizons-consumer.ts'),
        output,
        engine: process.env.PUMPKIN_PLUS_PLUS_ENGINE === 'static-hermes' ? 'static-hermes' : 'quickjs',
        version: '0.0.0',
        witDir: ensurePumpkinWit({
            lockFile: path.join(root, 'tools/pumpkin-api/wit.lock.json'),
            cacheRoot: path.join(root, '.cache'),
        }),
        projectRoot: root,
    });
});

it('prepares and samples an LOD section through the production terrain adapter and native IPC', async () => {
    const server = await startPumpkin({
        name: 'pumpkin-plus-plus-distant-horizons',
        plugins: [nativeArtifact, inspector, output],
    });
    try {
        await server.waitForLog(new RegExp(`${fixtureName}: ready`));
        const result = await server.waitForLog(new RegExp(`${fixtureName}: capture (?:complete|failed)`), 120_000);
        if (result.includes('capture failed')) {
            throw new Error(server.lines.filter((line) => line.includes(fixtureName)).join('\n'));
        }
        const details = JSON.parse(result.slice(result.indexOf('capture complete ') + 'capture complete '.length));
        expect(details.bytes).toBeGreaterThan(0);
        expect(details.leaseTicks).toBeGreaterThan(0);
        expect(details.generatedChunks).toBeGreaterThan(0);
        expect(details.tickets.levels).toEqual([]);
        expect(server.errors()).toEqual([]);
    } finally {
        await server.stop();
    }
}, 150_000);
