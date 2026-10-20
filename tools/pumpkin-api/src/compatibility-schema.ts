import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const schemaPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../schemas/pumpkin-api-compatibility.schema.json',
);
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as { $id: string };
const ajv = new Ajv2020({ allErrors: true });
ajv.addFormat('uri', (value: string) => isUri(value));
ajv.addFormat('uri-reference', (value: string) => isUriReference(value));
const validate = ajv.compile(schema);

/** The published GitHub URL written into compatibility matrices and schema associations. */
export const COMPATIBILITY_SCHEMA_URL = schema.$id;

/** Reject a compatibility matrix that does not match the checked-in JSON Schema. */
export function validateCompatibilityMatrix(value: unknown, source: string): void {
    if (validate(value)) return;

    const errors =
        validate.errors
            ?.map(({ instancePath, message }) => `${instancePath || '/'} ${message ?? 'is invalid'}`)
            .join('\n') ?? 'unknown schema validation error';
    throw new Error(`invalid Pumpkin API compatibility matrix in ${source}:\n${errors}`);
}

function isUri(value: string): boolean {
    try {
        new URL(value);
        return true;
    } catch {
        return false;
    }
}

function isUriReference(value: string): boolean {
    try {
        new URL(value, 'https://pumpkin.invalid');
        return true;
    } catch {
        return false;
    }
}
