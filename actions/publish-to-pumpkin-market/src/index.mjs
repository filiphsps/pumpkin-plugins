// JavaScript action entry point. It uploads an existing build without rebuilding it.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getInput, setOutput } from '../../common/src/utils.mjs';

const pluginName = getInput('plugin-name').trim();
const pluginId = getInput('plugin-id').trim();
const version = getInput('version').trim();
const wasmFile = getInput('wasm-file').trim();
const token = getInput('api-token').trim();
const marketUrl = (getInput('api-url').trim() || 'https://market.pumpkinmc.org').replace(/\/+$/, '');
const track = getInput('track').trim() || 'stable';
const releaseNotes = getInput('release-notes').trim();
const warnOnUnavailable = getInput('warn').trim().toLowerCase() === 'true';

try {
    await publish();
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`::error::${escapeWorkflowCommand(message)}`);
    process.exitCode = 1;
}

async function publish() {
    if (Boolean(pluginName) === Boolean(pluginId)) throw new Error('Set exactly one of plugin-name or plugin-id');
    if (!version) throw new Error('version is required');
    if (!wasmFile) throw new Error('wasm-file is required');

    const file = path.resolve(process.cwd(), wasmFile);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`WASM file not found: ${file}`);

    if (!token) {
        unavailable(`${displayPlugin()} ${version} was not published because the api-token input is empty.`);
        return;
    }

    const listing = pluginId ? await findListingById(pluginId) : await findListingByName(pluginName);
    if (!listing?.version) {
        const reason = listing
            ? `Market listing ${listing.id} named ${JSON.stringify(listing.name)} has not been published yet`
            : pluginName
              ? `no Market listing named ${JSON.stringify(pluginName)} exists`
              : `no Market listing with ID ${JSON.stringify(pluginId)} exists`;
        unavailable(`${displayPlugin()} ${version} was not published because ${reason}.`, listing);
        return;
    }

    const metadata = { version, track, releaseNotes };
    const form = new FormData();
    form.append('wasm', new Blob([fs.readFileSync(file)], { type: 'application/wasm' }), path.basename(file));
    form.append('metadata', JSON.stringify(metadata));

    const response = await marketFetch(`${marketUrl}/api/plugins/${listing.id}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}` },
        body: form
    });
    if (!response.ok)
        throw new Error(`Market update for ${listing.name} failed (${response.status}): ${await response.text()}`);

    setListingOutputs(listing);
    setOutput('status', 'success');
    setOutput('published-version', version);
    const message = `Published ${listing.name} ${version} to Market listing ${listing.id}.`;
    console.log(message);
    summary(`### 🛒 ${listing.name} ${version}: published to Pumpkin Market\n${message}\n`);
}

/** Retrieves a Market listing directly, then falls back to a bounded exact-name search. */
async function findListingByName(name) {
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

/** Resolves a numeric or public Market ID to the listing's numeric database ID. */
async function findListingById(id) {
    const response = await marketFetch(`${marketUrl}/api/v1/rest/plugins/${encodeURIComponent(id)}`);
    if (!response.ok) return undefined;
    const listing = await response.json();
    if (!Number.isInteger(listing?.id) || typeof listing.name !== 'string' || !listing.name) return undefined;
    return listing;
}

function isExactName(listing, name) {
    return typeof listing?.name === 'string' && listing.name.toLowerCase() === name.toLowerCase();
}

function unavailable(message, listing) {
    if (!warnOnUnavailable) throw new Error(message);
    if (listing) setListingOutputs(listing);
    setOutput('status', 'skipped');
    console.log(`::warning title=Not published to Pumpkin Market::${escapeWorkflowCommand(message)}`);
    summary(`### ⚠️ Not published to Pumpkin Market\n${message}\n`);
}

function displayPlugin() {
    return pluginName || `Market listing ${JSON.stringify(pluginId)}`;
}

function setListingOutputs(listing) {
    setOutput('listing-id', String(listing.id));
    setOutput('listing-name', listing.name);
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
