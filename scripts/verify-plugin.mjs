// Checks the signature of a plugin .wasm. Exits 1 when it is unsigned or invalid.
// Usage: node scripts/verify-plugin.mjs <file.wasm>
import * as fs from 'node:fs';
import { verifyWasm } from '@pumpkin-plugins/signing';

const file = process.argv[2];
if (!file) {
    console.error('Usage: node scripts/verify-plugin.mjs <file.wasm>');
    process.exit(2);
}

const result = verifyWasm(fs.readFileSync(file));
console.log(`signed:     ${result.signed}`);
console.log(`valid:      ${result.valid}`);
if (result.metadata) {
    console.log(`plugin:     ${result.metadata.plugin_name}`);
    console.log(`version:    ${result.metadata.version}`);
    console.log(`developer:  ${result.metadata.dev_name}`);
    console.log(`issued at:  ${result.metadata.issued_at}`);
}
if (result.publicKeyHex) console.log(`public key: ${result.publicKeyHex}`);
if (result.error) console.error(`error: ${result.error}`);
process.exit(result.valid ? 0 : 1);
