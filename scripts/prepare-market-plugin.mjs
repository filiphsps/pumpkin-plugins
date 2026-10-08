// Verifies a signed GitHub release artifact, then removes publisher signing sections before Market upload.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { stripSignature, verifyWasm } from '@pumpkin-plugins/signing';

/**
 * Verifies the release artifact and returns its unsigned WebAssembly component for Market to sign.
 * @param {Uint8Array} wasm - The signed release artifact.
 * @param {{ pluginName: string, version: string }} expected - The canonical plugin name and release version.
 * @returns {Buffer} The verified component without publisher signing sections.
 */
export function prepareMarketPlugin(wasm, expected) {
    const verification = verifyWasm(wasm);
    if (!verification.valid || !verification.metadata) {
        throw new Error(`signed release artifact failed verification: ${verification.error ?? 'invalid signature'}`);
    }
    if (verification.metadata.plugin_name !== expected.pluginName) {
        throw new Error(
            `signed release artifact plugin name ${JSON.stringify(verification.metadata.plugin_name)} does not match ${JSON.stringify(expected.pluginName)}`
        );
    }
    if (verification.metadata.version !== expected.version) {
        throw new Error(
            `signed release artifact version ${JSON.stringify(verification.metadata.version)} does not match ${JSON.stringify(expected.version)}`
        );
    }
    return stripSignature(wasm).clean;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
    const [file, pluginName, version] = process.argv.slice(2);
    if (!file || !pluginName || !version) {
        console.error('usage: node scripts/prepare-market-plugin.mjs <wasm-file> <plugin-name> <version>');
        process.exit(2);
    }

    const prepared = prepareMarketPlugin(fs.readFileSync(file), { pluginName, version });
    fs.writeFileSync(file, prepared);
    console.log(`Prepared unsigned Market component ${file} (${pluginName} ${version})`);
}
