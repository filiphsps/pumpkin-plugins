// STUB: publishing to market.pumpkinmc.org is NOT implemented.
//
// Called by the `market` job in .github/workflows/ci.yml for each plugin that was just
// released. It reports what would be uploaded and emits a warning annotation, and it never
// touches the network, so releases are unaffected. Replace the body of `publish()` when the
// market's upload contract is known; the workflow wiring (matrix, artifact, secret) is done.
//
// Usage: node scripts/publish-to-market.mjs <plugin-dir> <tag> <wasm-file>
//
// Open questions to settle before implementing:
//  - Upload endpoint and request format. Nothing is publicly documented. The only market
//    endpoints seen are under https://market.pumpkinmc.org/api/v1/rest/ (telemetry heartbeat
//    and public-key); do not guess an upload route.
//  - Auth: an API token, expected in the MARKET_API_TOKEN repository secret.
//  - Signing: marketplace plugins carry `pumpkin.metadata` and `wasm_signature` custom
//    sections (Ed25519, see docs.pumpkinmc.org/developer/plugins/wasm-signing). Find out
//    whether the market signs an uploaded build itself or expects a pre-signed one. The
//    .wasm uploaded to the GitHub release is signed with our own key (an independent
//    plugin: marketplace ids 0) when the PLUGIN_SIGNING_KEY secret is set, else unsigned.
//  - Metadata the market likely needs from the release: version (the tag), changelog (the
//    release-please `<path>--body` output), and the plugin name from src/info.ts.
//  - Reproducibility: two builds of identical source produce different bytes (cause not
//    investigated). Sign and upload the exact artifact from the build job, which this job
//    downloads, and never rebuild.
//  - Idempotency: the job can be re-run, so a repeated upload of the same version must be
//    handled.

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';

const [pluginDir, tag, wasmFile] = process.argv.slice(2);
if (!pluginDir || !tag || !wasmFile) {
    console.error('usage: publish-to-market.mjs <plugin-dir> <tag> <wasm-file>');
    process.exit(1);
}

const token = process.env.MARKET_API_TOKEN;
const sha256 = createHash('sha256').update(fs.readFileSync(wasmFile)).digest('hex');

const summary = [
    `Plugin:  ${pluginDir}`,
    `Release: ${tag}`,
    `File:    ${wasmFile}`,
    `SHA-256: ${sha256}`,
    `Token:   ${token ? 'MARKET_API_TOKEN is set' : 'MARKET_API_TOKEN is not set'}`
].join('\n');

publish();

function publish() {
    // TODO: upload to market.pumpkinmc.org once its API is documented. See the notes above.
    console.log(`Would publish to market.pumpkinmc.org:\n${summary}`);
    console.log(
        `::warning title=Not published to market.pumpkinmc.org::${pluginDir} ${tag} was only released on GitHub. Uploading to market.pumpkinmc.org is a stub (scripts/publish-to-market.mjs).`
    );
    if (process.env.GITHUB_STEP_SUMMARY) {
        fs.appendFileSync(
            process.env.GITHUB_STEP_SUMMARY,
            `### ⚠️ ${tag}: not published to market.pumpkinmc.org\nUploading is a stub, nothing was sent.\n\n\`\`\`\n${summary}\n\`\`\`\n`
        );
    }
}
