// Feeds issue bodies rendered from the real templates into the intake rules.
// Run with `node --test .github/scripts/*.test.mjs`.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inspectIssueSubmission } from './issue-form-rules.mjs';
import { loadIssueFormPolicies, loadIssueForms } from './issue-forms.mjs';

const forms = await loadIssueForms();
const policies = await loadIssueFormPolicies();

/**
 * Renders an issue body the way GitHub does for a submitted form: one `### label` section per
 * field, with `_No response_` for fields left empty.
 */
function renderBody(formId, answers = {}, lineEnding = '\n') {
    const form = forms.find((entry) => entry.id === formId);
    return form.definition.body
        .filter((field) => field.type !== 'markdown')
        .map((field) => {
            const fallback = field.validations?.required ? `Answer for ${field.attributes.label}` : '';
            const value = answers[field.id] ?? fallback;
            return `### ${field.attributes.label}${lineEnding}${lineEnding}${value || '_No response_'}`;
        })
        .join(`${lineEnding}${lineEnding}`);
}

function inspect(body, labels = [], preferredFormId = undefined) {
    const { form, missingFields } = inspectIssueSubmission(policies, body, labels, preferredFormId);
    return { formId: form?.id, missingFields };
}

describe('issue intake rules', () => {
    it('accepts every complete form, also with CRLF line endings', () => {
        assert.ok(forms.length > 0);
        for (const { id } of forms) {
            assert.deepEqual(inspect(renderBody(id)), { formId: id, missingFields: [] });
            assert.deepEqual(inspect(renderBody(id, {}, '\r\n')), { formId: id, missingFields: [] });
        }
    });

    it('reports a required section answered with the _No response_ placeholder', () => {
        const result = inspect(renderBody('bug-report', { 'expected-behavior': '_No response_' }));
        assert.deepEqual(result, { formId: 'bug-report', missingFields: ['What did you expect to happen?'] });
    });

    it('ignores section headings inside code fences', () => {
        const steps = ['```text', '### What happened?', 'Looks like an answer', '```'].join('\n');
        const body = renderBody('bug-report', { 'what-happened': ' ', 'reproduction-steps': steps });
        assert.deepEqual(inspect(body), { formId: 'bug-report', missingFields: ['What happened?'] });
    });

    it('falls back to a category label used by only one form', () => {
        const result = inspect('Something is broken.', ['bug', 'status: needs triage']);
        assert.equal(result.formId, 'bug-report');
        assert.ok(result.missingFields.includes('What happened?'));
    });

    it('does not guess between forms that share a category label', () => {
        assert.equal(inspect('Please add this.', ['enhancement']).formId, undefined);
        assert.equal(inspect('Please add this.', ['enhancement'], 'feature-request').formId, 'feature-request');
    });

    it('finds no form for a free-form body without labels', () => {
        assert.deepEqual(inspect('Created with gh issue create --body text.'), {
            formId: undefined,
            missingFields: [],
        });
    });
});
