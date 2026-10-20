/** GitHub writes this placeholder into the body for a form field left empty. */
const noResponsePlaceholder = '_No response_';

function isAnswered(value) {
    return value.length > 0 && value !== noResponsePlaceholder;
}

function parseIssueSections(body) {
    const sections = new Map();
    let activeLabel;
    let activeLines = [];
    let inCodeFence = false;

    const saveSection = () => {
        if (activeLabel === undefined) {
            return;
        }
        const values = sections.get(activeLabel) ?? [];
        values.push(activeLines.join('\n').trim());
        sections.set(activeLabel, values);
    };

    for (const line of body.split(/\r?\n/)) {
        if (/^\s*(?:```|~~~)/.test(line)) {
            inCodeFence = !inCodeFence;
        }
        const heading = inCodeFence ? undefined : /^###\s+(.+?)\s*$/.exec(line);
        if (heading) {
            saveSection();
            activeLabel = heading[1];
            activeLines = [];
        } else if (activeLabel !== undefined) {
            activeLines.push(line);
        }
    }
    saveSection();

    return new Map(
        [...sections.entries()].map(([label, values]) => [label, values.find((value) => isAnswered(value)) ?? '']),
    );
}

function findIssueForm(policies, body, labels, preferredFormId) {
    const sections = parseIssueSections(body);
    const scoredForms = policies
        .map((policy) => ({
            policy,
            matchedRequiredFields: policy.requiredFields.filter((field) => sections.has(field)).length,
        }))
        .filter((entry) => entry.matchedRequiredFields > 0)
        .sort((first, second) => second.matchedRequiredFields - first.matchedRequiredFields);

    if (
        scoredForms.length === 1 ||
        (scoredForms.length > 1 && scoredForms[0].matchedRequiredFields > scoredForms[1].matchedRequiredFields)
    ) {
        return scoredForms[0].policy;
    }

    const preferred = policies.find((policy) => policy.id === preferredFormId);
    if (preferred) {
        return preferred;
    }

    const issueLabels = new Set(labels);
    const labelMatches = policies.filter((policy) => issueLabels.has(policy.categoryLabel));
    return labelMatches.length === 1 ? labelMatches[0] : undefined;
}

/**
 * Finds the issue form an issue body was written for and the required sections it leaves empty.
 * `policies` come from `loadIssueFormPolicies()`; `preferredFormId` breaks ties between forms.
 */
export function inspectIssueSubmission(policies, body, labels, preferredFormId) {
    const form = findIssueForm(policies, body, labels, preferredFormId);
    if (!form) {
        return { form: undefined, missingFields: [] };
    }

    const sections = parseIssueSections(body);
    const missingFields = form.requiredFields.filter((field) => !sections.get(field));

    return { form, missingFields };
}
