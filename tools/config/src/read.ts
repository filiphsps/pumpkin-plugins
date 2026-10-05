import type { Field, Fields } from './fields.ts';
import { type ConfigSchema, type ConfigValues, defaultValues } from './schema.ts';

/** What kind of problem was found in a config file. */
export type IssueKind =
    /** A value has the wrong type or is out of range. The default is used. */
    | 'invalid'
    /** The file has a section or setting the schema doesn't know. It is ignored. */
    | 'unknown'
    /** A setting with a default is absent from the file. */
    | 'missing';

/** One finding from reading a config file. */
export interface Issue {
    /** The kind of problem. */
    kind: IssueKind;
    /** Dotted path of the setting, such as `web.port` or `overrides."a.mcpack".order`. */
    path: string;
    /** A sentence for the server log. */
    message: string;
}

/** The values read from a file and everything noticed on the way. */
export interface ReadResult<V> {
    /** Every setting, with defaults filled in. */
    values: V;
    /** Problems and omissions, in file order. */
    issues: Issue[];
}

type Table = Record<string, unknown>;

/**
 * Whether a parsed TOML value is a table.
 * @param value - A parsed TOML value.
 * @returns True for plain tables, false for arrays, dates and scalars.
 */
export const isTable = (value: unknown): value is Table =>
    typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);

/** Dotted path of an entry name, quoting it so names with dots stay unambiguous. */
const entryPath = (table: string, key: string) => `${table}.${JSON.stringify(key)}`;

/**
 * Validates a parsed TOML document against a schema. Bad values fall back to their defaults;
 * nothing throws.
 * @param schema - The config schema.
 * @param raw - The parsed TOML document.
 * @returns The typed values and the issues found.
 */
export function readConfig<S extends ConfigSchema>(schema: S, raw: Table): ReadResult<ConfigValues<S>> {
    const issues: Issue[] = [];
    const values: Record<string, unknown> = defaultValues(schema);

    for (const [name, node] of Object.entries(schema.nodes)) {
        const found = raw[name];
        if (found !== undefined && !isTable(found)) {
            issues.push({ kind: 'invalid', path: name, message: `[${name}] must be a table; using the defaults` });
            continue;
        }

        if (node.node === 'section') {
            values[name] = readFields(node.fields, found ?? {}, name, issues, true, raw);
        } else {
            const entries: Record<string, unknown> = {};
            for (const [key, entry] of Object.entries(found ?? {})) {
                const path = entryPath(name, key);
                if (isTable(entry)) entries[key] = readFields(node.fields, entry, path, issues, false, raw);
                else issues.push({ kind: 'invalid', path, message: `${path} must be a table; ignoring it` });
            }
            values[name] = entries;
        }
    }

    for (const key of Object.keys(raw)) {
        if (!(key in schema.nodes)) issues.push({ kind: 'unknown', path: key, message: `unknown section [${key}]` });
    }
    return { values: values as ConfigValues<S>, issues };
}

function readFields(
    fields: Fields,
    raw: Table,
    path: string,
    issues: Issue[],
    reportMissing: boolean,
    document: Table
) {
    const out: Record<string, unknown> = {};
    for (const [key, f] of Object.entries(fields)) {
        const at = `${path}.${key}`;
        const value = raw[key];
        if (value === undefined) {
            const previous = f.migrateFrom ? readPath(document, f.migrateFrom) : undefined;
            if (previous?.found) {
                const parsed = f.parse(previous.value);
                if (parsed.ok) {
                    out[key] = parsed.value;
                } else {
                    issues.push({ kind: 'invalid', path: at, message: invalidMessage(at, f) });
                    if (f.default !== undefined) out[key] = f.default;
                }
                if (f.default !== undefined && reportMissing)
                    issues.push({ kind: 'missing', path: at, message: `${at} is not in the file` });
                continue;
            }
            if (f.default === undefined) continue;
            if (reportMissing) issues.push({ kind: 'missing', path: at, message: `${at} is not in the file` });
            out[key] = f.default;
            continue;
        }
        const parsed = f.parse(value);
        if (parsed.ok) {
            out[key] = parsed.value;
        } else {
            issues.push({ kind: 'invalid', path: at, message: invalidMessage(at, f) });
            if (f.default !== undefined) out[key] = f.default;
        }
    }
    for (const key of Object.keys(raw)) {
        if (!(key in fields))
            issues.push({ kind: 'unknown', path: `${path}.${key}`, message: `unknown option ${path}.${key}` });
    }
    return out;
}

function readPath(document: Table, path: readonly string[]): { found: true; value: unknown } | undefined {
    if (path.length === 0) return undefined;
    let value: unknown = document;
    for (const key of path) {
        if (!isTable(value) || !Object.hasOwn(value, key)) return undefined;
        value = value[key];
    }
    return { found: true, value };
}

function invalidMessage(path: string, f: Field<unknown>): string {
    const fallback = f.default === undefined ? 'ignoring it' : `using ${f.format(f.default as never)}`;
    return `${path} must be ${f.expected}; ${fallback}`;
}
