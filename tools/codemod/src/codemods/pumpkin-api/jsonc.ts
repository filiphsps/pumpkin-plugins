import { applyEdits, modify, type ParseError, parse } from 'jsonc-parser';

/** Parses an object and captures a readable syntax error instead of discarding the file. */
export function parseJsonObject(source: string): { value?: Record<string, unknown>; error?: string } {
    const errors: ParseError[] = [];
    const value = parse(source, errors);
    if (errors.length > 0) return { error: 'Skipped invalid JSONC; fix its syntax and rerun the codemod.' };
    const object = recordOf(value);
    return object ? { value: object } : { error: 'Skipped JSONC whose top level is not an object.' };
}

/** Applies one JSONC property edit with formatting inferred from the original file. */
export function setJsonValue(
    source: string,
    propertyPath: Array<string | number>,
    value: unknown,
    formattingSource: string,
): string {
    return applyEdits(
        source,
        modify(source, propertyPath, value, { formattingOptions: formattingOf(formattingSource) }),
    );
}

/** Derives JSONC indentation and line endings for edits. */
export function formattingOf(source: string): { insertSpaces: boolean; tabSize: number; eol: string } {
    const indent = source.match(/(?:^|\r?\n)([ \t]+)(?="[^\r\n]+"\s*:)/)?.[1] ?? '    ';
    return {
        insertSpaces: !indent.includes('\t'),
        tabSize: indent.includes('\t') ? 1 : indent.length,
        eol: source.includes('\r\n') ? '\r\n' : '\n',
    };
}

/** Narrows a parsed JSON value to an object with string keys. */
export function recordOf(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}
