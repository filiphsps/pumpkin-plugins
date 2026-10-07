import * as fs from 'node:fs';
import * as path from 'node:path';
import { getInput, setOutput } from '../../common/src/utils.mjs';

const pluginName = getInput('plugin-name').trim();
const pluginId = getInput('plugin-id').trim();
const metadataFile = getInput('metadata-file').trim();
const updateMode = getInput('update-mode').trim().toLowerCase() || 'patch';
const token = getInput('api-token').trim();
const marketUrl = (getInput('api-url').trim() || 'https://market.pumpkinmc.org').replace(/\/+$/, '');

try {
    await updateListing();
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`::error::${escapeWorkflowCommand(message)}`);
    process.exitCode = 1;
}

async function updateListing() {
    validateInputs();
    const metadata = readMetadata();
    const listing = pluginId ? await findListingById(pluginId) : await findListingByName(pluginName);

    const form = new FormData();
    form.append('metadata', JSON.stringify(metadata));
    const response = await marketFetch(`${marketUrl}/api/plugins/${listing.id}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}` },
        body: form
    });
    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Market metadata update failed (${response.status}): ${safeBody(body, token)}`);
    }

    setOutput('listing-id', String(listing.id));
    setOutput('listing-name', listing.name);
    setOutput('status', 'success');
    const message = `Updated metadata for Market listing ${JSON.stringify(listing.name)} (${listing.id}).`;
    console.log(message);
    summary(`### 🛒 Updated Pumpkin Market listing\n${message}\n`);
}

function validateInputs() {
    if (Boolean(pluginName) === Boolean(pluginId)) {
        throw new Error('Set exactly one of plugin-name or plugin-id');
    }
    if (!token) throw new Error('api-token is required');
    if (updateMode !== 'patch' && updateMode !== 'full') throw new Error('update-mode must be patch or full');
}

function readMetadata() {
    let metadata = {};
    if (metadataFile) {
        const file = path.resolve(process.cwd(), metadataFile);
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`Metadata file not found: ${file}`);
        try {
            metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (error) {
            throw new Error(`Could not parse metadata file ${file}: ${error instanceof Error ? error.message : error}`);
        }
        if (!isRecord(metadata)) throw new Error('metadata-file must contain a JSON object');
    }

    metadata = { ...metadata };
    const displayName = getInput('display-name');
    const description = getInput('description');
    const category = getInput('category');
    const sourceLink = getInput('source-link');
    const youtubeVideoUrl = getInput('youtube-video-url');
    const keywords = getInput('keywords');
    const translatedDescriptions = getInput('translated-descriptions');
    const isEarlyAccess = getInput('is-early-access');
    const commands = getInput('commands');
    let hasDirectInput = false;

    if (displayName.trim()) {
        metadata.name = displayName.trim();
        hasDirectInput = true;
    }
    if (category.trim()) {
        metadata.category = category.trim();
        hasDirectInput = true;
    }
    if (sourceLink.trim()) {
        metadata.sourceLink = sourceLink.trim();
        hasDirectInput = true;
    }
    if (youtubeVideoUrl.trim()) {
        metadata.youtubeVideoUrl = youtubeVideoUrl.trim();
        hasDirectInput = true;
    }
    if (keywords.trim()) {
        metadata.keywords = keywords.trim();
        hasDirectInput = true;
    }
    if (translatedDescriptions.trim()) {
        const descriptions = parseJsonInput('translated-descriptions', translatedDescriptions);
        if (!isStringRecord(descriptions)) throw new Error('translated-descriptions must be a JSON object of strings');
        metadata.translatedDescriptions = descriptions;
        hasDirectInput = true;
    }
    if (isEarlyAccess.trim()) {
        const value = isEarlyAccess.trim().toLowerCase();
        if (value !== 'true' && value !== 'false') throw new Error('is-early-access must be true or false');
        metadata.isEarlyAccess = value === 'true';
        hasDirectInput = true;
    }
    if (commands.trim()) {
        const value = parseJsonInput('commands', commands);
        validateCommands(value);
        metadata.commands = value;
        hasDirectInput = true;
    }
    if (description.trim()) {
        if (metadata.translatedDescriptions === undefined) metadata.translatedDescriptions = {};
        if (!isStringRecord(metadata.translatedDescriptions)) {
            throw new Error('metadata translatedDescriptions must be an object of strings when using description');
        }
        metadata.translatedDescriptions = { ...metadata.translatedDescriptions, 'en-US': description };
        hasDirectInput = true;
    }

    if (!metadataFile && !hasDirectInput) throw new Error('Provide metadata-file or at least one metadata input');
    if (!isRecord(metadata)) throw new Error('Metadata must be a JSON object');
    if (Object.keys(metadata).length === 0) throw new Error('Metadata must not be empty');
    validateMetadata(metadata);

    if (updateMode === 'full') {
        const required = [
            'name',
            'category',
            'sourceLink',
            'youtubeVideoUrl',
            'keywords',
            'translatedDescriptions',
            'isEarlyAccess',
            'commands'
        ];
        const missing = required.filter((field) => !Object.hasOwn(metadata, field));
        if (missing.length) throw new Error(`Full metadata is missing fields: ${missing.join(', ')}`);
    }

    return metadata;
}

function parseJsonInput(name, value) {
    try {
        return JSON.parse(value);
    } catch (error) {
        throw new Error(`${name} must contain valid JSON: ${error instanceof Error ? error.message : error}`);
    }
}

function validateCommands(commands) {
    if (!Array.isArray(commands)) throw new Error('commands must be a JSON array');
    for (const [index, command] of commands.entries()) {
        if (!isRecord(command) || typeof command.name !== 'string' || !command.name.trim()) {
            throw new Error(`commands[${index}] must be an object with a non-empty name`);
        }
        if (
            command.aliases !== undefined &&
            (!Array.isArray(command.aliases) || !command.aliases.every((alias) => typeof alias === 'string'))
        ) {
            throw new Error(`commands[${index}].aliases must be an array`);
        }
        if (command.id !== undefined && (!Number.isInteger(command.id) || command.id < 1)) {
            throw new Error(`commands[${index}].id must be a positive integer`);
        }
        if (command.permission !== undefined && typeof command.permission !== 'string') {
            throw new Error(`commands[${index}].permission must be a string`);
        }
        if (
            command.display_order !== undefined &&
            (!Number.isInteger(command.display_order) || command.display_order < 0)
        ) {
            throw new Error(`commands[${index}].display_order must be a non-negative integer`);
        }
        if (
            command.description !== undefined &&
            command.description !== null &&
            typeof command.description !== 'string' &&
            !isStringRecord(command.description)
        ) {
            throw new Error(`commands[${index}].description must be a string or an object of localized strings`);
        }
    }
}

function validateMetadata(metadata) {
    for (const field of ['name', 'category']) {
        if (Object.hasOwn(metadata, field) && typeof metadata[field] !== 'string') {
            throw new Error(`metadata ${field} must be a string`);
        }
        if (Object.hasOwn(metadata, field) && !metadata[field].trim()) {
            throw new Error(`metadata ${field} must not be empty`);
        }
    }
    for (const field of ['sourceLink', 'youtubeVideoUrl', 'keywords']) {
        if (Object.hasOwn(metadata, field) && metadata[field] !== null && typeof metadata[field] !== 'string') {
            throw new Error(`metadata ${field} must be a string or null`);
        }
    }
    if (
        Object.hasOwn(metadata, 'translatedDescriptions') &&
        metadata.translatedDescriptions !== null &&
        typeof metadata.translatedDescriptions !== 'string' &&
        !isStringRecord(metadata.translatedDescriptions)
    ) {
        throw new Error('metadata translatedDescriptions must be a string, null, or an object of strings');
    }
    if (Object.hasOwn(metadata, 'isEarlyAccess') && typeof metadata.isEarlyAccess !== 'boolean') {
        throw new Error('metadata isEarlyAccess must be a boolean');
    }
    if (Object.hasOwn(metadata, 'commands')) validateCommands(metadata.commands);
}

async function findListingById(id) {
    const response = await marketFetch(`${marketUrl}/api/v1/rest/plugins/${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error(`Could not find Market listing ${JSON.stringify(id)} (${response.status})`);
    const listing = await readListing(response);
    if (!isRecord(listing) || !Number.isInteger(listing.id) || typeof listing.name !== 'string' || !listing.name) {
        throw new Error('Market listing lookup returned an invalid listing');
    }
    return listing;
}

async function findListingByName(name) {
    const direct = await marketFetch(`${marketUrl}/api/v1/rest/plugins/${encodeURIComponent(name)}`);
    if (direct.ok) {
        const listing = await readListing(direct);
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
    if (!matches.length) throw new Error(`No Market listing named ${JSON.stringify(name)} exists`);
    return matches[0];
}

async function readListing(response) {
    try {
        return await response.json();
    } catch (error) {
        throw new Error(
            `Market listing lookup returned invalid JSON: ${error instanceof Error ? error.message : error}`
        );
    }
}

function isExactName(listing, name) {
    return typeof listing?.name === 'string' && listing.name.toLowerCase() === name.toLowerCase();
}

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringRecord(value) {
    return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function marketFetch(url, options = {}) {
    return fetch(url, { ...options, signal: AbortSignal.timeout(30_000) });
}

function safeBody(body, secret) {
    const redacted = secret ? body.replaceAll(secret, '[REDACTED]') : body;
    return redacted.slice(0, 1000);
}

function escapeWorkflowCommand(value) {
    return value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

function summary(content) {
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${content}\n`);
}
