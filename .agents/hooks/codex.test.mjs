import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handleCodexHook } from './codex.mjs';

describe('Codex hook adapter', () => {
    it('maps a blocked Codex shell call to a Codex deny decision', async () => {
        const result = await handleCodexHook({
            hook_event_name: 'PreToolUse',
            tool_name: 'Bash',
            tool_input: { command: 'npm install package' }
        });

        assert.equal(result.hookSpecificOutput.hookEventName, 'PreToolUse');
        assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
        assert.match(result.hookSpecificOutput.permissionDecisionReason, /pnpm/);
    });

    it('returns the portable runner’s rewritten command to Codex', async () => {
        const result = await handleCodexHook({
            hook_event_name: 'PreToolUse',
            tool_name: 'Bash',
            tool_input: { command: 'pnpm test', description: 'Run tests' }
        });

        assert.deepEqual(result.hookSpecificOutput, {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            updatedInput: { command: 'pnpm test --output-logs=errors-only', description: 'Run tests' }
        });
    });

    it('blocks a failed completion check once, then stops retrying', async () => {
        const runner = async () => ({ ok: false, report: '### Repo checks failed: `pnpm check`\n\nmissing link' });
        const request = {
            hook_event_name: 'Stop',
            session_id: 'session-1',
            turn_id: 'turn-1',
            stop_hook_active: false
        };
        const first = await handleCodexHook(request, runner);
        const retry = await handleCodexHook({ ...request, stop_hook_active: true }, runner);

        assert.deepEqual(first, {
            decision: 'block',
            reason: 'Repository checks failed. Preserve unrelated changes and fix the reported failures before finishing.\n\n### Repo checks failed: `pnpm check`\n\nmissing link'
        });
        assert.deepEqual(retry, {
            continue: false,
            systemMessage:
                'Repository checks still fail after one continuation attempt. Preserve unrelated changes; resolve these failures or report why they remain.\n\n### Repo checks failed: `pnpm check`\n\nmissing link'
        });
    });

    it('allows a clean completion check to finish', async () => {
        const result = await handleCodexHook(
            { hook_event_name: 'Stop', session_id: 'session-1', turn_id: 'turn-1' },
            async () => ({ ok: true })
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
            }
        };

        await handleCodexHook(
            { hook_event_name: 'Stop', session_id: 'session-1', turn_id: 'turn-1' },
            async (request) => {
                checkRequest = request;
                return { ok: true };
            },
            scope
        );

        assert.deepEqual(checkRequest, {
            event: 'check',
            cwd: undefined,
            files: ['packages/p/src/current.ts']
        });
    });

    it('tracks successful file-writing tool calls for their own turn', async () => {
        let recorded;
        const request = {
            hook_event_name: 'PostToolUse',
            session_id: 'session-1',
            turn_id: 'turn-1',
            tool_name: 'apply_patch',
            tool_input: { command: '*** Begin Patch\n*** Update File: packages/p/src/current.ts\n*** End Patch' }
        };

        const result = await handleCodexHook(request, async () => ({ ok: true }), {
            afterTool: async (toolRequest) => {
                recorded = toolRequest;
            }
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
                stop_hook_active: false
            },
            async (request) => {
                checkRequest = request;
                return { ok: true };
            },
            { files: async () => ['tools/config/src/load.ts'] }
        );

        assert.deepEqual(checkRequest, {
            event: 'check',
            cwd: undefined,
            files: ['tools/config/src/load.ts']
        });
        assert.deepEqual(result, { continue: true });
    });

    it('does not run an unscoped check when Codex omits turn identifiers', async () => {
        let ran = false;
        const result = await handleCodexHook({ hook_event_name: 'Stop' }, async () => {
            ran = true;
            return { ok: true };
        });

        assert.equal(ran, false);
        assert.deepEqual(result, {
            decision: 'block',
            reason: 'Repository checks failed. Preserve unrelated changes and fix the reported failures before finishing.\n\nCodex did not provide session_id and turn_id; repository checks cannot be scoped safely.'
        });
    });

    it('fails closed when the portable before-tool runner errors', async () => {
        const result = await handleCodexHook(
            { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'pnpm test' } },
            async () => {
                throw new Error('runner unavailable');
            }
        );

        assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
        assert.match(result.hookSpecificOutput.permissionDecisionReason, /runner unavailable/);
    });
});
