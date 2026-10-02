/**
 * Makes text safe inside a markdown table cell.
 * @param text - Any text.
 * @returns The text on one line with pipes escaped.
 */
export function cell(text: string): string {
    return text
        .replace(/\|/g, '\\|')
        .replace(/\s*\n\s*/g, ' ')
        .trim();
}

/**
 * Renders a markdown table.
 * @param header - Column titles.
 * @param rows - One array of cell texts per row.
 * @returns The table, without a trailing newline.
 */
export function table(header: string[], rows: string[][]): string {
    return [
        `| ${header.join(' | ')} |`,
        `| ${header.map(() => '---').join(' | ')} |`,
        ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)
    ].join('\n');
}

/**
 * Wraps text in backticks.
 * @param text - Text without backticks of its own.
 * @returns Inline code.
 */
export const code = (text: string): string => `\`${text}\``;
