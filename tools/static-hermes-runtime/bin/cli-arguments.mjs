/** Parse a present JSON string-array argument and remove duplicate entries. */
export function parseJsonStringArray(json, argument, itemDescription) {
    if (json === undefined) return undefined;

    let parsed;
    try {
        parsed = JSON.parse(json);
    } catch (error) {
        throw new Error(`--${argument} must be a JSON array (${error.message})`);
    }
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) {
        throw new Error(`--${argument} must be a JSON array of ${itemDescription}`);
    }
    return [...new Set(parsed)];
}
