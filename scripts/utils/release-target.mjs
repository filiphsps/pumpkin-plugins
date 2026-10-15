const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/;

/**
 * Resolves the commit a release run is allowed to publish.
 *
 * @param {object} options - GitHub event and requested release target.
 * @param {string} options.eventName - Event that started the workflow.
 * @param {string} options.workflowSha - Commit checked out by the workflow run.
 * @param {string | undefined} options.requestedSha - Explicit target supplied by the caller.
 * @param {boolean} [options.toolOnly] - Whether this is a manual npm recovery run.
 * @returns {string} The exact commit whose releases may be published.
 * @throws {Error} When the workflow or requested target is not a full commit SHA or the event is invalid.
 */
export function resolveReleaseTargetSha({ eventName, workflowSha, requestedSha, toolOnly = false }) {
    if (!FULL_COMMIT_SHA.test(workflowSha ?? '')) {
        throw new Error('Release workflow must provide a full 40-character workflow commit SHA');
    }

    if (toolOnly) {
        if (eventName !== 'workflow_dispatch') {
            throw new Error('Tool-only release recovery is only available via workflow_dispatch');
        }
        if (!FULL_COMMIT_SHA.test(requestedSha ?? '')) {
            throw new Error('Tool-only release recovery requires a full 40-character release commit SHA');
        }
        return requestedSha;
    }

    if (requestedSha && requestedSha !== workflowSha) {
        throw new Error('Release target must match the workflow commit');
    }
    return workflowSha;
}
