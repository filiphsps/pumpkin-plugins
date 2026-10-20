const API_VERSION = '2022-11-28';

/** Returns a trimmed non-empty string or throws an error naming the missing value. */
export function requireString(value, description) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${description} is required`);
    return value.trim();
}

/** Validates an `owner/name` repository and encodes both parts for an API path. */
export function encodeRepository(value) {
    const parts = requireString(value, 'GitHub repository').split('/');
    if (parts.length !== 2 || parts.some((part) => !part)) {
        throw new Error(`Invalid GitHub repository: ${value}`);
    }
    return parts.map(encodeURIComponent).join('/');
}

/** Encodes each segment of a slash-separated file path or ref name for an API path. */
export function encodePath(value) {
    return value.split('/').map(encodeURIComponent).join('/');
}

/** Parses an HTTPS base URL and adds a trailing slash so relative API paths resolve under it. */
export function normalizeBaseUrl(value, description) {
    let url;
    try {
        url = new URL(requireString(value, description));
    } catch {
        throw new Error(`${description} must be a valid URL`);
    }
    if (url.protocol !== 'https:') throw new Error(`${description} must use HTTPS`);
    return new URL(url.href.endsWith('/') ? url.href : `${url.href}/`);
}

/** Builds the REST API request headers for a token. */
export function apiHeaders(token) {
    return {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${requireString(token, 'GitHub App token')}`,
        'X-GitHub-Api-Version': API_VERSION,
    };
}

/** Sends a request and returns its JSON body, or throws with the status and the start of the body. */
export async function requestJson(fetchImpl, url, options, description) {
    return readJsonResponse(await fetchImpl(url, options), description);
}

/** Returns the JSON body of a successful response, or throws with the status and the start of the body. */
export async function readJsonResponse(response, description) {
    if (!response.ok) {
        const body = await response.text();
        const detail = body ? `: ${body.slice(0, 500)}` : '';
        throw new Error(`${description} failed with HTTP ${response.status}${detail}`);
    }
    try {
        return await response.json();
    } catch {
        throw new Error(`${description} returned invalid JSON`);
    }
}
