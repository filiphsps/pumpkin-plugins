import type { Fields } from './fields.ts';
import type { ConfigSchema, ConfigValues, SectionNode, TableNode } from './schema.ts';

/** Longest comment line the renderer produces. */
const COMMENT_WIDTH = 100;

/** Explains to users that the plugin maintains the file. */
export const MANAGED_NOTE =
    'This file is managed by the plugin: when it starts, settings that were added are written here with their defaults and settings that were removed are dropped. Your values are kept; comments you add are not.';

/** Options for `renderConfig`. */
export interface RenderOptions {
    /** Replaces the default note about the plugin managing the file. */
    note?: string;
}

/**
 * Wraps text into `# ` comment lines.
 * @param text - Plain text. Words are never split.
 * @param width - Longest line to produce, including the `# `.
 * @returns One string per line.
 */
export function commentLines(text: string, width = COMMENT_WIDTH): string[] {
    const lines: string[] = [];
    let line = '#';
    for (const word of text.split(/\s+/).filter(Boolean)) {
        if (line.length + 1 + word.length > width && line !== '#') {
            lines.push(line);
            line = '#';
        }
        line += ` ${word}`;
    }
    lines.push(line);
    return lines;
}

/**
 * Renders a config file: every setting with its comment, in schema order.
 * @param schema - The config schema.
 * @param values - The values to write, as returned by `readConfig` or `defaultValues`.
 * @param options - Rendering options.
 * @returns The TOML text, ending in a newline.
 */
export function renderConfig<S extends ConfigSchema>(
    schema: S,
    values: ConfigValues<S>,
    options: RenderOptions = {}
): string {
    const blocks = [[...commentLines(`${schema.title} configuration.`), ...commentLines(options.note ?? MANAGED_NOTE)]];
    for (const [name, node] of Object.entries(schema.nodes)) {
        const nodeValues = (values as Record<string, Record<string, unknown>>)[name];
        blocks.push(
            ...(node.node === 'section' ? renderSection(name, node, nodeValues) : renderTable(name, node, nodeValues))
        );
    }
    return `${blocks.map((block) => block.join('\n')).join('\n\n')}\n`;
}

function renderSection(name: string, node: SectionNode, values: Record<string, unknown>): string[][] {
    const blocks = [[...commentLines(node.description), `[${name}]`]];
    for (const [key, f] of Object.entries(node.fields)) {
        const value = values[key];
        blocks.push([
            ...commentLines(f.description),
            value === undefined ? `# ${key} = ${f.example}` : `${key} = ${f.format(value as never)}`
        ]);
    }
    return blocks;
}

function renderTable(name: string, node: TableNode, entries: Record<string, unknown>): string[][] {
    const header = JSON.stringify(node.exampleKey);
    const example = [
        ...commentLines(node.description),
        '#',
        `# [${name}.${header}]`,
        ...Object.entries(node.fields).map(([key, f]) => `# ${key} = ${f.example}  # ${f.description}`)
    ];
    const blocks = [example];
    for (const [key, entry] of Object.entries(entries)) {
        blocks.push([
            `[${name}.${JSON.stringify(key)}]`,
            ...renderEntry(node.fields, entry as Record<string, unknown>)
        ]);
    }
    return blocks;
}

function renderEntry(fields: Fields, entry: Record<string, unknown>): string[] {
    return Object.entries(fields)
        .filter(([key]) => entry[key] !== undefined)
        .map(([key, f]) => `${key} = ${f.format(entry[key] as never)}`);
}
