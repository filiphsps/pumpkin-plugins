import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';

/** Reads a declared action input from GitHub's runner environment, preserving hyphens in its name. */
export function getInput(name) {
    // IMPORTANT: GitHub preserves hyphens, e.g. `plugin-name` becomes `INPUT_PLUGIN-NAME`.
    return process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] ?? '';
}

/** Writes an action output to GitHub's output file when running under the Actions runner. */
export function setOutput(name, value) {
    const outputFile = process.env.GITHUB_OUTPUT;
    if (!outputFile) return;

    const delimiter = `ghadelimiter_${randomUUID()}`; // cspell:disable-line
    fs.appendFileSync(outputFile, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}
