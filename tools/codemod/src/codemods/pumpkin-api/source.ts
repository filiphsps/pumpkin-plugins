import * as path from 'node:path';
import * as ts from 'typescript';
import type { TransformContext, TransformResult } from '../../types.js';
import { API_PACKAGE, LEGACY_API_PACKAGE } from './constants.js';

/** Replaces legacy package specifiers in parsed TypeScript and JavaScript syntax. */
export function migrateSource(context: TransformContext): TransformResult {
    const sourceFile = ts.createSourceFile(
        context.absolutePath,
        context.source,
        ts.ScriptTarget.Latest,
        true,
        scriptKindOf(context.absolutePath),
    );
    const parseDiagnostics = (sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] })
        .parseDiagnostics;
    if (parseDiagnostics && parseDiagnostics.length > 0) {
        return {
            source: context.source,
            messages: ['Skipped source with syntax errors; fix the parse errors and rerun the codemod.'],
        };
    }

    const edits: Array<{ start: number; end: number }> = [];
    const visit = (node: ts.Node): void => {
        const specifier = moduleSpecifierOf(node);
        if (specifier?.text === LEGACY_API_PACKAGE) {
            edits.push({ start: specifier.getStart(sourceFile), end: specifier.getEnd() });
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    if (edits.length === 0) return { source: context.source };
    let migrated = context.source;
    for (const edit of edits.sort((left, right) => right.start - left.start)) {
        const quote = migrated[edit.start];
        migrated = `${migrated.slice(0, edit.start)}${quote}${API_PACKAGE}${quote}${migrated.slice(edit.end)}`;
    }
    return { source: migrated };
}

/** Returns a module string literal from syntax that names an imported module. */
function moduleSpecifierOf(node: ts.Node): ts.StringLiteral | undefined {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) return node.moduleSpecifier;
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        return node.moduleSpecifier;
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        const expression = node.moduleReference.expression;
        if (expression && ts.isStringLiteral(expression)) return expression;
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
        return node.argument.literal;
    }
    if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) return node.name;
    if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0])) {
        const callee = node.expression;
        if (callee.kind === ts.SyntaxKind.ImportKeyword) return node.arguments[0];
        if (ts.isIdentifier(callee) && callee.text === 'require') return node.arguments[0];
        if (
            ts.isPropertyAccessExpression(callee) &&
            ts.isIdentifier(callee.expression) &&
            callee.expression.text === 'require' &&
            callee.name.text === 'resolve'
        ) {
            return node.arguments[0];
        }
    }
    return undefined;
}

/** Selects the parser mode required by a source file's extension. */
function scriptKindOf(filePath: string): ts.ScriptKind {
    switch (path.extname(filePath).toLowerCase()) {
        case '.jsx':
            return ts.ScriptKind.JSX;
        case '.tsx':
            return ts.ScriptKind.TSX;
        case '.js':
        case '.mjs':
        case '.cjs':
            return ts.ScriptKind.JS;
        default:
            return ts.ScriptKind.TS;
    }
}
