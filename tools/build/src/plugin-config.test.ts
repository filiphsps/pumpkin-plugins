import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BuildError } from './errors.ts';
import { readPluginConfig, requireBuildFields } from './plugin-config.ts';

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function packageWith(pkg: unknown): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-config-'));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
    return dir;
}

describe('readPluginConfig', () => {
    it('reads the entry, output, capabilities and version', () => {
        const dir = packageWith({
            version: '1.2.3',
            pumpkinPlugin: { entry: 'src/plugin.ts', output: 'build/p.wasm', wasi: ['sockets'] }
        });
        expect(readPluginConfig(dir)).toEqual({
            entry: 'src/plugin.ts',
            output: 'build/p.wasm',
            wasi: ['sockets'],
            version: '1.2.3'
        });
    });

    it('defaults to no capabilities', () => {
        expect(readPluginConfig(packageWith({ version: '0.0.0', pumpkinPlugin: {} })).wasi).toEqual([]);
    });

    it('explains a missing key and an unknown capability', () => {
        expect(() => readPluginConfig(packageWith({ version: '0.0.0' }))).toThrow(BuildError);
        expect(() => readPluginConfig(packageWith({ version: '0.0.0', pumpkinPlugin: { wasi: ['network'] } }))).toThrow(
            'unknown wasi capability "network" (known: http, filesystem, sockets, udp)'
        );
    });

    it('rejects malformed package data with a build error', () => {
        expect(() => readPluginConfig(packageWith([]))).toThrow('package.json must contain an object');
        expect(() => readPluginConfig(packageWith({ version: '0.0.0', pumpkinPlugin: [] }))).toThrow(
            'package.json needs a "pumpkinPlugin" object'
        );
        expect(() => readPluginConfig(packageWith({ version: 1, pumpkinPlugin: {} }))).toThrow(
            'package.json needs a non-empty "version" string'
        );
        expect(() => readPluginConfig(packageWith({ version: '0.0.0', pumpkinPlugin: { wasi: 'http' } }))).toThrow(
            '"pumpkinPlugin.wasi" must be an array of capability names'
        );
        expect(() => readPluginConfig(packageWith({ version: '0.0.0', pumpkinPlugin: { wasi: [null] } }))).toThrow(
            '"pumpkinPlugin.wasi" must contain only capability names'
        );
    });

    it('reports missing or invalid package.json files as build errors', () => {
        const dir = packageWith({ version: '0.0.0', pumpkinPlugin: {} });
        fs.unlinkSync(path.join(dir, 'package.json'));
        expect(() => readPluginConfig(dir)).toThrow('could not read package.json');

        const malformed = packageWith({});
        fs.writeFileSync(path.join(malformed, 'package.json'), '{');
        expect(() => readPluginConfig(malformed)).toThrow('package.json is not valid JSON');
    });

    it('rejects invalid build paths before resolving them against the package', () => {
        for (const entry of [42, '', '.', '../outside.ts', '/tmp/plugin.ts', 'C:\\outside.ts', 'C:plugin.ts']) {
            expect(() => readPluginConfig(packageWith({ version: '0.0.0', pumpkinPlugin: { entry } }))).toThrow(
                '"pumpkinPlugin.entry"'
            );
        }
        expect(() =>
            readPluginConfig(packageWith({ version: '0.0.0', pumpkinPlugin: { output: '../outside.wasm' } }))
        ).toThrow('"pumpkinPlugin.output"');
        expect(() =>
            readPluginConfig(packageWith({ version: '0.0.0', pumpkinPlugin: { output: 'package.json' } }))
        ).toThrow('must name a .wasm file');
    });
});

describe('requireBuildFields', () => {
    it('returns entry and output', () => {
        expect(requireBuildFields({ entry: 'a', output: 'b.wasm', wasi: [], version: '0.0.0' })).toEqual({
            entry: 'a',
            output: 'b.wasm'
        });
    });

    it('asks for both when either is missing, so libraries can still generate types', () => {
        expect(() => requireBuildFields({ entry: 'a', wasi: [], version: '0.0.0' })).toThrow(/entry.*output/);
        expect(() => requireBuildFields({ wasi: [], version: '0.0.0' })).toThrow(BuildError);
    });

    it('validates fields supplied directly to a full build', () => {
        expect(() =>
            requireBuildFields({ entry: '../outside.ts', output: 'build/plugin.wasm', wasi: [], version: '0' })
        ).toThrow('"pumpkinPlugin.entry"');
        expect(() =>
            requireBuildFields({ entry: 'src/plugin.ts', output: 1 as never, wasi: [], version: '0' })
        ).toThrow('"pumpkinPlugin.output"');
    });
});
