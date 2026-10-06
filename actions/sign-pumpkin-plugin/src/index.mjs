import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { publicKeyOf, signWasm, verifyWasm } from '../../../tools/signing/src/index.ts';

const input = (name) => process.env[`INPUT_${name}`] ?? '';
const pluginName = input('PLUGIN_NAME').trim();
const version = input('VERSION').trim();
const wasmFile = input('WASM_FILE').trim();
const developerName = input('DEVELOPER_NAME').trim();
const signingKey = input('SIGNING_KEY').trim();
const warnOnMissingKey = input('WARN').trim().toLowerCase() === 'true';
const pluginsManifest = input('PLUGINS_MANIFEST').trim();

try {
    signRelease();
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`::error::${escapeWorkflowCommand(message)}`);
    process.exitCode = 1;
}

function signRelease() {
    if (!developerName) throw new Error('developer-name is required');

    if (pluginsManifest) {
        if (pluginName || version || wasmFile) {
            throw new Error('plugins-manifest cannot be combined with plugin-name, version, or wasm-file');
        }
        const manifestFile = path.resolve(process.cwd(), pluginsManifest);
        const plugins = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
        if (!Array.isArray(plugins) || plugins.length === 0) {
            throw new Error(`plugins-manifest must contain a non-empty JSON array: ${manifestFile}`);
        }
        for (const [index, plugin] of plugins.entries()) {
            if (!plugin || typeof plugin !== 'object' || Array.isArray(plugin)) {
                throw new Error(`plugins-manifest entry ${index + 1} must be an object`);
            }
            const name = plugin['plugin-name'];
            const pluginVersion = plugin.version;
            const fileName = plugin['wasm-file'];
            if (typeof name !== 'string' || typeof pluginVersion !== 'string' || typeof fileName !== 'string') {
                throw new Error(
                    `plugins-manifest entry ${index + 1} must include string plugin-name, version, and wasm-file fields`
                );
            }
            signPlugin(name, pluginVersion, fileName);
        }
        return;
    }

    signPlugin(pluginName, version, wasmFile);
}

function signPlugin(name, pluginVersion, fileName) {
    if (!name) throw new Error('plugin-name is required (or provide plugins-manifest)');
    if (!pluginVersion) throw new Error('version is required (or provide plugins-manifest)');
    if (!fileName) throw new Error('wasm-file is required (or provide plugins-manifest)');

    const file = path.resolve(process.cwd(), fileName);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`WASM file not found: ${file}`);

    if (!signingKey) {
        const message = `${name} ${pluginVersion} was not signed because the signing-key input is empty.`;
        if (!warnOnMissingKey) throw new Error(message);
        console.log(`::warning title=Plugin is unsigned::${escapeWorkflowCommand(message)}`);
        return;
    }

    const publicKey = publicKeyOf(signingKey);
    const signed = signWasm(
        fs.readFileSync(file),
        {
            marketplace_url: '',
            plugin_id: 0,
            plugin_name: name,
            version: pluginVersion,
            dev_id: 0,
            dev_name: developerName,
            is_paid: false,
            user_id: 0,
            license_key: null,
            issued_at: new Date().toISOString()
        },
        signingKey
    );
    const verification = verifyWasm(signed);
    if (!verification.valid || verification.publicKeyHex !== publicKey) {
        throw new Error(
            `Signed ${name} ${pluginVersion} failed signature verification: ${verification.error ?? 'unexpected public key'}`
        );
    }

    fs.writeFileSync(file, signed);
    const checksumFile = `${file}.sha256`;
    if (fs.existsSync(checksumFile)) {
        const checksum = createHash('sha256').update(signed).digest('hex');
        fs.writeFileSync(checksumFile, `${checksum}  ${path.basename(file)}\n`);
    }

    console.log(`Signed ${name} ${pluginVersion} with Ed25519 public key ${publicKey}.`);
}

function escapeWorkflowCommand(value) {
    return value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}
