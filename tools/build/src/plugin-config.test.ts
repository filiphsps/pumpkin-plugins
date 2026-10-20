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
            pumpkinPlugin: { entry: 'src/plugin.ts', output: 'build/p.wasm', wasi: ['sockets'] },
        });
        expect(readPluginConfig(dir)).toEqual({
            entry: 'src/plugin.ts',
            output: 'build/p.wasm',
            wasi: ['sockets'],
            engine: 'static-hermes',
            staticHermesGc: 'hades',
            version: '1.2.3',
        });
    });

    it('normalizes Windows separators in package-relative build paths', () => {
        const config = readPluginConfig(
            packageWith({
                version: '1.2.3',
                pumpkinPlugin: { entry: 'src\\plugin.ts', output: 'build\\plugin.wasm' },
            }),
        );

        expect(config.entry).toBe('src/plugin.ts');
        expect(config.output).toBe('build/plugin.wasm');
    });

    it('supports selecting the lean Static Hermes Runtime', () => {
        const config = readPluginConfig(
            packageWith({ version: '1.2.3', pumpkinPlugin: { engine: 'static-hermes', staticHermesRuntime: 'lean' } }),
        );

        expect(config).toMatchObject({ staticHermesRuntime: 'lean' });
    });

    it('supports selecting malloc instead of the default Hades garbage collector', () => {
        const config = readPluginConfig(
            packageWith({ version: '1.2.3', pumpkinPlugin: { engine: 'static-hermes', staticHermesGc: 'malloc' } }),
        );

        expect(config).toMatchObject({ staticHermesGc: 'malloc' });
    });

    it('uses the default engine when selecting a Static Hermes Runtime profile', () => {
        const config = readPluginConfig(
            packageWith({ version: '1.2.3', pumpkinPlugin: { staticHermesRuntime: 'lean' } }),
        );

        expect(config).toMatchObject({ engine: 'static-hermes', staticHermesRuntime: 'lean' });
    });

    it('defaults to no capabilities', () => {
        expect(readPluginConfig(packageWith({ version: '0.0.0', pumpkinPlugin: {} })).wasi).toEqual([]);
    });

    it('explains a missing key and an unknown capability', () => {
        expect(() => readPluginConfig(packageWith({ version: '0.0.0' }))).toThrow(BuildError);
        expect(() => readPluginConfig(packageWith({ version: '0.0.0', pumpkinPlugin: { wasi: ['network'] } }))).toThrow(
            'unknown wasi capability "network" (known: http, filesystem, sockets, udp)',
        );
    });

    it('rejects malformed package data with a build error', () => {
        expect(() => readPluginConfig(packageWith([]))).toThrow('package.json must contain an object');
        expect(() => readPluginConfig(packageWith({ version: '0.0.0', pumpkinPlugin: [] }))).toThrow(
            'package.json needs a "pumpkinPlugin" object',
        );
        expect(() => readPluginConfig(packageWith({ version: 1, pumpkinPlugin: {} }))).toThrow(
            'package.json needs a non-empty "version" string',
        );
        expect(() => readPluginConfig(packageWith({ version: '0.0.0', pumpkinPlugin: { wasi: 'http' } }))).toThrow(
            '"pumpkinPlugin.wasi" must be an array of capability names',
        );
        expect(() => readPluginConfig(packageWith({ version: '0.0.0', pumpkinPlugin: { engine: 'hermes' } }))).toThrow(
            '"pumpkinPlugin.engine" must be "quickjs" or "static-hermes"',
        );
        expect(() =>
            readPluginConfig(
                packageWith({
                    version: '0.0.0',
                    pumpkinPlugin: { engine: 'static-hermes', staticHermesRuntime: 'tiny' },
                }),
            ),
        ).toThrow('"pumpkinPlugin.staticHermesRuntime" must be "full" or "lean"');
        expect(() =>
            readPluginConfig(
                packageWith({ version: '0.0.0', pumpkinPlugin: { engine: 'quickjs', staticHermesRuntime: 'lean' } }),
            ),
        ).toThrow('"pumpkinPlugin.staticHermesRuntime" requires "engine": "static-hermes"');
        expect(() =>
            readPluginConfig(
                packageWith({ version: '0.0.0', pumpkinPlugin: { engine: 'static-hermes', staticHermesGc: 'gen-gc' } }),
            ),
        ).toThrow('"pumpkinPlugin.staticHermesGc" must be "hades" or "malloc"');
        expect(() =>
            readPluginConfig(
                packageWith({ version: '0.0.0', pumpkinPlugin: { engine: 'quickjs', staticHermesGc: 'malloc' } }),
            ),
        ).toThrow('"pumpkinPlugin.staticHermesGc" requires "engine": "static-hermes"');
        expect(() => readPluginConfig(packageWith({ version: '0.0.0', pumpkinPlugin: { wasi: [null] } }))).toThrow(
            '"pumpkinPlugin.wasi" must contain only capability names',
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
        for (const entry of [
            42,
            '',
            '.',
            '\0plugin.ts',
            '../outside.ts',
            '/tmp/plugin.ts',
            'C:\\outside.ts',
            'C:plugin.ts',
        ]) {
            expect(() => readPluginConfig(packageWith({ version: '0.0.0', pumpkinPlugin: { entry } }))).toThrow(
                '"pumpkinPlugin.entry"',
            );
        }
        expect(() =>
            readPluginConfig(packageWith({ version: '0.0.0', pumpkinPlugin: { output: '../outside.wasm' } })),
        ).toThrow('"pumpkinPlugin.output"');
        expect(() =>
            readPluginConfig(packageWith({ version: '0.0.0', pumpkinPlugin: { output: 'package.json' } })),
        ).toThrow('must name a .wasm file');
    });
});

describe('requireBuildFields', () => {
    it('asks for both when either is missing, so libraries can still generate types', () => {
        expect(() => requireBuildFields({ entry: 'a', wasi: [], version: '0.0.0' })).toThrow(/entry.*output/);
        expect(() => requireBuildFields({ wasi: [], version: '0.0.0' })).toThrow(BuildError);
    });
});
