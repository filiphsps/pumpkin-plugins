import {
    applyEdits,
    createScanner,
    type Edit,
    findNodeAtLocation,
    modify,
    type ParseError,
    parse,
    parseTree,
    SyntaxKind,
} from 'jsonc-parser';

/** Parses a JSONC object the way TypeScript reads tsconfig.json and reports a readable syntax error. */
export function parseJsonObject(source: string): { value?: Record<string, unknown>; error?: string } {
    const errors: ParseError[] = [];
    const value = parse(source, errors, { allowTrailingComma: true });
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

/** Appends string values missing from a JSONC array while preserving comments and existing layout. */
export function mergeJsonStringArray(
    source: string,
    propertyPath: Array<string | number>,
    valuesToAdd: readonly string[],
    formattingSource: string,
): string {
    const root = parseTree(source);
    const array = root && findNodeAtLocation(root, propertyPath);
    if (array?.type !== 'array') return source;

    const existing = new Set((array.children ?? []).map((child) => child.value));
    const values = [...new Set(valuesToAdd)].filter((value) => !existing.has(value));
    if (values.length === 0) return source;
    return appendJsonArrayValues(source, propertyPath, values, formattingSource);
}

/** Finds a comma token between two parsed JSON values. */
function commaBetween(source: string, start: number, end: number): Edit | undefined {
    const scanner = createScanner(source, false);
    scanner.setPosition(start);
    while (scanner.getPosition() < end) {
        if (scanner.scan() === SyntaxKind.CommaToken && scanner.getTokenOffset() < end) {
            return { offset: scanner.getTokenOffset(), length: scanner.getTokenLength(), content: '' };
        }
    }
    return undefined;
}

/** Appends values before an array's closing bracket without rewriting its comments. */
function appendJsonArrayValues(
    source: string,
    propertyPath: Array<string | number>,
    values: readonly string[],
    formattingSource: string,
): string {
    const root = parseTree(source);
    const array = root && findNodeAtLocation(root, propertyPath);
    if (array?.type !== 'array') return source;

    const children = array.children ?? [];
    const closeOffset = array.offset + array.length - 1;
    const closeLineStart = source.lastIndexOf('\n', closeOffset - 1) + 1;
    const closeIndent = source.slice(closeLineStart, closeOffset);
    const multiline = source.slice(array.offset + 1, closeOffset).includes('\n') && /^[\t ]*$/.test(closeIndent);
    const lastChild = children.at(-1);
    const trailingComma = lastChild
        ? commaBetween(source, lastChild.offset + lastChild.length, closeOffset)
        : undefined;
    const formatting = formattingOf(formattingSource);
    const indentUnit = formatting.insertSpaces ? ' '.repeat(formatting.tabSize) : '\t'.repeat(formatting.tabSize);
    const eol = formatting.eol;

    if (multiline) {
        const firstChild = children[0];
        const firstLineStart = firstChild ? source.lastIndexOf('\n', firstChild.offset - 1) + 1 : -1;
        const firstPrefix = firstChild ? source.slice(firstLineStart, firstChild.offset) : '';
        const itemIndent = firstChild && /^[\t ]*$/.test(firstPrefix) ? firstPrefix : `${closeIndent}${indentUnit}`;
        return appendArrayContent(
            source,
            lastChild ? lastChild.offset + lastChild.length : undefined,
            trailingComma !== undefined,
            closeLineStart,
            `${itemIndent}${values.map((value) => JSON.stringify(value)).join(`,${eol}${itemIndent}`)}${trailingComma ? ',' : ''}${eol}`,
        );
    }

    return appendArrayContent(
        source,
        lastChild ? lastChild.offset + lastChild.length : undefined,
        trailingComma !== undefined,
        closeOffset,
        `${values.map((value) => JSON.stringify(value)).join(',')}${trailingComma ? ',' : ''}`,
    );
}

/** Adds an array separator when needed, then inserts the new content. */
function appendArrayContent(
    source: string,
    lastValueEnd: number | undefined,
    hasTrailingComma: boolean,
    insertionOffset: number,
    content: string,
): string {
    const edits: Edit[] = [];
    if (lastValueEnd !== undefined && !hasTrailingComma) {
        edits.push({ offset: lastValueEnd, length: 0, content: ',' });
    }
    edits.push({ offset: insertionOffset, length: 0, content });
    return applyEdits(source, edits);
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
