#!/usr/bin/env node
// Adapts Codex lifecycle hooks to the repository's client-neutral protocol.
import * as path from 'node:path';
import { handle } from './run.mjs';
import { completionIdentity, hookScope } from './scope.mjs';

const MAX_FAILURE_REPORT_LENGTH = 6000;

/** Convert a Codex tool name to the portable runner's aliases. Codex sends every file edit as `apply_patch`. */
function portableTool(name) {
    return name === 'Bash' ? 'bash' : name;
}

/** Return a Codex response that blocks a tool call with a visible reason. */
function deny(reason) {
    return {
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
        },
    };
}

/** Describe a check failure in the continuation or visible final hook response. */
function checkFailure(report, retrying) {
    const details = conciseReport(report || 'The repository hook returned no check report.');
    if (retrying) {
        return {
            continue: false,
            systemMessage: `Turn-scoped checks still fail after one continuation attempt. Preserve unrelated changes; report any failure that cannot be fixed within this turn’s changes.\n\n${details}`,
        };
    }
    return {
        decision: 'block',
        reason: `Turn-scoped repository checks failed. Fix failures tied to this turn’s changed files; if a failure is pre-existing, environment-specific, or unrelated, report it without editing unrelated files.\n\n${details}`,
    };
}

/** Keep continuation feedback focused while retaining the first diagnostics. */
function conciseReport(report) {
    if (report.length <= MAX_FAILURE_REPORT_LENGTH) return report;

    const suffix = '\n\n… report truncated; rerun the listed command for full output.';
    return `${report.slice(0, MAX_FAILURE_REPORT_LENGTH - suffix.length).trimEnd()}${suffix}`;
}

/**
 * Adapt a Codex hook request to the repository's portable before-tool and check events.
 *
 * @param {object} request Codex's lifecycle event payload.
 * @param {(request: object) => Promise<object>} runner The portable hook request handler.
 * @returns {Promise<object | null>} A Codex hook response, or null when no response is needed.
 */
export async function handleCodexHook(request, runner = handle, scope = hookScope) {
    if (request?.hook_event_name === 'PreToolUse') {
        if (typeof request.tool_name !== 'string') return deny('Codex did not provide a tool name.');

        try {
            const originalInput = request.tool_input ?? {};
            const result = await runner({
                event: 'before-tool',
                tool: portableTool(request.tool_name),
                input: originalInput,
                cwd: request.cwd,
            });
            if (result?.ok !== true)
                return deny(result?.reason ?? result?.error ?? 'The repository hook refused this tool call.');

            await scope.beforeTool?.(request);

            if (Object.hasOwn(result, 'input') && JSON.stringify(result.input) !== JSON.stringify(originalInput)) {
                return {
                    hookSpecificOutput: {
                        hookEventName: 'PreToolUse',
                        permissionDecision: 'allow',
                        updatedInput: result.input,
                    },
                };
            }
            return null;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return deny(`The repository hook failed and blocked this tool call: ${message}`);
        }
    }

    if (request?.hook_event_name === 'PostToolUse') {
        try {
            await scope.afterTool?.(request);
            return null;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { systemMessage: `Could not record this tool call for scoped repository checks: ${message}` };
        }
    }

    if (request?.hook_event_name === 'Stop' || request?.hook_event_name === 'SubagentStop') {
        const retrying = request.stop_hook_active === true;
        if (typeof request.session_id !== 'string' || typeof request.turn_id !== 'string') {
            return checkFailure(
                'Codex did not provide session_id and turn_id; repository checks cannot be scoped safely.',
                retrying,
            );
        }
        try {
            const files = await scope.files(request.session_id, request.turn_id, {
                retrying,
                identity: completionIdentity(request),
            });
            const result = await runner({ event: 'check', cwd: request.cwd, files });
            await scope.finish?.(request, files, result?.ok === true);
            if (result?.ok === true) return { continue: true };
            return checkFailure(result?.report ?? result?.error, retrying);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return checkFailure(`The repository hook failed: ${message}`, retrying);
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
