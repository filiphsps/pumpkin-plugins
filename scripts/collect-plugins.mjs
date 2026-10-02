// Copies each plugin's built .wasm to dist/<plugin-dir>.wasm with a .sha256 next to it, the
// layout the release job uploads from. Run after `pnpm build`.
//
// When PLUGIN_SIGNING_KEY (a 32-byte Ed25519 seed as 64 hex characters) is set, each .wasm is
// signed the way Pumpkin verifies it, before its .sha256 is computed. Without the key the
// plugins are collected unsigned and a warning is printed; a malformed key fails the script.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { publicKeyOf, signWasm } from '@pumpkin-plugins/signing';

const DEV_NAME = 'Filiph Sandström';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const signingKey = process.env.PLUGIN_SIGNING_KEY?.trim() || undefined;

if (signingKey) {
    try {
        publicKeyOf(signingKey);
    } catch (error) {
        console.error(`PLUGIN_SIGNING_KEY is set but unusable: ${error.message}`);
        process.exit(1);
    }
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist);

const dirs = fs
    .readdirSync(path.join(root, 'packages'), { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(root, 'packages', d.name, 'package.json')));

async function pluginName(pkgDir, pkg) {
    const file = path.resolve(pkgDir, pkg.pumpkinPlugin?.info ?? 'src/info.ts');
    const mod = await import(pathToFileURL(file).href);
    const name = (mod.info ?? mod.default)?.name;
    if (typeof name !== 'string') throw new Error(`${file} must export an \`info\` object with a name`);
    return name;
}

for (const { name } of dirs) {
    const pkgDir = path.join(root, 'packages', name);
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    const output = pkg.pumpkinPlugin?.output;
    if (!output) throw new Error(`packages/${name}/package.json has no pumpkinPlugin.output`);
    const wasm = path.join(pkgDir, output);
    if (!fs.existsSync(wasm)) throw new Error(`${wasm} is missing; run \`pnpm build\` first`);

    const file = `${name}.wasm`;
    let bytes = fs.readFileSync(wasm);
    if (signingKey) {
        bytes = signWasm(
            bytes,
            {
                marketplace_url: '',
                plugin_id: 0,
                plugin_name: await pluginName(pkgDir, pkg),
                version: pkg.version,
                dev_id: 0,
                dev_name: DEV_NAME,
                is_paid: false,
                user_id: 0,
                license_key: null,
                issued_at: new Date().toISOString()
            },
            signingKey
        );
    }
    fs.writeFileSync(path.join(dist, file), bytes);
    fs.writeFileSync(
        path.join(dist, `${file}.sha256`),
        `${createHash('sha256').update(bytes).digest('hex')}  ${file}\n`
    );
    console.log(`dist/${file} (${(bytes.length / 1024).toFixed(0)} KiB, ${signingKey ? 'signed' : 'unsigned'})`);
}

if (!signingKey) {
    const message =
        'The plugin .wasm files are unsigned: PLUGIN_SIGNING_KEY is not set (expected for forks and local runs). ' +
        'Pumpkin loads unsigned plugins with a warning unless allow_unsigned = false. ' +
        'Set PLUGIN_SIGNING_KEY to a 64-hex Ed25519 seed (node scripts/generate-signing-key.mjs) to sign them.';
    if (process.env.GITHUB_ACTIONS) console.log(`::warning title=Plugins are unsigned::${message}`);
    else console.error(`warning: ${message}`);
}
