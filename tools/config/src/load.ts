import { parse, TomlError } from 'smol-toml';
import { readConfig } from './read.ts';
import { type RenderOptions, renderConfig } from './render.ts';
import { type ConfigSchema, type ConfigValues, defaultValues } from './schema.ts';

/** Where a config file lives. Kept abstract so the library doesn't depend on any filesystem. */
export interface ConfigStore {
    /** The file's text, or `undefined` when it doesn't exist. */
    read(): string | undefined;
    /** Replaces the file's text, creating the file if needed. */
    write(text: string): void;
}

/** The file isn't valid TOML. It is left untouched so the user can fix it. */
export class ConfigSyntaxError extends Error {}

/** What `loadConfig` did to the file. */
export type LoadStatus =
    /** There was no file, so the defaults were written. */
    | 'created'
    /** The file was rewritten to match the schema. */
    | 'updated'
    /** The file already matched the schema. */
    | 'unchanged'
    /** A value is invalid, so the file was left as it is until that is fixed. */
    | 'kept';

/** The loaded values and what happened to the file. */
export interface LoadResult<V> {
    /** Every setting, with defaults filled in. */
    values: V;
    /** What was done to the file. */
    status: LoadStatus;
    /** Problems to show the user. Invalid values always appear; unknown settings only when the file was kept. */
    warnings: string[];
    /** Settings written to the file because it didn't have them yet. */
    added: string[];
    /** Settings dropped from the file because the schema no longer has them. */
    removed: string[];
}

/**
 * Reads a config file and brings it in line with the schema: a missing file is created, new
 * settings are added and removed ones dropped, and the user's values are kept. A file with an
 * invalid value is never rewritten, so what the user typed isn't lost.
 * @param schema - The config schema.
 * @param store - Where the file lives.
 * @param options - Rendering options.
 * @returns The values and a report of what changed.
 * @throws {ConfigSyntaxError} When the file isn't valid TOML. The file is not modified.
 */
export function loadConfig<S extends ConfigSchema>(
    schema: S,
    store: ConfigStore,
    options: RenderOptions = {}
): LoadResult<ConfigValues<S>> {
    const text = store.read();
    if (text === undefined) {
        const values = defaultValues(schema);
        store.write(renderConfig(schema, values, options));
        return { values, status: 'created', warnings: [], added: [], removed: [] };
    }

    let raw: Record<string, unknown>;
    try {
        raw = parse(text, { integersAsBigInt: 'asNeeded' });
    } catch (err) {
        throw new ConfigSyntaxError(describeSyntaxError(err));
    }

    const { values, issues } = readConfig(schema, raw);
    const invalid = issues.filter((i) => i.kind === 'invalid');
    const unknown = issues.filter((i) => i.kind === 'unknown');
    const warnings = invalid.map((i) => i.message);

    if (invalid.length > 0) {
        return {
            values,
            status: 'kept',
            warnings: [...warnings, ...unknown.map((i) => i.message)],
            added: [],
            removed: []
        };
    }

    const rendered = renderConfig(schema, values, options);
    const added = issues.filter((i) => i.kind === 'missing').map((i) => i.path);
    const removed = unknown.map((i) => i.path);
    if (rendered === text) return { values, status: 'unchanged', warnings, added, removed };

    store.write(rendered);
    return { values, status: 'updated', warnings, added, removed };
}

/** One line with the position, instead of the parser's multi-line code excerpt. */
function describeSyntaxError(err: unknown): string {
    if (err instanceof TomlError) return `${err.message.split('\n')[0]} (line ${err.line}, column ${err.column})`;
    return err instanceof Error ? err.message : String(err);
}
