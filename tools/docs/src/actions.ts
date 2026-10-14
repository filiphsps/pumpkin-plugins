import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { discoverComponents } from './discovery.ts';
import { type DocumentSpec, generateDocuments, type Status } from './documents.ts';
import { code, type TableOptions, table } from './markdown.ts';

/** Input metadata from a GitHub Action manifest. */
export interface ActionInput {
    default?: unknown;
    description?: string;
    required?: boolean | string;
}

/** Output metadata from a GitHub Action manifest. */
export interface ActionOutput {
    description?: string;
}

/** The GitHub Action fields used by documentation and reference generation. */
export interface ActionMetadata {
    description?: string;
    inputs?: Record<string, ActionInput>;
    name?: string;
    outputs?: Record<string, ActionOutput>;
    runs?: { main?: string };
}

/** Parse action YAML as an object, validating any declared name and description. */
export function readActionMetadata(file: string): ActionMetadata {
    let value: unknown;
    try {
        value = parse(readFileSync(file, 'utf8'));
    } catch (error) {
        throw new Error(`${file}: invalid YAML`, { cause: error });
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${file} must contain an object`);
    for (const key of ['name', 'description'] as const) {
        if (!(key in value)) continue;
        const field = (value as Record<string, unknown>)[key];
        if (typeof field !== 'string') throw new Error(`${file} needs a string ${key}`);
        if (!field.trim()) throw new Error(`${file} has an empty ${key}`);
    }
    return value as ActionMetadata;
}

function entries<T>(value: Record<string, T> | undefined, label: string): [string, T][] {
    if (value === undefined) return [];
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a mapping`);
    return Object.entries(value);
}

function defaultValue(value: unknown): string {
    if (value === '') return code('""');
    return code(typeof value === 'object' ? JSON.stringify(value) : String(value));
}

/** Render action input/output documentation consistently for READMEs and API references. */
export function renderActionSections(
    metadata: ActionMetadata,
    options: TableOptions = { multiline: 'break' },
): {
    inputs: string;
    outputs: string;
} {
    const inputs = entries(metadata.inputs, 'inputs').map(([name, input]) => {
        if (!input || typeof input !== 'object' || Array.isArray(input))
            throw new Error(`Input ${name} must be an object`);
        return [
            code(name),
            input.required === true || input.required === 'true' ? 'Yes' : 'No',
            Object.hasOwn(input, 'default') ? defaultValue(input.default) : '',
            String(input.description ?? ''),
        ];
    });
    const outputs = entries(metadata.outputs, 'outputs').map(([name, output]) => {
        if (!output || typeof output !== 'object' || Array.isArray(output))
            throw new Error(`Output ${name} must be an object`);
        return [code(name), String(output.description ?? '')];
    });
    return {
        inputs: inputs.length
            ? table(['Input', 'Required', 'Default', 'Description'], inputs, options)
            : 'This action has no inputs.',
        outputs: outputs.length ? table(['Output', 'Description'], outputs, options) : 'This action has no outputs.',
    };
}

/** Generate all action README contracts through the shared document validator and writer. */
export function generateActionReadmes(root: string, check = false): Status {
    const documents: DocumentSpec[] = discoverComponents(root, 'actions').map((component) => ({
        file: join(component.directory, 'README.md'),
        blocks: renderActionSections(readActionMetadata(component.metadataFile)),
        markers: 'action',
        note: '',
    }));
    return generateDocuments(documents, root, check);
}
