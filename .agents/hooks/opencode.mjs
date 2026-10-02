// OpenCode (V2) adapter for the hooks in this folder. Loaded by `plugins` in /opencode.jsonc.
//
// - Before a tool runs: refuses the shell commands and file edits guard.mjs rules out, and quiets
//   Turborepo output (output.mjs).
// - When the agent finishes a turn in which it edited files: runs check.mjs on those files and,
//   if something fails, sends the failures back to the session so the agent fixes them. It does this
//   at most MAX_ROUNDS times in a row before leaving the rest to the user.
//
// Formatting after edits is OpenCode's built-in Biome formatter, configured in /opencode.jsonc.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { formatFailures, planChecks, ROOT, runChecks } from './check.mjs';
import { checkEdit, checkShell, patchedFiles } from './guard.mjs';
import { quietTurbo } from './output.mjs';

const MARKER = '[pumpkin-plugins checks]';
const MAX_ROUNDS = 3;
const SHELL_TOOLS = new Set(['shell', 'bash']);
const EDIT_TOOLS = new Set(['edit', 'write', 'patch', 'apply_patch']);

function read(file) {
    try {
        return fs.readFileSync(path.join(ROOT, file), 'utf8');
    } catch {
        return undefined;
    }
}

/** The files an edit tool call touches, with what it replaces or writes. */
function targets(tool, input) {
    if (tool === 'patch' || tool === 'apply_patch') {
        return patchedFiles(String(input.patchText ?? input.patch ?? '')).map((file) => ({ file, change: {} }));
    }
    const file = input.path ?? input.filePath;
    if (typeof file !== 'string') return [];
    return [{ file, change: { oldString: input.oldString, content: tool === 'write' ? input.content : undefined } }];
}

export default {
    id: 'pumpkin-plugins.agent-hooks',
    async setup(ctx) {
        const base = ctx.location.directory;
        /** Path relative to the repo root, or undefined when it is outside the repo. */
        const inRepo = (file) => {
            const rel = path.relative(ROOT, path.resolve(base, file)).split(path.sep).join('/');
            return rel.startsWith('..') || path.isAbsolute(rel) ? undefined : rel;
        };

        /** Files edited since the last check, by top-level session (subagent edits count for their parent). */
        const dirty = new Map();
        /** Automated check prompts sent to a session since the user last wrote to it. */
        const rounds = new Map();
        const roots = new Map();
        const running = new Set();

        async function rootOf(sessionID) {
            const known = roots.get(sessionID);
            if (known) return known;
            let id = sessionID;
            for (let depth = 0; depth < 10; depth++) {
                const session = await ctx.session.get({ sessionID: id });
                if (!session.parentID) break;
                id = session.parentID;
            }
            roots.set(sessionID, id);
            return id;
        }

        await ctx.tool.hook('execute.before', (event) => {
            const input = event.input && typeof event.input === 'object' ? event.input : {};
            if (SHELL_TOOLS.has(event.tool) && typeof input.command === 'string') {
                const reason = checkShell(input.command);
                if (reason) throw new Error(reason);
                const quiet = quietTurbo(input.command);
                if (quiet !== input.command) event.input = { ...input, command: quiet };
                return;
            }
            if (!EDIT_TOOLS.has(event.tool)) return;
            for (const { file, change } of targets(event.tool, input)) {
                const rel = inRepo(file);
                const reason = rel && checkEdit(rel, change, read);
                if (reason) throw new Error(`${rel}: ${reason}`);
            }
        });

        await ctx.tool.hook('execute.after', async (event) => {
            if (event.status !== 'completed' || !EDIT_TOOLS.has(event.tool)) return;
            const input = event.input && typeof event.input === 'object' ? event.input : {};
            const files = targets(event.tool, input)
                .map((t) => inRepo(t.file))
                .filter(Boolean);
            if (files.length === 0) return;
            const root = await rootOf(event.sessionID).catch(() => event.sessionID);
            const set = dirty.get(root) ?? new Set();
            for (const file of files) set.add(file);
            dirty.set(root, set);
        });

        await ctx.session.hook('prompt', (event) => {
            if (!event.prompt.text?.startsWith(MARKER)) rounds.delete(event.sessionID);
        });

        const controller = new AbortController();

        async function finished(sessionID) {
            const files = dirty.get(sessionID);
            if (!files || files.size === 0 || running.has(sessionID)) return;
            if ((rounds.get(sessionID) ?? 0) >= MAX_ROUNDS) return;
            running.add(sessionID);
            dirty.delete(sessionID);
            try {
                const failures = await runChecks(planChecks([...files]), { signal: controller.signal });
                if (failures.length === 0 || controller.signal.aborted) return;
                // Check the same files again after the fix, along with whatever the fix touches.
                const again = dirty.get(sessionID) ?? new Set();
                for (const file of files) again.add(file);
                dirty.set(sessionID, again);
                const round = (rounds.get(sessionID) ?? 0) + 1;
                rounds.set(sessionID, round);
                await ctx.session.prompt({
                    sessionID,
                    delivery: 'queue',
                    text: [
                        `${MARKER} The checks for the files you changed failed (round ${round} of ${MAX_ROUNDS}).`,
                        'Fix the cause, not the check. If a failure is unrelated to your change, or needs a decision, stop and tell the user instead.',
                        '',
                        formatFailures(failures)
                    ].join('\n')
                });
            } finally {
                running.delete(sessionID);
            }
        }

        void (async () => {
            for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
                if (event.type !== 'session.execution.succeeded') continue;
                const sessionID = event.data?.sessionID;
                if (sessionID) finished(sessionID).catch((error) => console.error(`${MARKER} ${error}`));
            }
        })().catch((error) => {
            if (!controller.signal.aborted) console.error(`${MARKER} event stream ended: ${error}`);
        });

        return () => controller.abort();
    }
};
