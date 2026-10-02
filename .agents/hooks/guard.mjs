// Decides whether an agent's tool call should be refused, and says what to do instead. Pure functions:
// the adapters (see opencode.mjs) pass in the tool input and a way to read files.

/** Matches the start of a command: the beginning of the line or after `&&`, `||`, `;`, `|` or `(`. */
const AT_COMMAND = String.raw`(?:^|&&|\|\||[;|(]|\n)\s*`;

const SHELL_RULES = [
    {
        pattern: new RegExp(
            `${AT_COMMAND}(?:npm\\s+(?:install|i|ci|add|uninstall|remove|rm|update|up|run|run-script|exec|test|start|link)\\b|npx\\s|yarn\\b|bunx\\s|bun\\s+(?:install|add|remove|x|run)\\b)`
        ),
        reason: 'This repo uses pnpm. Use `pnpm add`, `pnpm exec <bin>` for local binaries or `pnpm dlx <pkg>` instead.'
    },
    {
        pattern: /\bgit\b[^\n;&|]*\s--no-verify\b/,
        reason: 'Do not skip git hooks with --no-verify. Fix what the hook reports instead.'
    },
    {
        pattern: /\bgit\s+push\b[^\n;&|]*\s(?:--force(?:-with-lease)?(?:=\S*)?|-f)(?:\s|$)/,
        reason: 'Never force-push. If history really has to be rewritten, ask the user to push it themselves.'
    }
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
        reason: 'pnpm writes the lockfile. Change dependencies with `pnpm add`, `pnpm remove` or `pnpm install`.'
    },
    {
        pattern: /^(packages\/[^/]+\/build|dist|\.cache|\.turbo)\/|(^|\/)(node_modules|\.turbo)\//,
        reason: 'This is build output or a cache. Change the source and rebuild instead.'
    },
    {
        pattern: /^packages\/[^/]+\/CHANGELOG\.md$|^\.release-please-manifest\.json$/,
        reason: 'release-please owns this file. New plugins are registered by `pnpm gen`.'
    }
];

const BLOCK = /<!-- docs:begin ([\w-]+) -->[\s\S]*?<!-- docs:end \1 -->/g;

/** The generated blocks of a README, as `[start, end)` ranges with their text. */
function generatedBlocks(text) {
    return [...text.matchAll(BLOCK)].map((m) => ({ start: m.index, end: m.index + m[0].length, text: m[0] }));
}

const GENERATED_README =
    'This is a generated block of a README. Edit its source instead (a plugin README comes from `src/info.ts`, the package tables from each `package.json`), then run `pnpm readme`.';

/**
 * Why a change to `file` must not be made, or undefined when it may.
 *
 * @param {string} file Path relative to the repo root, with forward slashes.
 * @param {{ oldString?: string, content?: string }} change The text being replaced (edits) or the
 *   new file content (writes). Patches pass neither, so only the path rules apply to them.
 * @param {(file: string) => string | undefined} read Current content of a repo file, if it exists.
 * @returns {string | undefined}
 */
export function checkEdit(file, change, read) {
    const rule = PROTECTED_PATHS.find((r) => r.pattern.test(file));
    if (rule) return rule.reason;
    if (!/(^|\/)README\.md$/.test(file)) return;

    const current = read(file);
    if (current === undefined) return;
    const blocks = generatedBlocks(current);
    if (blocks.length === 0) return;

    if (change.oldString !== undefined) {
        let from = current.indexOf(change.oldString);
        while (from !== -1) {
            const to = from + change.oldString.length;
            if (blocks.some((b) => from < b.end && to > b.start)) return GENERATED_README;
            from = current.indexOf(change.oldString, from + 1);
        }
        return;
    }
    if (change.content !== undefined) {
        const next = generatedBlocks(change.content).map((b) => b.text);
        if (next.length !== blocks.length || blocks.some((b, i) => b.text !== next[i])) return GENERATED_README;
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
        (m[1] ?? '').trim()
    );
}
