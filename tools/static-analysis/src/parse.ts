import ts from 'typescript';
import type { EdgeKind, ImportForm, ModuleEdge, SourceLocation } from './types.ts';

/** Dependency syntax before the resolver has selected a target. */
export type Dependency = Omit<ModuleEdge, 'resolution'>;

/** Locates a syntax node in the original source, including its literal quotes. */
export function sourceLocation(source: ts.SourceFile, node: ts.Node): SourceLocation {
    const offset = node.getStart(source);
    const { line, character } = source.getLineAndCharacterOfPosition(offset);
    return { line: line + 1, column: character + 1, offset, length: node.getWidth(source) };
}

/** Extracts dependencies in source order, preserving both sides of mixed declarations. */
export function dependencies(source: ts.SourceFile, checker: ts.TypeChecker): Dependency[] {
    const result: Dependency[] = [];
    const add = (node: ts.Node, form: ImportForm, kinds: EdgeKind[]) => {
        const specifier = ts.isStringLiteralLike(node) ? node.text : undefined;
        for (const kind of kinds) {
            result.push({ importer: source.fileName, specifier, kind, form, location: sourceLocation(source, node) });
        }
    };
    const visit = (node: ts.Node) => {
        if (ts.isImportDeclaration(node)) {
            const clause = node.importClause;
            const bindings = clause?.namedBindings;
            const kinds = clause?.isTypeOnly
                ? ['type-only' as const]
                : bindings && ts.isNamedImports(bindings)
                  ? specifierKinds(bindings.elements, !!clause?.name)
                  : ['runtime' as const];
            add(node.moduleSpecifier, 'import', kinds);
        } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
            const clause = node.exportClause;
            add(
                node.moduleSpecifier,
                're-export',
                node.isTypeOnly
                    ? ['type-only']
                    : clause && ts.isNamedExports(clause)
                      ? specifierKinds(clause.elements, false)
                      : ['runtime'],
            );
        } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
            if (node.moduleReference.expression) {
                add(node.moduleReference.expression, 'import-equals', [node.isTypeOnly ? 'type-only' : 'runtime']);
            }
        } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
            add(node.argument.literal, 'import-type', ['type-only']);
        } else if (ts.isCallExpression(node)) {
            const expression = node.expression;
            const form =
                expression.kind === ts.SyntaxKind.ImportKeyword
                    ? 'dynamic-import'
                    : ts.isIdentifier(expression) &&
                        expression.text === 'require' &&
                        !isLocallyBound(expression, checker)
                      ? 'require'
                      : undefined;
            if (form) add(node.arguments[0] ?? node, form, ['runtime']);
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return result;
}

function specifierKinds(elements: readonly { isTypeOnly: boolean }[], hasDefault: boolean): EdgeKind[] {
    const kinds: EdgeKind[] = [];
    if (hasDefault || !elements.length || elements.some((element) => !element.isTypeOnly)) kinds.push('runtime');
    if (elements.some((element) => element.isTypeOnly)) kinds.push('type-only');
    return kinds;
}

function isLocallyBound(identifier: ts.Identifier, checker: ts.TypeChecker): boolean {
    return (
        checker
            .getSymbolAtLocation(identifier)
            ?.declarations?.some(
                (declaration) =>
                    !declaration.getSourceFile().isDeclarationFile &&
                    !(ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Ambient),
            ) ?? false
    );
}
