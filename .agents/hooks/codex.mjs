#!/usr/bin/env node
// Adapts Codex lifecycle hooks to the repository's client-neutral protocol.
import * as path from 'node:path';
import { handle } from './run.mjs';

/** Convert a Codex tool name to the portable runner's aliases. */
function portableTool(name) {
    if (name === 'Bash') return 'bash';
    if (name === 'Edit') return 'edit';
    if (name === 'Write') return 'write';
    return name;
}

/** Return a Codex response that blocks a tool call with a visible reason. */
function deny(reason) {
    return {
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason
        }
    };
}

/** Describe a check failure in the continuation or visible final hook response. */
function checkFailure(report, retrying) {
    const details = report || 'The repository hook returned no check report.';
    if (retrying) {
        return {
            continue: false,
            systemMessage: `Repository checks still fail after one continuation attempt. Preserve unrelated changes; resolve these failures or report why they remain.\n\n${details}`
        };
    }
    return {
        decision: 'block',
        reason: `Repository checks failed. Preserve unrelated changes and fix the reported failures before finishing.\n\n${details}`
    };
}

/**
 * Adapt a Codex hook request to the repository's portable before-tool and check events.
 *
 * @param {object} request Codex's lifecycle event payload.
 * @param {(request: object) => Promise<object>} runner The portable hook request handler.
 * @returns {Promise<object | null>} A Codex hook response, or null when no response is needed.
 */
export async function handleCodexHook(request, runner = handle) {
    if (request?.hook_event_name === 'PreToolUse') {
        if (typeof request.tool_name !== 'string') return deny('Codex did not provide a tool name.');

        try {
            const originalInput = request.tool_input ?? {};
            const result = await runner({
                event: 'before-tool',
                tool: portableTool(request.tool_name),
                input: originalInput,
                cwd: request.cwd
            });
            if (result?.ok !== true)
                return deny(result?.reason ?? result?.error ?? 'The repository hook refused this tool call.');

            if (Object.hasOwn(result, 'input') && JSON.stringify(result.input) !== JSON.stringify(originalInput)) {
                return {
                    hookSpecificOutput: {
                        hookEventName: 'PreToolUse',
                        permissionDecision: 'allow',
                        updatedInput: result.input
                    }
                };
            }
            return null;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return deny(`The repository hook failed and blocked this tool call: ${message}`);
        }
    }

    if (request?.hook_event_name === 'Stop') {
        try {
            const result = await runner({ event: 'check', cwd: request.cwd });
            if (result?.ok === true) return { continue: true };
            return checkFailure(result?.report ?? result?.error, request.stop_hook_active === true);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return checkFailure(`The repository hook failed: ${message}`, request.stop_hook_active === true);
        }
    }

    return { systemMessage: `Unsupported Codex hook event: ${request?.hook_event_name ?? 'unknown'}` };
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;

    let request;
    try {
        request = JSON.parse(input);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(JSON.stringify({ decision: 'block', reason: `Codex hook input was invalid: ${message}` }));
        process.exitCode = 0;
    }

    if (request !== undefined) {
        const response = await handleCodexHook(request);
        if (response !== null) console.log(JSON.stringify(response));
    }
}
