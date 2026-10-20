// Copies each plugin's built .wasm to dist/<plugin-dir>.wasm with a .sha256 next to it, the
// layout the release job uploads from. Run after `pnpm build`.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { discoverComponents } from '@pumpkin-plugins/docs/node';
import { Command } from 'commander';
import { loadPluginInfo } from './utils/plugin-info.mjs';

const root = path.resolve(import.meta.dirname, '..');

/**
 * Collect built plugin files and optionally write metadata for the signing action.
 *
 * @param {{root?: string, dist?: string, manifestFile?: string}} options Collection paths.
 */
export async function collectPlugins({ root: repoRoot = root, dist = path.join(repoRoot, 'dist'), manifestFile } = {}) {
    fs.rmSync(dist, { recursive: true, force: true });
    fs.mkdirSync(dist, { recursive: true });

    const plugins = [];
    for (const { slug: name, directory: pkgDir, metadataFile } of discoverComponents(repoRoot, 'packages')) {
        const pkg = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
        const output = pkg.pumpkinPlugin?.output;
        if (!output) throw new Error(`packages/${name}/package.json has no pumpkinPlugin.output`);
        const wasm = path.join(pkgDir, output);
        if (!fs.existsSync(wasm)) throw new Error(`${wasm} is missing; run \`pnpm build\` first`);

        const file = `${name}.wasm`;
        const bytes = fs.readFileSync(wasm);
        fs.writeFileSync(path.join(dist, file), bytes);
        fs.writeFileSync(
            path.join(dist, `${file}.sha256`),
            `${createHash('sha256').update(bytes).digest('hex')}  ${file}\n`,
        );
        console.log(`dist/${file} (${(bytes.length / 1024).toFixed(0)} KiB)`);

        if (manifestFile) {
            const pluginName = (await loadPluginInfo(pkgDir, pkg)).info.name;
            plugins.push({ 'plugin-name': pluginName, version: pkg.version, 'wasm-file': path.join(dist, file) });
        }
    }

    if (manifestFile) {
        fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
        fs.writeFileSync(manifestFile, `${JSON.stringify(plugins, null, 2)}\n`);
    }
}

if (import.meta.main) {
    const program = new Command()
        .name('collect-plugins')
        .description('Collect built plugins into the release distribution directory.')
        .option('--manifest <path>', 'Write the collected plugin metadata to a JSON file')
        .parse(process.argv);
    const { manifest } = program.opts();
    await collectPlugins({ manifestFile: manifest ? path.resolve(manifest) : undefined });
}
