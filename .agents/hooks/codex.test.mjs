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
        const request = { hook_event_name: 'Stop', stop_hook_active: false };
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
        const result = await handleCodexHook({ hook_event_name: 'Stop' }, async () => ({ ok: true }));

        assert.deepEqual(result, { continue: true });
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
