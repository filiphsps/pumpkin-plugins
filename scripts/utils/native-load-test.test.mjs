import assert from 'node:assert/strict';
import { it } from 'node:test';
import { hasPassingVitestSummary } from './native-load-test.mjs';

it('accepts a successful Vitest summary with terminal color escapes', () => {
    const output = `
\u001b[2m Test Files \u001b[22m \u001b[1m\u001b[32m2 passed\u001b[39m\u001b[90m (2)\u001b[39m
\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[32m6 passed\u001b[39m\u001b[90m (6)\u001b[39m
`;

    assert.equal(hasPassingVitestSummary(output), true);
});

it('rejects missing, incomplete, or failing Vitest summaries', () => {
    assert.equal(hasPassingVitestSummary(''), false);
    assert.equal(hasPassingVitestSummary('Test Files 2 passed (2)'), false);
    assert.equal(hasPassingVitestSummary('Test Files 2 passed (2)\nTests 5 passed, 1 failed (6)'), false);
});
