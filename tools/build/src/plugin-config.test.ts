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

function packageWith(pkg: Record<string, unknown>): string {
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
});

describe('requireBuildFields', () => {
    it('returns entry and output', () => {
        expect(requireBuildFields({ entry: 'a', output: 'b', wasi: [], version: '0.0.0' })).toEqual({
            entry: 'a',
            output: 'b'
        });
    });

    it('asks for both when either is missing, so libraries can still generate types', () => {
        expect(() => requireBuildFields({ entry: 'a', wasi: [], version: '0.0.0' })).toThrow(/entry.*output/);
        expect(() => requireBuildFields({ wasi: [], version: '0.0.0' })).toThrow(BuildError);
    });
});
