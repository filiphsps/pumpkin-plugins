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

/** Merges string values into a JSONC array while preserving comments and existing layout. */
export function mergeJsonStringArray(
    source: string,
    propertyPath: Array<string | number>,
    valuesToAdd: readonly string[],
    formattingSource: string,
): string {
    const root = parseTree(source);
    const array = root && findNodeAtLocation(root, propertyPath);
    if (array?.type !== 'array') return source;

    const children = array.children ?? [];
    const seen = new Set<string>();
    const duplicateIndices = new Set<number>();
    for (const [index, child] of children.entries()) {
        if (child.type !== 'string' || typeof child.value !== 'string') continue;
        if (seen.has(child.value)) duplicateIndices.add(index);
        else seen.add(child.value);
    }

    const values = [...new Set(valuesToAdd)].filter((value) => !seen.has(value));
    let migrated = source;
    if (duplicateIndices.size > 0) {
        const edits: Edit[] = [];
        const lastIndex = children.length - 1;
        for (const index of duplicateIndices) {
            const child = children[index];
            if (!child) continue;
            edits.push({ offset: child.offset, length: child.length, content: '' });

            const isRunStart = index === 0 || !duplicateIndices.has(index - 1);
            if (!isRunStart) continue;

            let runEnd = index;
            while (duplicateIndices.has(runEnd + 1)) runEnd++;
            if (runEnd === lastIndex) {
                const previous = children[index - 1];
                if (previous) {
                    const comma = commaBetween(source, previous.offset + previous.length, child.offset);
                    if (comma) edits.push(comma);
                }
                for (let current = index; current < runEnd; current++) {
                    const currentChild = children[current];
                    const nextChild = children[current + 1];
                    if (!currentChild || !nextChild) continue;
                    const comma = commaBetween(source, currentChild.offset + currentChild.length, nextChild.offset);
                    if (comma) edits.push(comma);
                }
            } else {
                for (let current = index; current <= runEnd; current++) {
                    const currentChild = children[current];
                    const nextChild = children[current + 1];
                    if (!currentChild || !nextChild) continue;
                    const comma = commaBetween(source, currentChild.offset + currentChild.length, nextChild.offset);
                    if (comma) edits.push(comma);
                }
            }
        }
        migrated = applyEdits(
            source,
            edits.sort((left, right) => left.offset - right.offset),
        );
    }

    if (values.length === 0) return migrated;
    return appendJsonArrayValues(migrated, propertyPath, values, formattingSource);
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
        const edits: Edit[] = [];
        if (lastChild && !trailingComma) {
            edits.push({ offset: lastChild.offset + lastChild.length, length: 0, content: ',' });
        }
        edits.push({
            offset: closeLineStart,
            length: 0,
            content: `${itemIndent}${values.map((value) => JSON.stringify(value)).join(`,${eol}${itemIndent}`)}${trailingComma ? ',' : ''}${eol}`,
        });
        return applyEdits(
            source,
            edits.sort((left, right) => left.offset - right.offset),
        );
    }

    const edits: Edit[] = [];
    if (lastChild && !trailingComma) {
        edits.push({ offset: lastChild.offset + lastChild.length, length: 0, content: ',' });
    }
    edits.push({
        offset: closeOffset,
        length: 0,
        content: `${values.map((value) => JSON.stringify(value)).join(',')}${trailingComma ? ',' : ''}`,
    });
    return applyEdits(
        source,
        edits.sort((left, right) => left.offset - right.offset),
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
