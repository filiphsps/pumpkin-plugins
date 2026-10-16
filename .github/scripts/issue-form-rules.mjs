/** Required section labels and category labels for each public issue form. */
export const formPolicies = new Map([
    [
        'bug-report.yml',
        {
            categoryLabel: 'bug',
            requiredFields: ['What happened?', 'What did you expect to happen?', 'Steps to reproduce'],
        },
    ],
    [
        'feature-request.yml',
        {
            categoryLabel: 'enhancement',
            requiredFields: ['What problem or use case should this address?', 'What outcome would you like?'],
        },
    ],
    [
        'new-plugin-proposal.yml',
        {
            categoryLabel: 'enhancement',
            requiredFields: [
                'Who would use this plugin?',
                'What problem or use case would it solve?',
                'Why should it be part of the Pumpkin ecosystem?',
            ],
        },
    ],
    [
        'documentation.yml',
        {
            categoryLabel: 'documentation',
            requiredFields: ['Page or path', 'What is missing, incorrect, or confusing?'],
        },
    ],
    [
        'maintenance-task.yml',
        {
            categoryLabel: 'maintenance',
            requiredFields: ['What outcome should this task achieve?', 'Why does this matter?'],
        },
    ],
    [
        'usage-question.yml',
        {
            categoryLabel: 'question',
            requiredFields: ['What is your question?', 'What were you doing?'],
        },
    ],
]);

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
        [...sections.entries()].map(([label, values]) => [label, values.find((value) => value.length > 0) ?? '']),
    );
}

function findIssueForm(body, labels, preferredFormId) {
    const sections = parseIssueSections(body);
    const scoredForms = [...formPolicies.entries()]
        .map(([fileName, policy]) => ({
            id: fileName.slice(0, -'.yml'.length),
            fileName,
            policy,
            matchedRequiredFields: policy.requiredFields.filter((field) => sections.has(field)).length,
        }))
        .filter((entry) => entry.matchedRequiredFields > 0)
        .sort((first, second) => second.matchedRequiredFields - first.matchedRequiredFields);

    if (
        scoredForms.length === 1 ||
        (scoredForms.length > 1 && scoredForms[0].matchedRequiredFields > scoredForms[1].matchedRequiredFields)
    ) {
        return scoredForms[0];
    }

    if (preferredFormId) {
        const preferred = [...formPolicies.entries()].find(
            ([fileName]) => fileName.slice(0, -'.yml'.length) === preferredFormId,
        );
        if (preferred) {
            const [fileName, policy] = preferred;
            return { id: preferredFormId, fileName, policy };
        }
    }

    const issueLabels = new Set(labels);
    const labelMatches = [...formPolicies.entries()].filter(([, policy]) => issueLabels.has(policy.categoryLabel));
    if (labelMatches.length !== 1) {
        return undefined;
    }

    const [fileName, policy] = labelMatches[0];
    return { id: fileName.slice(0, -'.yml'.length), fileName, policy };
}

/**
 * Finds missing required answers in an issue body using the configured form definitions.
 */
export function inspectIssueSubmission(body, labels, preferredFormId) {
    const form = findIssueForm(body, labels, preferredFormId);
    if (!form) {
        return { form: undefined, missingFields: [] };
    }

    const sections = parseIssueSections(body);
    const missingFields = form.policy.requiredFields.filter((field) => !sections.get(field)?.trim());

    return { form, missingFields };
}
