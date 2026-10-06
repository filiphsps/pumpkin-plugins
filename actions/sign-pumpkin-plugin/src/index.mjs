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

try {
    signRelease();
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`::error::${escapeWorkflowCommand(message)}`);
    process.exitCode = 1;
}

function signRelease() {
    if (!pluginName) throw new Error('plugin-name is required');
    if (!version) throw new Error('version is required');
    if (!wasmFile) throw new Error('wasm-file is required');
    if (!developerName) throw new Error('developer-name is required');

    const file = path.resolve(process.cwd(), wasmFile);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`WASM file not found: ${file}`);

    if (!signingKey) {
        const message = `${pluginName} ${version} was not signed because the signing-key input is empty.`;
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
            plugin_name: pluginName,
            version,
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
            `Signed ${pluginName} ${version} failed signature verification: ${verification.error ?? 'unexpected public key'}`
        );
    }

    fs.writeFileSync(file, signed);
    const checksumFile = `${file}.sha256`;
    if (fs.existsSync(checksumFile)) {
        const checksum = createHash('sha256').update(signed).digest('hex');
        fs.writeFileSync(checksumFile, `${checksum}  ${path.basename(file)}\n`);
    }

    console.log(`Signed ${pluginName} ${version} with Ed25519 public key ${publicKey}.`);
}

function escapeWorkflowCommand(value) {
    return value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}
