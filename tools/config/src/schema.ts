import type { Field, Fields } from './fields.ts';

/** A fixed group of settings, written as one `[name]` table. */
export interface SectionNode<F extends Fields = Fields> {
    readonly node: 'section';
    /** What the group is for. */
    readonly description: string;
    /** The settings in the group. */
    readonly fields: F;
}

/**
 * A table of named entries that share the same optional settings, such as per-file overrides.
 * Entries are written as `[name."entry"]` tables and are user data: they are kept as they are.
 */
export interface TableNode<F extends Fields = Fields> {
    readonly node: 'table';
    /** What the entries are for. */
    readonly description: string;
    /** What an entry is named after in the documentation, such as `file` for `overrides."<file>"`. */
    readonly entryName: string;
    /** An entry name used in the commented example. */
    readonly exampleKey: string;
    /** Entries written into a fresh configuration file. Users may remove them afterwards. */
    readonly defaults?: TableValues<F>;
    /** The settings every entry may have. They are all optional. */
    readonly fields: F;
}

/** A top-level part of the config file. */
export type ConfigNode = SectionNode | TableNode;

/** Describes a plugin's config file. Build one with `defineConfig`. */
export interface ConfigSchema<N extends Record<string, ConfigNode> = Record<string, ConfigNode>> {
    /** Name shown in the file's header comment. */
    readonly title: string;
    /** The top-level tables, by name. */
    readonly nodes: N;
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
 * Declares a table of entries with optional settings.
 * @param options - Description, what entries are named after, an example entry name and the fields every entry may have.
 * @returns The table.
 */
export function table<F extends Fields>(options: {
    description: string;
    entryName: string;
    exampleKey: string;
    defaults?: TableValues<F>;
    fields: F;
}): TableNode<F> {
    return { node: 'table', ...options };
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
 */
export function defaultValues<S extends ConfigSchema>(schema: S): ConfigValues<S> {
    const values: Record<string, unknown> = {};
    for (const [name, node] of Object.entries(schema.nodes)) {
        values[name] =
            node.node === 'table'
                ? { ...(node.defaults ?? {}) }
                : Object.fromEntries(Object.entries(node.fields).map(([key, f]) => [key, f.default]));
    }
    return values as ConfigValues<S>;
}
