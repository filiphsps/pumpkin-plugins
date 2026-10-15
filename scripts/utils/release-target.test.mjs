import assert from 'node:assert/strict';
import { it } from 'node:test';
import { resolveReleaseTargetSha } from './release-target.mjs';

const workflowSha = 'a'.repeat(40);
const releaseSha = 'b'.repeat(40);

it('keeps an ordinary release bound to the workflow commit', () => {
    assert.equal(
        resolveReleaseTargetSha({
            eventName: 'push',
            workflowSha,
            requestedSha: workflowSha,
        }),
        workflowSha,
    );
});

it('uses only the requested release commit for a manual recovery run', () => {
    assert.equal(
        resolveReleaseTargetSha({
            eventName: 'workflow_dispatch',
            workflowSha,
            requestedSha: releaseSha,
            toolOnly: true,
        }),
        releaseSha,
    );
});

it('does not allow an ordinary release run to target another commit', () => {
    assert.throws(
        () =>
            resolveReleaseTargetSha({
                eventName: 'push',
                workflowSha,
                requestedSha: releaseSha,
            }),
        /must match the workflow commit/,
    );
});

it('requires manual tool recovery to use workflow_dispatch and a full commit SHA', () => {
    assert.throws(
        () =>
            resolveReleaseTargetSha({
                eventName: 'push',
                workflowSha,
                requestedSha: releaseSha,
                toolOnly: true,
            }),
        /only available via workflow_dispatch/,
    );
    assert.throws(
        () =>
            resolveReleaseTargetSha({
                eventName: 'workflow_dispatch',
                workflowSha,
                requestedSha: 'master',
                toolOnly: true,
            }),
        /requires a full 40-character release commit SHA/,
    );
});
