/** How multiline Markdown table cells are displayed. */
export interface TableOptions {
    multiline?: 'space' | 'break';
}

/** Escape pipes and normalize line breaks in a Markdown table cell. */
export function cell(text: string, options: TableOptions = {}): string {
    const escaped = text.replace(/\|/g, '\\|');
    return options.multiline === 'break' ? escaped.replace(/\r?\n/g, '<br>') : escaped.replace(/\s*\n\s*/g, ' ').trim();
}

/** Render a Markdown table, escaping headers and values without a trailing newline. */
export function table(
    header: readonly string[],
    rows: readonly (readonly string[])[],
    options: TableOptions = {}
): string {
    const row = (values: readonly string[]) => `| ${values.map((value) => cell(value, options)).join(' | ')} |`;
    return [row(header), row(header.map(() => '---')), ...rows.map(row)].join('\n');
}

/** Wrap inline code with a fence that preserves embedded backticks and surrounding spaces. */
export function code(text: string): string {
    const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(([run]) => run.length));
    const fence = '`'.repeat(longest + 1);
    const pad =
        text.startsWith('`') ||
        text.endsWith('`') ||
        (text.startsWith(' ') && text.endsWith(' ') && Boolean(text.trim()));
    return `${fence}${pad ? ` ${text} ` : text}${fence}`;
}
