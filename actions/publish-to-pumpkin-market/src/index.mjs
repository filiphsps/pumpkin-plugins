// JavaScript action entry point. It uploads an existing build without rebuilding it.

import * as fs from 'node:fs';
import * as path from 'node:path';

// GitHub preserves hyphens in INPUT_* names, matching @actions/core.
const input = (name) => process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] ?? '';
const pluginName = input('plugin-name').trim();
const version = input('version').trim();
const wasmFile = input('wasm-file').trim();
const token = input('api-token').trim();
const marketUrl = (input('api-url').trim() || 'https://market.pumpkinmc.org').replace(/\/+$/, '');
const track = input('track').trim() || 'stable';
const releaseNotes = input('release-notes').trim();
const warnOnUnavailable = input('warn').trim().toLowerCase() === 'true';

try {
    await publish();
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`::error::${escapeWorkflowCommand(message)}`);
    process.exitCode = 1;
}

async function publish() {
    if (!pluginName) throw new Error('plugin-name is required');
    if (!version) throw new Error('version is required');
    if (!wasmFile) throw new Error('wasm-file is required');

    const file = path.resolve(process.cwd(), wasmFile);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`WASM file not found: ${file}`);

    if (!token) {
        unavailable(`${pluginName} ${version} was not published because the api-token input is empty.`);
        return;
    }

    const listing = await findListing(pluginName);
    if (!listing?.version) {
        const reason = listing
            ? `Market listing ${listing.id} named ${JSON.stringify(pluginName)} has not been published yet`
            : `no Market listing named ${JSON.stringify(pluginName)} exists`;
        unavailable(`${pluginName} ${version} was not published because ${reason}.`);
        return;
    }

    const metadata = { version, track, releaseNotes };
    const form = new FormData();
    form.append('wasm', new Blob([fs.readFileSync(file)]), path.basename(file));
    form.append('metadata', JSON.stringify(metadata));

    const response = await marketFetch(`${marketUrl}/api/plugins/${listing.id}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}` },
        body: form
    });
    if (!response.ok)
        throw new Error(`Market update for ${pluginName} failed (${response.status}): ${await response.text()}`);

    const message = `Published ${pluginName} ${version} to Market listing ${listing.id}.`;
    console.log(message);
    summary(`### 🛒 ${pluginName} ${version}: published to Pumpkin Market\n${message}\n`);
}

/** Retrieves a Market listing directly, then falls back to a bounded exact-name search. */
async function findListing(name) {
    const direct = await marketFetch(`${marketUrl}/api/v1/rest/plugins/${encodeURIComponent(name)}`);
    if (direct.ok) {
        const listing = await direct.json();
        if (isExactName(listing, name) && Number.isInteger(listing.id)) return listing;
    }

    const searchUrl = new URL(`${marketUrl}/api/v1/rest/plugins`);
    searchUrl.searchParams.set('q', name);
    searchUrl.searchParams.set('limit', '20');
    const response = await marketFetch(searchUrl);
    if (!response.ok) throw new Error(`Could not search Market plugins (${response.status}): ${await response.text()}`);
    const listings = await response.json();
    if (!Array.isArray(listings)) throw new Error('Market plugin search response was not an array');
    const matches = listings.filter((listing) => isExactName(listing, name) && Number.isInteger(listing.id));
    if (matches.length > 1) throw new Error(`Market has multiple listings named ${JSON.stringify(name)}`);
    return matches[0];
}

function isExactName(listing, name) {
    return typeof listing?.name === 'string' && listing.name.toLowerCase() === name.toLowerCase();
}

function unavailable(message) {
    if (!warnOnUnavailable) throw new Error(message);
    console.log(`::warning title=Not published to Pumpkin Market::${escapeWorkflowCommand(message)}`);
    summary(`### ⚠️ Not published to Pumpkin Market\n${message}\n`);
}

function marketFetch(url, options = {}) {
    return fetch(url, { ...options, signal: AbortSignal.timeout(30_000) });
}

function escapeWorkflowCommand(value) {
    return value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

function summary(content) {
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${content}\n`);
}
