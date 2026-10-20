// Decides whether an agent's tool call should be refused, and says what to do instead. Pure functions:
// run.mjs passes in the normalized tool input and a way to read files.

import { isGeneratedPath } from './check.mjs';

/** Matches the start of a command: the beginning of the line or after `&&`, `||`, `;`, `|` or `(`. */
const AT_COMMAND = String.raw`(?:^|&&|\|\||[;|(]|\n)\s*`;

const SHELL_RULES = [
    {
        pattern: new RegExp(
            `${AT_COMMAND}(?:npm\\s+(?:install|i|ci|add|uninstall|remove|rm|update|up|run|run-script|exec|test|start|link)\\b|npx\\s|yarn\\b|bunx\\s|bun\\s+(?:install|add|remove|x|run)\\b)`,
        ),
        reason: 'This repo uses pnpm. Use `pnpm add`, `pnpm exec <bin>` for local binaries or `pnpm dlx <pkg>` instead.',
    },
];

/**
 * Why a shell command must not run, or undefined when it may.
 *
 * @param {string} command The command line as the agent wrote it.
 * @returns {string | undefined}
 */
export function checkShell(command) {
    return SHELL_RULES.find((rule) => rule.pattern.test(command))?.reason;
}

const PROTECTED_PATHS = [
    {
        pattern: /(^|\/)pnpm-lock\.yaml$/,
        reason: 'pnpm writes the lockfile. Change dependencies with `pnpm add`, `pnpm remove` or `pnpm install`.',
    },
    {
        pattern: /(^|\/)CHANGELOG\.md$|^\.release-please-manifest\.json$/,
        reason: 'release-please owns this file. New plugins are registered by `pnpm gen`.',
    },
];

const GENERATED_DOCUMENT =
    'This is a generated documentation block. Edit its source instead (a plugin README comes from `src/info.ts`, the package tables from each `package.json`), then run `pnpm readme`.';

/** Load the Markdown block reader only when needed, so the other guards work before `pnpm install`. */
async function loadGeneratedBlocks() {
    try {
        return (await import('@pumpkin-plugins/docs/markdown')).generatedBlocks;
    } catch (error) {
        if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
        throw new Error(`Run \`pnpm install\`: the Markdown guard needs workspace packages. ${error.message}`);
    }
}

/**
 * Why a change to `file` must not be made, or undefined when it may.
 *
 * @param {string} file Path relative to the repo root, with forward slashes.
 * @param {{ oldString?: string, content?: string }} change The text being replaced (edits) or the
 *   new file content (writes). Patches pass neither, so generated Markdown blocks cannot be safely
 *   inspected and the whole document is refused when it contains one.
 * @param {(file: string) => string | undefined} read Current content of a repo file, if it exists.
 * @returns {Promise<string | undefined>}
 */
export async function checkEdit(file, change, read) {
    if (isGeneratedPath(file)) return 'This is build output or a cache. Change the source and rebuild instead.';
    const rule = PROTECTED_PATHS.find((r) => r.pattern.test(file));
    if (rule) return rule.reason;
    if (!/\.md$/i.test(file)) return;

    const current = read(file);
    if (current === undefined) return;
    const generatedBlocks = await loadGeneratedBlocks();
    const blocks = generatedBlocks(current);
    if (blocks.length === 0) return;

    if (change.oldString === undefined && change.content === undefined) return GENERATED_DOCUMENT;

    if (change.oldString !== undefined) {
        let from = current.indexOf(change.oldString);
        while (from !== -1) {
            const to = from + change.oldString.length;
            if (blocks.some((b) => from < b.end && to > b.start)) return GENERATED_DOCUMENT;
            from = current.indexOf(change.oldString, from + 1);
        }
        return;
    }
    if (change.content !== undefined) {
        const next = generatedBlocks(change.content).map((b) => b.text);
        if (next.length !== blocks.length || blocks.some((b, i) => b.text !== next[i])) return GENERATED_DOCUMENT;
    }
}

/**
 * The files a patch touches, from its `*** Add File:`, `*** Update File:`, `*** Delete File:` and
 * `*** Move to:` lines.
 *
 * @param {string} patch
 * @returns {string[]}
 */
export function patchedFiles(patch) {
    return [...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map((m) =>
        (m[1] ?? '').trim(),
    );
}
