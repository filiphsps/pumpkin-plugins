import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';

const markdownEscapeCharacters = new Set('\\`*_{}[]()#+-.!|~');

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

/** Appends Markdown to the GitHub step summary when running under the Actions runner. */
export function appendSummary(content) {
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${content}\n`);
}

/** Escapes values so percent signs and line breaks cannot add GitHub workflow commands. */
export function escapeWorkflowCommand(value) {
    return value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

/** Escapes plain text for safe inclusion in a GitHub step-summary Markdown document. */
export function escapeMarkdownText(value) {
    return [...value.replaceAll('\r', ' ').replaceAll('\n', ' ').replaceAll('&', '&amp;')]
        .map((character) => {
            if (character === '<') return '&lt;';
            if (character === '>') return '&gt;';
            return markdownEscapeCharacters.has(character) ? `\\${character}` : character;
        })
        .join('');
}
