import { readBoundedJson, safeResponseBody } from './diagnostics.mjs';

/** Base URL of the public Pumpkin Market, used when the api-url input is empty. */
export const MARKET_URL = 'https://market.pumpkinmc.org';

const searchPageSize = 20;
const maxSearchPages = 10;
const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Normalizes the api-url input and checks that the API token will only travel over HTTPS.
 *
 * @throws Error when the URL isn't absolute, or uses plain HTTP for a host other than loopback.
 */
export function marketUrl(input) {
    const value = input.trim() || MARKET_URL;
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new Error('api-url must be an absolute URL');
    }
    // Plain HTTP is allowed only for local test servers; the action sends a Bearer token.
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopbackHosts.has(url.hostname))) {
        throw new Error('api-url must use https');
    }
    return value.replace(/\/+$/, '');
}

/** Fetches a Market URL with a 30-second timeout. */
export function marketFetch(url, options = {}) {
    return fetch(url, { ...options, signal: AbortSignal.timeout(30_000) });
}

/**
 * Resolves a numeric database ID or public ID to its listing.
 *
 * @returns The listing, or undefined when Market answers 404.
 * @throws Error on any other failed response or when the response isn't a valid listing.
 */
export async function findListingById(baseUrl, id) {
    const response = await marketFetch(`${baseUrl}/api/v1/rest/plugins/${encodeURIComponent(id)}`);
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Could not look up Market plugin ${JSON.stringify(id)} (${response.status})`);
    let listing;
    try {
        listing = await readBoundedJson(response);
    } catch (error) {
        if (error instanceof RangeError) throw error;
        throw new Error('Market plugin lookup response was not valid JSON');
    }
    if (!isValidListing(listing)) throw new Error('Market plugin lookup response was not a valid listing');
    return listing;
}

/**
 * Finds a listing by an exact, case-insensitive name match in Market search results. Market has no
 * direct lookup by name: `GET /plugins/{name}` answers 404 for listings that exist. Search is fuzzy,
 * so the exact name can rank below other results; this reads up to 10 pages of 20 results.
 *
 * @param secret - Token to redact from a failed search response.
 * @returns The listing, or undefined when no listing has that name.
 * @throws Error when the search fails, a match isn't a valid listing, the name is ambiguous, or the
 * results run past the page limit without an exact match.
 */
export async function findListingByName(baseUrl, name, secret) {
    const matches = new Map();
    for (let page = 1; page <= maxSearchPages; page++) {
        const listings = await searchPage(baseUrl, name, page, secret);
        for (const listing of listings.filter((candidate) => isExactName(candidate, name))) {
            if (!isValidListing(listing)) throw new Error('Market plugin lookup response was not a valid listing');
            matches.set(listing.id, listing);
        }
        if (listings.length < searchPageSize) break;
        if (page === maxSearchPages && !matches.size) {
            throw new Error(
                `Market search for ${JSON.stringify(name)} returned more than ${maxSearchPages * searchPageSize} results without an exact match; use plugin-id instead`,
            );
        }
    }
    if (matches.size > 1) throw new Error(`Market has multiple listings named ${JSON.stringify(name)}`);
    return matches.values().next().value;
}

async function searchPage(baseUrl, name, page, secret) {
    const searchUrl = new URL(`${baseUrl}/api/v1/rest/plugins`);
    searchUrl.searchParams.set('q', name);
    searchUrl.searchParams.set('limit', String(searchPageSize));
    searchUrl.searchParams.set('page', String(page));
    const response = await marketFetch(searchUrl);
    if (!response.ok)
        throw new Error(
            `Could not search Market plugins (${response.status}): ${await safeResponseBody(response, secret)}`,
        );
    const listings = await readBoundedJson(response);
    if (!Array.isArray(listings)) throw new Error('Market plugin search response was not an array');
    return listings;
}

// A listing without a published version has `version` null, an empty string or no field at all.
function isValidListing(listing) {
    return (
        Number.isInteger(listing?.id) &&
        typeof listing.name === 'string' &&
        Boolean(listing.name) &&
        (listing.version === undefined || listing.version === null || typeof listing.version === 'string')
    );
}

function isExactName(listing, name) {
    return typeof listing?.name === 'string' && listing.name.toLowerCase() === name.toLowerCase();
}
