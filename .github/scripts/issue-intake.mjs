import { readFile } from 'node:fs/promises';
import { inspectIssueSubmission } from './issue-form-rules.mjs';
import { loadIssueFormPolicies, triageLabel } from './issue-forms.mjs';

const markerPrefix = '<!-- pumpkin-issue-intake-validator:';
const needsInfoLabel = 'status: needs info';
const upstreamPinMarker = /<!--\s*upstream-pin:/i;
const pageSize = 100;
const githubApiUrl = 'https://api.github.com';
const githubServerUrl = 'https://github.com';

function requiredEnvironment(name) {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable ${name}.`);
    }
    return value;
}

function buildApiUrl(apiBase, path) {
    return `${apiBase.replace(/\/$/, '')}${path}`;
}

async function requestGitHub(apiBase, token, path, options = {}) {
    const response = await fetch(buildApiUrl(apiBase, path), {
        ...options,
        headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'pumpkin-plugins-issue-intake',
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            ...options.headers,
        },
    });
    const responseText = await response.text();
    if (!response.ok) {
        throw new Error(
            `GitHub API request failed (${response.status}) for ${path}: ${responseText.slice(0, 1000) || response.statusText}`,
        );
    }
    return responseText ? JSON.parse(responseText) : undefined;
}

async function listIssueComments(apiBase, token, repositoryPath, issueNumber) {
    const comments = [];
    for (let page = 1; ; page += 1) {
        const nextPage = await requestGitHub(
            apiBase,
            token,
            `${repositoryPath}/issues/${issueNumber}/comments?per_page=${pageSize}&page=${page}`,
        );
        comments.push(...nextPage);
        if (nextPage.length < pageSize) {
            return comments;
        }
    }
}

function getManagedComment(comments) {
    return comments.find(
        (comment) =>
            comment.user?.login === 'github-actions[bot]' &&
            typeof comment.body === 'string' &&
            comment.body.includes(markerPrefix),
    );
}

function getManagedFormId(comment) {
    const match = new RegExp(`${markerPrefix}([a-z0-9-]+)\\s*-->`, 'i').exec(comment?.body ?? '');
    return match?.[1] === 'none' ? undefined : match?.[1];
}

function labelNames(issue) {
    return Array.isArray(issue.labels)
        ? issue.labels.map((label) => (typeof label === 'string' ? label : label.name)).filter(Boolean)
        : [];
}

function issueChooserUrl(repository) {
    const repositoryPath = repository.split('/').map(encodeURIComponent).join('/');
    return new URL(`${repositoryPath}/issues/new/choose`, `${githubServerUrl}/`).href;
}

function incompleteCommentBody(form, missingFields, repository) {
    const formId = form?.id ?? 'none';
    const marker = `${markerPrefix}${formId} -->`;
    if (!form) {
        return [
            marker,
            'This issue does not match one of the repository issue forms. Please edit it to include the required information under the sections for the appropriate form in the [issue chooser].',
            '',
            'The issue remains open. Once the form sections are present and complete, the workflow will return it to the triage queue.',
            '',
            `[issue chooser]: ${issueChooserUrl(repository)}`,
        ].join('\n');
    }

    const missingList = missingFields.map((field) => `- **${field}**`).join('\n');
    return [
        marker,
        'Thanks for opening this issue. It needs a little more information before it can enter triage.',
        '',
        'Please edit the issue and complete these required sections:',
        '',
        missingList,
        '',
        'The issue remains open. Once these sections are complete, the workflow will return it to the triage queue.',
    ].join('\n');
}

function completeCommentBody(formId, returnedToTriage) {
    const marker = `${markerPrefix}${formId ?? 'none'} -->`;
    const message = returnedToTriage
        ? 'Thanks. The required details are now present, and this issue has returned to the triage queue.'
        : 'Thanks. The required details are now present. This issue remains open for maintainers to review.';
    return `${marker}\n${message}`;
}

async function addLabel(apiBase, token, repositoryPath, issueNumber, name) {
    await requestGitHub(apiBase, token, `${repositoryPath}/issues/${issueNumber}/labels`, {
        method: 'POST',
        body: JSON.stringify({ labels: [name] }),
    });
}

async function removeLabel(apiBase, token, repositoryPath, issueNumber, name) {
    await requestGitHub(apiBase, token, `${repositoryPath}/issues/${issueNumber}/labels/${encodeURIComponent(name)}`, {
        method: 'DELETE',
    });
}

async function updateIssueLabels(apiBase, token, repositoryPath, issueNumber, currentLabels, complete) {
    const labels = new Set(currentLabels);
    if (complete) {
        if (!labels.has(needsInfoLabel)) {
            return false;
        }
        await removeLabel(apiBase, token, repositoryPath, issueNumber, needsInfoLabel);
        if (!labels.has(triageLabel)) {
            await addLabel(apiBase, token, repositoryPath, issueNumber, triageLabel);
        }
        return true;
    }

    if (labels.has(triageLabel)) {
        await removeLabel(apiBase, token, repositoryPath, issueNumber, triageLabel);
    }
    if (!labels.has(needsInfoLabel)) {
        await addLabel(apiBase, token, repositoryPath, issueNumber, needsInfoLabel);
    }
    return false;
}

async function writeManagedComment(apiBase, token, repositoryPath, issueNumber, existingComment, body) {
    if (existingComment) {
        await requestGitHub(apiBase, token, `${repositoryPath}/issues/comments/${existingComment.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ body }),
        });
        return;
    }

    await requestGitHub(apiBase, token, `${repositoryPath}/issues/${issueNumber}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body }),
    });
}

async function run() {
    const event = JSON.parse(await readFile(requiredEnvironment('GITHUB_EVENT_PATH'), 'utf8'));
    if (!['opened', 'edited'].includes(event.action) || !event.issue?.number) {
        throw new Error('Expected an opened or edited issue event.');
    }

    const issueNumber = event.issue.number;
    const repository = requiredEnvironment('GITHUB_REPOSITORY');
    const repositoryPath = `/repos/${repository.split('/').map(encodeURIComponent).join('/')}`;
    const token = requiredEnvironment('GITHUB_TOKEN');
    const apiBase = githubApiUrl;
    const issue = await requestGitHub(apiBase, token, `${repositoryPath}/issues/${issueNumber}`);

    if (issue.state !== 'open') {
        console.log(`Skipping closed issue #${issueNumber}.`);
        return;
    }
    if (upstreamPinMarker.test(issue.body ?? '')) {
        console.log(`Skipping upstream pin issue #${issueNumber}.`);
        return;
    }

    const comments = await listIssueComments(apiBase, token, repositoryPath, issueNumber);
    const managedComment = getManagedComment(comments);
    if (event.action === 'edited' && !managedComment) {
        console.log(`Skipping previously untracked issue #${issueNumber} after edit.`);
        return;
    }

    const labels = labelNames(issue);
    const { form, missingFields } = inspectIssueSubmission(
        await loadIssueFormPolicies(),
        issue.body ?? '',
        labels,
        getManagedFormId(managedComment),
    );
    const complete = Boolean(form) && missingFields.length === 0;
    if (!complete) {
        await updateIssueLabels(apiBase, token, repositoryPath, issueNumber, labels, false);
        await writeManagedComment(
            apiBase,
            token,
            repositoryPath,
            issueNumber,
            managedComment,
            incompleteCommentBody(form, missingFields, repository),
        );
        console.log(`Requested missing intake information on issue #${issueNumber}.`);
        return;
    }

    if (managedComment) {
        const returnedToTriage = await updateIssueLabels(apiBase, token, repositoryPath, issueNumber, labels, true);
        await writeManagedComment(
            apiBase,
            token,
            repositoryPath,
            issueNumber,
            managedComment,
            completeCommentBody(form.id, returnedToTriage),
        );
        console.log(`Updated intake status on issue #${issueNumber}.`);
    } else {
        console.log(`Issue #${issueNumber} contains all required form sections.`);
    }
}

await run();
