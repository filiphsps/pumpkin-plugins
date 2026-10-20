// Verifies a signed GitHub release artifact, then removes publisher signing sections before Market upload.
import * as fs from 'node:fs';
import { publicKeyOf, stripSignature, verifyWasm } from '@pumpkin-plugins/signing';
import { Command } from 'commander';

/**
 * Verifies the release artifact and returns its unsigned WebAssembly component for Market to sign.
 * @param {Uint8Array} wasm - The signed release artifact.
 * @param {{ pluginName: string, version: string, publicKeyHex: string }} expected - The canonical plugin
 *   name, the release version and the public key of the repository signing key.
 * @returns {Buffer} The verified component without publisher signing sections.
 */
export function prepareMarketPlugin(wasm, expected) {
    const verification = verifyWasm(wasm, expected.publicKeyHex);
    if (!verification.valid || !verification.metadata) {
        throw new Error(`signed release artifact failed verification: ${verification.error ?? 'invalid signature'}`);
    }
    if (verification.metadata.plugin_name !== expected.pluginName) {
        throw new Error(
            `signed release artifact plugin name ${JSON.stringify(verification.metadata.plugin_name)} does not match ${JSON.stringify(expected.pluginName)}`,
        );
    }
    if (verification.metadata.version !== expected.version) {
        throw new Error(
            `signed release artifact version ${JSON.stringify(verification.metadata.version)} does not match ${JSON.stringify(expected.version)}`,
        );
    }
    return stripSignature(wasm).clean;
}

if (import.meta.main) {
    const program = new Command()
        .name('prepare-market-plugin')
        .description(
            'Verify a signed release artifact and prepare it for Market signing. PLUGIN_SIGNING_KEY must hold the key it was signed with.',
        )
        .argument('<wasm-file>', 'Signed plugin artifact')
        .argument('<plugin-name>', 'Canonical plugin name')
        .argument('<version>', 'Release version')
        .parse(process.argv);
    const [file, pluginName, version] = program.args;
    if (!process.env.PLUGIN_SIGNING_KEY)
        program.error('Set PLUGIN_SIGNING_KEY to the key the artifact was signed with');
    const publicKeyHex = publicKeyOf(process.env.PLUGIN_SIGNING_KEY);

    const prepared = prepareMarketPlugin(fs.readFileSync(file), { pluginName, version, publicKeyHex });
    fs.writeFileSync(file, prepared);
    console.log(`Prepared unsigned Market component ${file} (${pluginName} ${version})`);
}
