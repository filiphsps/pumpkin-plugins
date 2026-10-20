import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { ROOT } from './check.mjs';
import { handleCodexHook } from './codex.mjs';
import { HookScope } from './scope.mjs';

const temporaryDirectories = [];

/** A HookScope in its own temp directory, so tests never share a live session's checkpoints. */
function temporaryScope(snapshot = () => new Map()) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pumpkin-codex-hook-test-'));
    temporaryDirectories.push(directory);
    return new HookScope({ directory, snapshot });
}

after(() => {
    for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
});

describe('Codex hook adapter', () => {
    it('maps a blocked Codex shell call to a Codex deny decision', async () => {
        const result = await handleCodexHook({
            hook_event_name: 'PreToolUse',
            tool_name: 'Bash',
            tool_input: { command: 'npm install package' },
        });

        assert.equal(result.hookSpecificOutput.hookEventName, 'PreToolUse');
        assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
        assert.match(result.hookSpecificOutput.permissionDecisionReason, /pnpm/);
    });

    it('returns the portable runner’s rewritten command to Codex', async () => {
        const result = await handleCodexHook({
            hook_event_name: 'PreToolUse',
            tool_name: 'Bash',
            tool_input: { command: 'pnpm test', description: 'Run tests' },
        });

        assert.deepEqual(result.hookSpecificOutput, {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            updatedInput: { command: 'pnpm test --output-logs=errors-only', description: 'Run tests' },
        });
    });

    it('blocks a failed completion check once, then stops retrying', async () => {
        const report = '### Repo checks failed: `pnpm check`\n\nmissing link';
        const runner = async () => ({ ok: false, report });
        const scope = temporaryScope();
        const request = {
            hook_event_name: 'Stop',
            session_id: 'session-1',
            turn_id: 'turn-1',
            stop_hook_active: false,
        };
        const first = await handleCodexHook(request, runner, scope);
        const retry = await handleCodexHook({ ...request, stop_hook_active: true }, runner, scope);

        assert.equal(first.decision, 'block');
        assert.ok(first.reason.includes(report));
        assert.equal(retry.continue, false);
        assert.equal(retry.decision, undefined);
        assert.ok(retry.systemMessage.includes(report));
    });

    it('caps the failure report included in a continuation prompt', async () => {
        const report = `### Test failed: first diagnostic\n\n${'x'.repeat(9000)}`;
        const result = await handleCodexHook(
            { hook_event_name: 'Stop', session_id: 'session-1', turn_id: 'turn-1' },
            async () => ({ ok: false, report }),
            temporaryScope(),
        );

        assert.match(result.reason, /first diagnostic/);
        assert.match(result.reason, /report truncated/);
        assert.ok(result.reason.length < 7000);
    });

    it('allows a clean completion check to finish', async () => {
        const result = await handleCodexHook(
            { hook_event_name: 'Stop', session_id: 'session-1', turn_id: 'turn-1' },
            async () => ({ ok: true }),
            temporaryScope(),
        );

        assert.deepEqual(result, { continue: true });
    });

    it('checks only files touched by the current turn', async () => {
        let checkRequest;
        const scope = {
            files: async (sessionId, turnId) => {
                assert.equal(sessionId, 'session-1');
                assert.equal(turnId, 'turn-1');
                return ['packages/p/src/current.ts'];
            },
        };

        await handleCodexHook(
            { hook_event_name: 'Stop', session_id: 'session-1', turn_id: 'turn-1' },
            async (request) => {
                checkRequest = request;
                return { ok: true };
            },
            scope,
        );

        assert.deepEqual(checkRequest, {
            event: 'check',
            cwd: undefined,
            files: ['packages/p/src/current.ts'],
        });
    });

    it('tracks successful file-writing tool calls for their own turn', async () => {
        let recorded;
        const request = {
            hook_event_name: 'PostToolUse',
            session_id: 'session-1',
            turn_id: 'turn-1',
            tool_name: 'apply_patch',
            tool_input: { command: '*** Begin Patch\n*** Update File: packages/p/src/current.ts\n*** End Patch' },
        };

        const result = await handleCodexHook(request, async () => ({ ok: true }), {
            afterTool: async (toolRequest) => {
                recorded = toolRequest;
            },
        });

        assert.equal(result, null);
        assert.equal(recorded, request);
    });

    it('checks subagent work at the subagent completion boundary', async () => {
        let checkRequest;

        const result = await handleCodexHook(
            {
                hook_event_name: 'SubagentStop',
                session_id: 'session-1',
                turn_id: 'agent-turn',
                stop_hook_active: false,
            },
            async (request) => {
                checkRequest = request;
                return { ok: true };
            },
            { files: async () => ['tools/config/src/load.ts'] },
        );

        assert.deepEqual(checkRequest, {
            event: 'check',
            cwd: undefined,
            files: ['tools/config/src/load.ts'],
        });
        assert.deepEqual(result, { continue: true });
    });

    it('does not run an unscoped check when Codex omits turn identifiers', async () => {
        let ran = false;
        const result = await handleCodexHook(
            { hook_event_name: 'Stop' },
            async () => {
                ran = true;
                return { ok: true };
            },
            temporaryScope(),
        );

        assert.equal(ran, false);
        assert.equal(result.decision, 'block');
        assert.match(result.reason, /session_id and turn_id/);
    });

    it('fails closed when the portable before-tool runner errors', async () => {
        const result = await handleCodexHook(
            { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'pnpm test' } },
            async () => {
                throw new Error('runner unavailable');
            },
        );

        assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
        assert.match(result.hookSpecificOutput.permissionDecisionReason, /runner unavailable/);
    });

    it('guards and records a Codex apply_patch call end to end', async () => {
        // Codex sends every file edit as apply_patch, with the patch in tool_input.command.
        const payload = (file, extra) => ({
            session_id: 'session-1',
            turn_id: 'turn-1',
            transcript_path: null,
            cwd: path.join(ROOT, 'packages/p'),
            model: 'gpt-5-codex',
            permission_mode: 'default',
            tool_name: 'apply_patch',
            tool_use_id: `call-${file}`,
            tool_input: { command: `*** Begin Patch\n*** Update File: ${file}\n@@\n-a\n+b\n*** End Patch\n` },
            ...extra,
        });
        let current = new Map();
        const scope = temporaryScope(() => new Map(current));

        const refused = await handleCodexHook(
            payload('../../pnpm-lock.yaml', { hook_event_name: 'PreToolUse' }),
            undefined,
            scope,
        );
        assert.equal(refused.hookSpecificOutput.permissionDecision, 'deny');
        assert.match(refused.hookSpecificOutput.permissionDecisionReason, /pnpm-lock\.yaml/);

        assert.equal(
            await handleCodexHook(payload('src/plugin.ts', { hook_event_name: 'PreToolUse' }), undefined, scope),
            null,
        );
        current = new Map([['packages/p/src/plugin.ts', 'patched']]);
        assert.equal(
            await handleCodexHook(payload('src/plugin.ts', { hook_event_name: 'PostToolUse' }), undefined, scope),
            null,
        );
        assert.deepEqual(scope.files('session-1', 'turn-1'), ['packages/p/src/plugin.ts']);
    });

    it('still guards shell calls before `pnpm install`, and asks for it when a guard needs it', () => {
        // A fresh clone has no node_modules, so workspace packages don't resolve yet.
        // The entry point compares its own resolved path, so resolve the macOS /var symlink.
        const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pumpkin-codex-fresh-clone-')));
        temporaryDirectories.push(repo);
        fs.cpSync(import.meta.dirname, path.join(repo, '.agents/hooks'), { recursive: true });
        fs.writeFileSync(path.join(repo, 'README.md'), '# Readme\n');
        const run = (request) => {
            const result = spawnSync(process.execPath, [path.join(repo, '.agents/hooks/codex.mjs')], {
                cwd: repo,
                input: JSON.stringify({ hook_event_name: 'PreToolUse', cwd: repo, ...request }),
                encoding: 'utf8',
            });
            assert.equal(result.status, 0, result.stderr);
            return JSON.parse(result.stdout).hookSpecificOutput;
        };

        const shell = run({ tool_name: 'Bash', tool_input: { command: 'pnpm test' } });
        assert.equal(shell.permissionDecision, 'allow');
        const patch = run({
            tool_name: 'apply_patch',
            tool_input: { command: '*** Begin Patch\n*** Update File: README.md\n*** End Patch\n' },
        });
        assert.equal(patch.permissionDecision, 'deny');
        assert.match(patch.permissionDecisionReason, /pnpm install/);
    });
});
