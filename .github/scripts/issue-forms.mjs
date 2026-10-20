import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const issueTemplateDirectory = '.github/ISSUE_TEMPLATE';
/** Label every issue form applies so new issues enter the triage queue. */
export const triageLabel = 'status: needs triage';
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
 * Derives the intake rules for one issue form from its template: the labels of its required fields
 * and the category label it applies next to the triage label.
 */
export function issueFormPolicy({ id, fileName, definition }) {
    const labels = Array.isArray(definition?.labels) ? definition.labels : [];
    const fields = Array.isArray(definition?.body) ? definition.body : [];
    return {
        id,
        fileName,
        categoryLabel: labels.find((label) => label !== triageLabel),
        requiredFields: fields
            .filter((field) => field?.type !== 'markdown' && field?.validations?.required === true)
            .map((field) => field.attributes?.label)
            .filter((label) => typeof label === 'string'),
    };
}

/**
 * Loads the intake rules of every issue form, as issue intake applies them.
 */
export async function loadIssueFormPolicies(rootDirectory = repositoryRoot) {
    return (await loadIssueForms(rootDirectory)).map(issueFormPolicy);
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

    if (forms.length === 0) {
        errors.push(`${issueTemplateDirectory} must contain at least one issue form.`);
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
        const prefix = `${issueTemplateDirectory}/${form.fileName}`;

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

        if (
            !Array.isArray(definition.labels) ||
            new Set(definition.labels).size !== 2 ||
            definition.labels.length !== 2 ||
            !definition.labels.includes(triageLabel) ||
            definition.labels.some((label) => typeof label !== 'string')
        ) {
            errors.push(`${prefix} must apply "${triageLabel}" and exactly one category label.`);
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

        if (issueFormPolicy(form).requiredFields.length === 0) {
            errors.push(`${prefix} must have at least one required field so issue intake can recognize it.`);
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
