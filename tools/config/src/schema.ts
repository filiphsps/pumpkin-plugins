import { cloneConfigValue } from './clone.ts';
import type { Field, Fields } from './fields.ts';

/** A fixed group of settings, written as one `[name]` table. */
export interface SectionNode<F extends Fields = Fields> {
    /** What the group is for. */
    readonly description: string;
    /** The settings in the group. */
    readonly fields: F;
    readonly node: 'section';
}

/**
 * A table of named entries that share the same optional settings, such as per-file overrides.
 * Entries are written as `[name."entry"]` tables and are user data: they are kept as they are.
 */
export interface TableNode<F extends Fields = Fields> {
    /** Initial entries for fresh files, with omitted field defaults filled. Config users may remove them later. */
    readonly defaults?: TableValues<F>;
    /** What the entries are for. */
    readonly description: string;
    /** What an entry is named after in the documentation, such as `file` for `overrides."<file>"`. */
    readonly entryName: string;
    /** An entry name used in the commented example. */
    readonly exampleKey: string;
    /** The settings every entry may have. They are all optional. */
    readonly fields: F;
    readonly node: 'table';
}

/** A top-level part of the config file. */
export type ConfigNode = SectionNode | TableNode;

/** Describes a plugin's config file. Build one with `defineConfig`. */
export interface ConfigSchema<N extends Record<string, ConfigNode> = Record<string, ConfigNode>> {
    /** The top-level tables, by name. */
    readonly nodes: N;
    /** Name shown in the file's header comment. */
    readonly title: string;
}

/**
 * Declares a section of fixed settings.
 * @param options - Description and fields.
 * @returns The section.
 */
export function section<F extends Fields>(options: { description: string; fields: F }): SectionNode<F> {
    return { node: 'section', ...options };
}

/**
 * Declares a table of entries with optional settings. Initial entries use field defaults for
 * omitted fields; optional fields without defaults stay absent.
 * @param options - Description, entry names, an example key and the fields every entry may have.
 * @returns The table with initial entries completed and field values in their parsed form.
 * @throws If an initial entry has an undeclared field or a provided or default value fails validation.
 */
export function table<F extends Fields>(options: {
    description: string;
    entryName: string;
    exampleKey: string;
    defaults?: TableValues<F>;
    fields: F;
}): TableNode<F> {
    const defaults = normalizeTableDefaults(options.defaults, options.fields);
    return { node: 'table', ...options, ...(defaults === undefined ? {} : { defaults }) };
}

function normalizeTableDefaults<F extends Fields>(
    defaults: TableValues<F> | undefined,
    fields: F,
): TableValues<F> | undefined {
    if (defaults === undefined) return undefined;

    const normalizedEntries: [string, Record<string, unknown>][] = [];
    for (const [entryName, values] of Object.entries(defaults ?? {})) {
        for (const key of Object.keys(values)) {
            if (!Object.hasOwn(fields, key)) {
                throw new TypeError(
                    `table() default ${JSON.stringify(entryName)} has unknown field ${JSON.stringify(key)}`,
                );
            }
        }

        const normalizedFields: [string, unknown][] = [];
        for (const [key, field] of Object.entries(fields)) {
            const hasProvidedValue = Object.hasOwn(values, key);
            if (!hasProvidedValue && field.default === undefined) continue;

            const parsed = field.parse(hasProvidedValue ? values[key] : field.default);
            if (!parsed.ok) {
                throw new TypeError(
                    `table() default ${JSON.stringify(entryName)} field ${JSON.stringify(key)} must be ${field.expected}`,
                );
            }
            normalizedFields.push([key, parsed.value]);
        }
        normalizedEntries.push([entryName, Object.fromEntries(normalizedFields)]);
    }
    return Object.fromEntries(normalizedEntries) as TableValues<F>;
}

/**
 * Declares a config file.
 * @param title - Name shown in the file's header comment.
 * @param nodes - The top-level sections and tables, in file order.
 * @returns The schema.
 */
export function defineConfig<N extends Record<string, ConfigNode>>(title: string, nodes: N): ConfigSchema<N> {
    return { title, nodes };
}

/** The value type of a field. */
export type FieldValue<F> = F extends Field<infer T> ? T : never;

/** The values of a section's settings. */
export type SectionValues<F extends Fields> = { -readonly [K in keyof F]: FieldValue<F[K]> };

/** The entries of a table, by name. */
export type TableValues<F extends Fields> = Record<
    string,
    { -readonly [K in keyof F]?: Exclude<FieldValue<F[K]>, undefined> }
>;

/** The values of one top-level node. */
export type NodeValues<N> =
    N extends SectionNode<infer F> ? SectionValues<F> : N extends TableNode<infer F> ? TableValues<F> : never;

/** The typed values of a whole config file. */
export type ConfigValues<S> = S extends ConfigSchema<infer N> ? { [K in keyof N]: NodeValues<N[K]> } : never;

/**
 * The values of a config file with nothing configured.
 * @param schema - The config schema.
 * @returns Every setting at its default, including any initial table entries.
 * @throws When a default contains unsupported data, a cycle, or an unsupported object type.
 */
export function defaultValues<S extends ConfigSchema>(schema: S): ConfigValues<S> {
    const values: Record<string, unknown> = {};
    for (const [name, node] of Object.entries(schema.nodes)) {
        values[name] =
            node.node === 'table'
                ? cloneConfigValue(node.defaults ?? {})
                : Object.fromEntries(
                      Object.entries(node.fields).map(([key, field]) => [key, cloneConfigValue(field.default)]),
                  );
    }
    return values as ConfigValues<S>;
}
