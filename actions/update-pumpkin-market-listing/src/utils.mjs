/** Reads a declared action input from GitHub's runner environment, preserving hyphens in its name. */
export function getInput(name) {
    // IMPORTANT: GitHub preserves hyphens, e.g. `plugin-name` becomes `INPUT_PLUGIN-NAME`.
    return process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] ?? '';
}
