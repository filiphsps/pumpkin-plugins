import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

const root = path.resolve(import.meta.dirname, '../../../..');

/** A probe plugin built with Static Hermes in its own kept directory. */
export interface ProbePlugin {
    /** Directory with the probe source, its build output and the saved evidence. */
    directory: string;
    /** The built plugin component. */
    wasm: string;
}

/**
 * Builds `source` as a Static Hermes plugin with the repository build CLI.
 *
 * The probe can import `@pumpkin-plugins/pumpkin-api`, `@pumpkin-plugins/plugin-kit` and
 * `@pumpkin-plugins/docs`. Its directory is kept so the plugin and its evidence can be inspected.
 */
export function buildProbePlugin(name: string, source: string): ProbePlugin {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `hermes-${name}-`));
    const modules = path.join(directory, 'node_modules/@pumpkin-plugins');
    fs.mkdirSync(modules, { recursive: true });
    const api = path.dirname(createRequire(import.meta.url).resolve('@pumpkin-plugins/pumpkin-api/package.json'));
    fs.symlinkSync(api, path.join(modules, 'pumpkin-api'), 'dir');
    fs.symlinkSync(path.join(root, 'tools/plugin-kit'), path.join(modules, 'plugin-kit'), 'dir');
    fs.symlinkSync(path.join(root, 'tools/docs'), path.join(modules, 'docs'), 'dir');
    fs.writeFileSync(
        path.join(directory, 'package.json'),
        JSON.stringify({
            name,
            version: '0.0.0',
            dependencies: { '@pumpkin-plugins/pumpkin-api': `link:${api}` },
            pumpkinPlugin: { entry: 'plugin.ts', output: 'plugin.wasm', engine: 'static-hermes', wasi: [] },
        }),
    );
    fs.writeFileSync(path.join(directory, 'plugin.ts'), source);
    execFileSync(process.execPath, [path.join(root, 'tools/build/dist/cli.js')], {
        cwd: directory,
        env: {
            ...process.env,
            STATIC_HERMES_CACHE_DIR: process.env.STATIC_HERMES_CACHE_DIR ?? path.join(root, '.cache/hermes'),
            PUMPKIN_DEV_MODE: '1',
        },
        stdio: 'pipe',
    });
    return { directory, wasm: path.join(directory, 'plugin.wasm') };
}

/** Saves the server log lines of one scenario next to the probe plugin that produced them. */
export function saveEvidence(probe: ProbePlugin, scenario: string, lines: readonly string[]): void {
    const file = path.join(probe.directory, `${scenario}.log`);
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    console.log(`Saved ${scenario} evidence: ${file}`);
}
