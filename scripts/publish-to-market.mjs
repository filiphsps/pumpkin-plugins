// Uploads a released plugin build to its existing market.pumpkinmc.org listing.
//
// Usage: node scripts/publish-to-market.mjs <plugin-dir> <tag> <wasm-file>
//
// The market listing must already exist. This deliberately does not create listings: creating one
// needs its store metadata and is a human review step. A missing listing is a warning so a GitHub
// release is never held up by a plugin that has not reached the market yet.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const [pluginDir, tag, wasmFile] = process.argv.slice(2);
if (!pluginDir || !tag || !wasmFile) {
    console.error('usage: publish-to-market.mjs <plugin-dir> <tag> <wasm-file>');
    process.exit(1);
}

const apiUrl = (process.env.MARKET_API_URL ?? 'https://market.pumpkinmc.org/api/v1/rest').replace(/\/$/, '');
const token = process.env.MARKET_API_TOKEN?.trim();

await publish();

async function publish() {
    if (!token) {
        warn(`${tag} was not published because MARKET_API_TOKEN is not set.`);
        return;
    }

    const pluginName = await nameOf(pluginDir);
    const listing = await findListing(pluginName);
    if (!listing?.version) {
        const reason = listing
            ? `market listing ${listing.id} named ${JSON.stringify(pluginName)} has not been published yet`
            : `no market listing named ${JSON.stringify(pluginName)} exists`;
        warn(`${tag} was not published because ${reason}.`);
        return;
    }

    const metadata = { version: versionFrom(tag), track: 'stable' };
    const form = new FormData();
    form.append('wasm', new Blob([fs.readFileSync(wasmFile)]), path.basename(wasmFile));
    form.append('metadata', JSON.stringify(metadata));

    const response = await fetch(`${apiUrl}/plugins/${listing.id}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}` },
        body: form
    });
    if (!response.ok)
        throw new Error(`market update for ${pluginName} failed (${response.status}): ${await response.text()}`);

    const message = `Published ${pluginName} ${metadata.version} to market listing ${listing.id}.`;
    console.log(message);
    summary(`### 🛒 ${tag}: published to market.pumpkinmc.org\n${message}\n`);
}

/** Returns the plugin's Pumpkin name from the same info module used by the build collector. */
async function nameOf(dir) {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const infoFile = path.resolve(dir, pkg.pumpkinPlugin?.info ?? 'src/info.ts');
    const mod = await import(pathToFileURL(infoFile).href);
    const name = (mod.info ?? mod.default)?.name;
    if (typeof name !== 'string' || !name) throw new Error(`${infoFile} must export an info object with a name`);
    return name;
}

/** Finds the single existing market listing with this exact Pumpkin plugin name. */
async function findListing(pluginName) {
    const response = await fetch(`${apiUrl}/plugins?limit=100`);
    if (!response.ok) throw new Error(`could not list market plugins (${response.status}): ${await response.text()}`);
    const body = await response.json();
    const listings = Array.isArray(body) ? body : (body.data ?? body.results);
    if (!Array.isArray(listings)) throw new Error('market plugin list was not an array');
    const matches = listings.filter((listing) => listing?.name === pluginName && Number.isInteger(listing.id));
    if (matches.length > 1) throw new Error(`market has multiple listings named ${JSON.stringify(pluginName)}`);
    return matches[0];
}

/** Extracts the version portion of a release-please tag such as `upnpumpkin-v1.2.3`. */
function versionFrom(releaseTag) {
    const version = releaseTag.match(/-v(.+)$/)?.[1];
    if (!version) throw new Error(`cannot extract a version from release tag ${JSON.stringify(releaseTag)}`);
    return version;
}

function warn(message) {
    console.log(`::warning title=Not published to market.pumpkinmc.org::${message}`);
    summary(`### ⚠️ ${tag}: not published to market.pumpkinmc.org\n${message}\n`);
}

function summary(content) {
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${content}\n`);
}
