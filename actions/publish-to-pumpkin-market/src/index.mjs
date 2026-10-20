// JavaScript action entry point. It uploads an existing build without rebuilding it.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeResponseBody } from '../../common/src/diagnostics.mjs';
import { findListingById, findListingByName, marketFetch, marketUrl } from '../../common/src/market.mjs';
import {
    appendSummary,
    escapeMarkdownText,
    escapeWorkflowCommand,
    getInput,
    setOutput,
} from '../../common/src/utils.mjs';

const pluginName = getInput('plugin-name').trim();
const pluginId = getInput('plugin-id').trim();
const version = getInput('version').trim();
const wasmFile = getInput('wasm-file').trim();
const token = getInput('api-token').trim();
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

    const baseUrl = marketUrl(getInput('api-url'));
    const listing = pluginId
        ? await findListingById(baseUrl, pluginId)
        : await findListingByName(baseUrl, pluginName, token);
    if (!listing?.version) {
        const reason = listing
            ? `Market listing ${listing.id} named ${JSON.stringify(listing.name)} has not been published yet`
            : pluginName
              ? `no Market listing named ${JSON.stringify(pluginName)} exists`
              : `no Market listing with ID ${JSON.stringify(pluginId)} exists`;
        unavailable(`${displayPlugin()} ${version} was not published because ${reason}.`, listing);
        return;
    }

    // A retried release job finds the version it uploaded on the first attempt.
    if (listing.version === version) {
        setListingOutputs(listing);
        setOutput('status', 'success');
        setOutput('published-version', version);
        const message = `Market listing ${listing.id} already has ${listing.name} ${version}; skipped the upload.`;
        console.log(escapeWorkflowCommand(message));
        appendSummary(
            `### 🛒 ${escapeMarkdownText(listing.name)} ${escapeMarkdownText(version)}: already on Pumpkin Market\n` +
                `${escapeMarkdownText(message)}\n`,
        );
        return;
    }

    const metadata = { version, track, releaseNotes };
    const form = new FormData();
    form.append('wasm', new Blob([fs.readFileSync(file)], { type: 'application/wasm' }), path.basename(file));
    form.append('metadata', JSON.stringify(metadata));

    const response = await marketFetch(`${baseUrl}/api/plugins/${listing.id}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
    });
    if (!response.ok)
        throw new Error(
            `Market update for ${listing.name} failed (${response.status}): ${await safeResponseBody(response, token)}`,
        );

    setListingOutputs(listing);
    setOutput('status', 'success');
    setOutput('published-version', version);
    const message = `Published ${listing.name} ${version} to Market listing ${listing.id}.`;
    console.log(escapeWorkflowCommand(message));
    appendSummary(
        `### 🛒 ${escapeMarkdownText(listing.name)} ${escapeMarkdownText(version)}: published to Pumpkin Market\n` +
            `${escapeMarkdownText(message)}\n`,
    );
}

function unavailable(message, listing) {
    if (!warnOnUnavailable) throw new Error(message);
    if (listing) setListingOutputs(listing);
    setOutput('status', 'skipped');
    console.log(`::warning title=Not published to Pumpkin Market::${escapeWorkflowCommand(message)}`);
    appendSummary(`### ⚠️ Not published to Pumpkin Market\n${escapeMarkdownText(message)}\n`);
}

function displayPlugin() {
    return pluginName || `Market listing ${JSON.stringify(pluginId)}`;
}

function setListingOutputs(listing) {
    setOutput('listing-id', String(listing.id));
    setOutput('listing-name', listing.name);
}
