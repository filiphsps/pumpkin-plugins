// Copies each plugin's built .wasm to dist/<plugin-dir>.wasm with a .sha256 next to it, the
// layout the release job uploads from. Run after `pnpm build`.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');

/**
 * Collect built plugin files and optionally write metadata for the signing action.
 *
 * @param {{root?: string, dist?: string, manifestFile?: string}} options Collection paths.
 */
export async function collectPlugins({ root: repoRoot = root, dist = path.join(repoRoot, 'dist'), manifestFile } = {}) {
    fs.rmSync(dist, { recursive: true, force: true });
    fs.mkdirSync(dist, { recursive: true });

    const dirs = fs
        .readdirSync(path.join(repoRoot, 'packages'), { withFileTypes: true })
        .filter((d) => d.isDirectory() && fs.existsSync(path.join(repoRoot, 'packages', d.name, 'package.json')));
    const plugins = [];

    for (const { name } of dirs) {
        const pkgDir = path.join(repoRoot, 'packages', name);
        const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
        const output = pkg.pumpkinPlugin?.output;
        if (!output) throw new Error(`packages/${name}/package.json has no pumpkinPlugin.output`);
        const wasm = path.join(pkgDir, output);
        if (!fs.existsSync(wasm)) throw new Error(`${wasm} is missing; run \`pnpm build\` first`);

        const file = `${name}.wasm`;
        const bytes = fs.readFileSync(wasm);
        fs.writeFileSync(path.join(dist, file), bytes);
        fs.writeFileSync(
            path.join(dist, `${file}.sha256`),
            `${createHash('sha256').update(bytes).digest('hex')}  ${file}\n`
        );
        console.log(`dist/${file} (${(bytes.length / 1024).toFixed(0)} KiB)`);

        if (manifestFile) {
            const infoFile = path.resolve(pkgDir, pkg.pumpkinPlugin?.info ?? 'src/info.ts');
            const info = await import(pathToFileURL(infoFile).href);
            const pluginName = (info.info ?? info.default)?.name;
            if (typeof pluginName !== 'string') {
                throw new Error(`${infoFile} must export an \`info\` object with a name`);
            }
            plugins.push({ 'plugin-name': pluginName, version: pkg.version, 'wasm-file': path.join(dist, file) });
        }
    }

    if (manifestFile) {
        fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
        fs.writeFileSync(manifestFile, `${JSON.stringify(plugins, null, 2)}\n`);
    }
}

function isMain() {
    return process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}

if (isMain()) {
    const args = process.argv.slice(2);
    const manifestFlag = args.indexOf('--manifest');
    if (manifestFlag !== -1 && (!args[manifestFlag + 1] || args[manifestFlag + 2])) {
        throw new Error('Usage: node scripts/collect-plugins.mjs [--manifest <path>]');
    }
    await collectPlugins({ manifestFile: manifestFlag === -1 ? undefined : path.resolve(args[manifestFlag + 1]) });
}
