import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { formPolicies } from './issue-form-rules.mjs';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const issueTemplateDirectory = '.github/ISSUE_TEMPLATE';
const triageLabel = 'status: needs triage';
const supportedFieldTypes = new Set(['checkboxes', 'dropdown', 'input', 'markdown', 'textarea', 'upload']);

function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readYaml(filePath) {
    return parse(await readFile(filePath, 'utf8'));
}

/**
 * Loads the issue form definitions used by both CI validation and issue intake.
 */
export async function loadIssueForms(rootDirectory = repositoryRoot) {
    const directory = path.join(rootDirectory, issueTemplateDirectory);
    const fileNames = (await readdir(directory))
        .filter((fileName) => fileName.endsWith('.yml') && fileName !== 'config.yml')
        .sort();

    return Promise.all(
        fileNames.map(async (fileName) => ({
            id: fileName.slice(0, -'.yml'.length),
            fileName,
            definition: await readYaml(path.join(directory, fileName)),
        })),
    );
}

/**
 * Checks the issue forms against the repository's intake rules and label catalog.
 */
export async function validateIssueFormDefinitions(rootDirectory = repositoryRoot) {
    const errors = [];
    let forms;

    try {
        forms = await loadIssueForms(rootDirectory);
    } catch (error) {
        return {
            errors: [`Unable to read issue form definitions: ${error.message}`],
            formCount: 0,
        };
    }

    const expectedFileNames = [...formPolicies.keys()].sort();
    const actualFileNames = forms.map((form) => form.fileName).sort();
    if (JSON.stringify(actualFileNames) !== JSON.stringify(expectedFileNames)) {
        errors.push(
            `Expected issue form files ${expectedFileNames.join(', ')}; found ${actualFileNames.join(', ') || 'none'}.`,
        );
    }

    let config;
    try {
        config = await readYaml(path.join(rootDirectory, issueTemplateDirectory, 'config.yml'));
    } catch (error) {
        errors.push(`Unable to read issue template config.yml: ${error.message}`);
    }

    if (!isRecord(config)) {
        errors.push('Issue template config.yml must contain a YAML mapping.');
    } else {
        if (config.blank_issues_enabled !== false) {
            errors.push('config.yml must set blank_issues_enabled to false.');
        }

        const securityLink = Array.isArray(config.contact_links)
            ? config.contact_links.find(
                  (link) =>
                      isRecord(link) && typeof link.url === 'string' && link.url.endsWith('/security/advisories/new'),
              )
            : undefined;
        if (!securityLink) {
            errors.push('config.yml must link to GitHub private vulnerability reporting.');
        }
    }

    let labelNames = new Set();
    try {
        const labels = await readYaml(path.join(rootDirectory, '.github/labels.yml'));
        if (!Array.isArray(labels)) {
            errors.push('.github/labels.yml must contain a YAML array.');
        } else {
            labelNames = new Set(labels.filter(isRecord).map((label) => label.name));
        }
    } catch (error) {
        errors.push(`Unable to read .github/labels.yml: ${error.message}`);
    }

    const formNames = new Set();
    for (const form of forms) {
        const { definition } = form;
        const policy = formPolicies.get(form.fileName);
        const prefix = `${issueTemplateDirectory}/${form.fileName}`;

        if (!policy) {
            errors.push(`${prefix} is not part of the configured issue form set.`);
            continue;
        }
        if (!isRecord(definition)) {
            errors.push(`${prefix} must contain a YAML mapping.`);
            continue;
        }

        if (typeof definition.name !== 'string' || definition.name.trim().length === 0) {
            errors.push(`${prefix} must define a non-empty name.`);
        } else if (formNames.has(definition.name)) {
            errors.push(`${prefix} repeats the issue form name "${definition.name}".`);
        } else {
            formNames.add(definition.name);
        }
        if (typeof definition.description !== 'string' || definition.description.trim().length === 0) {
            errors.push(`${prefix} must define a non-empty description.`);
        }
        if (Object.hasOwn(definition, 'title')) {
            errors.push(`${prefix} must not set a title prefix.`);
        }
        if (Object.hasOwn(definition, 'assignees')) {
            errors.push(`${prefix} must not assign a default owner.`);
        }

        const expectedLabels = [policy.categoryLabel, triageLabel];
        if (
            !Array.isArray(definition.labels) ||
            expectedLabels.some((label) => !definition.labels.includes(label)) ||
            definition.labels.some((label) => !expectedLabels.includes(label))
        ) {
            errors.push(`${prefix} must apply exactly these labels: ${expectedLabels.join(', ')}.`);
        }
        for (const label of Array.isArray(definition.labels) ? definition.labels : []) {
            if (!labelNames.has(label)) {
                errors.push(`${prefix} references unknown repository label "${label}".`);
            }
        }

        if (!Array.isArray(definition.body)) {
            errors.push(`${prefix} must define a body array.`);
            continue;
        }

        const fieldIds = new Set();
        const requiredLabels = [];
        let hasOptionalComponent = false;
        for (const [index, field] of definition.body.entries()) {
            const fieldPrefix = `${prefix} body[${index}]`;
            if (!isRecord(field) || !supportedFieldTypes.has(field.type)) {
                errors.push(`${fieldPrefix} must use a supported GitHub issue form field type.`);
                continue;
            }

            if (!isRecord(field.attributes)) {
                errors.push(`${fieldPrefix} must define attributes.`);
                continue;
            }

            if (field.type === 'markdown') {
                if (typeof field.attributes.value !== 'string' || field.attributes.value.trim().length === 0) {
                    errors.push(`${fieldPrefix} must define non-empty markdown text.`);
                }
                continue;
            }

            if (typeof field.id !== 'string' || field.id.trim().length === 0) {
                errors.push(`${fieldPrefix} must define a non-empty id.`);
            } else if (fieldIds.has(field.id)) {
                errors.push(`${fieldPrefix} repeats field id "${field.id}".`);
            } else {
                fieldIds.add(field.id);
            }
            if (typeof field.attributes.label !== 'string' || field.attributes.label.trim().length === 0) {
                errors.push(`${fieldPrefix} must define a non-empty label.`);
            }

            if (field.validations !== undefined && !isRecord(field.validations)) {
                errors.push(`${fieldPrefix} validations must be a mapping.`);
            } else if (
                isRecord(field.validations) &&
                field.validations.required !== undefined &&
                typeof field.validations.required !== 'boolean'
            ) {
                errors.push(`${fieldPrefix} validations.required must be a boolean.`);
            }

            if (field.validations?.required === true && typeof field.attributes.label === 'string') {
                requiredLabels.push(field.attributes.label);
            }
            if (field.id === 'affected-component') {
                hasOptionalComponent = field.validations?.required === false;
            }
            if (
                field.type === 'dropdown' &&
                (!Array.isArray(field.attributes.options) || field.attributes.options.length === 0)
            ) {
                errors.push(`${fieldPrefix} dropdown options must be a non-empty array.`);
            }
            if (
                field.type === 'checkboxes' &&
                (!Array.isArray(field.attributes.options) || field.attributes.options.length === 0)
            ) {
                errors.push(`${fieldPrefix} checkbox options must be a non-empty array.`);
            }
        }

        if (JSON.stringify(requiredLabels) !== JSON.stringify(policy.requiredFields)) {
            errors.push(`${prefix} required fields must be: ${policy.requiredFields.join('; ')}.`);
        }
        if (!hasOptionalComponent) {
            errors.push(`${prefix} must have an optional field with id "affected-component".`);
        }
        if (form.id === 'bug-report' && !JSON.stringify(definition).toLowerCase().includes('security')) {
            errors.push(`${prefix} must remind reporters to use private reporting for security issues.`);
        }
    }

    return { errors, formCount: forms.length };
}
