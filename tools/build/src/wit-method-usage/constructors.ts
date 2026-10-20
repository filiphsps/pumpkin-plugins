import * as ts from 'typescript';
import { type Analysis, isRuntimeDependencySource, isUntyped } from './analysis.ts';
import { resolveAlias } from './imports.ts';

/**
 * Records the WIT resource constructors that one node of plugin code can reach, either as a `new`
 * target or as a class value passed to other code.
 */
export function trackConstructors(analysis: Analysis, node: ts.Node): void {
    if (ts.isNewExpression(node)) collectConstructor(analysis, node.expression);
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) collectReferencedWitConstructor(analysis, node);
}

function collectConstructor(analysis: Analysis, expression: ts.Expression): void {
    const { checker, report } = analysis;
    const name = ts.isPropertyAccessExpression(expression) ? expression.name : expression;
    const type = checker.getTypeAtLocation(expression);
    const source = expression.getSourceFile();
    const declaresClass = collectClassConstructors(analysis, checker.getSymbolAtLocation(name));
    const typeDeclaresClass = collectClassConstructors(analysis, type.getSymbol());
    let resolved = declaresClass || typeDeclaresClass;

    if (isUntyped(type)) {
        if (!isRuntimeDependencySource(source)) report.incomplete = true;
        return;
    }
    for (const member of type.isUnionOrIntersection() ? type.types : [type])
        resolved = collectConstructorType(analysis, member, source) || resolved;
    if (!resolved && !isRuntimeDependencySource(source)) report.incomplete = true;
}

function collectConstructorType(
    analysis: Analysis,
    type: ts.Type,
    source: ts.SourceFile,
    visited = new Set<ts.Type>(),
): boolean {
    if (visited.has(type)) return true;
    visited.add(type);
    if (isUntyped(type)) {
        if (!isRuntimeDependencySource(source)) analysis.report.incomplete = true;
        return false;
    }
    if (type.isUnionOrIntersection()) {
        let resolved = true;
        for (const member of type.types)
            resolved = collectConstructorType(analysis, member, source, visited) && resolved;
        return resolved;
    }

    const classResolved = collectClassConstructors(analysis, type.getSymbol());
    let resolved = classResolved;
    const signatures = analysis.checker.getSignaturesOfType(type, ts.SignatureKind.Construct);
    if (signatures.length > 0) {
        let signaturesResolved = true;
        for (const signature of signatures) {
            const declaration = signature.getDeclaration();
            const parent = declaration?.parent;
            if (parent && (ts.isClassDeclaration(parent) || ts.isClassExpression(parent))) {
                analysis.report.addConstructor(parent);
                continue;
            }
            if (classResolved) continue;
            if (declaration && isKnownNonHostConstructor(declaration)) continue;
            signaturesResolved = false;
        }
        if (!signaturesResolved) analysis.report.incomplete = true;
        resolved = signaturesResolved || resolved;
    }
    return resolved;
}

/**
 * Retains a host constructor when plugin code passes its class value to a dynamically typed dependency.
 */
function collectReferencedWitConstructor(analysis: Analysis, expression: ts.Expression): void {
    if (isTypeOnlyReference(expression)) return;
    if (
        ts.isIdentifier(expression) &&
        ts.isPropertyAccessExpression(expression.parent) &&
        expression.parent.expression === expression
    )
        return;
    const symbol =
        ts.isIdentifier(expression) && ts.isShorthandPropertyAssignment(expression.parent)
            ? analysis.checker.getShorthandAssignmentValueSymbol(expression.parent)
            : analysis.checker.getSymbolAtLocation(expression);
    collectClassConstructors(analysis, symbol);
}

/** Records the constructor of each class a symbol declares, following import aliases, and reports whether there is one. */
function collectClassConstructors(analysis: Analysis, symbol: ts.Symbol | undefined): boolean {
    if (!symbol) return false;
    let declaresClass = false;
    for (const declaration of resolveAlias(analysis.checker, symbol).declarations ?? []) {
        if (!ts.isClassDeclaration(declaration) && !ts.isClassExpression(declaration)) continue;
        analysis.report.addConstructor(declaration);
        declaresClass = true;
    }
    return declaresClass;
}

/**
 * Distinguishes runtime values from type-only references and import/export declarations.
 */
function isTypeOnlyReference(expression: ts.Expression): boolean {
    for (let parent = expression.parent; parent; parent = parent.parent) {
        if (ts.isTypeNode(parent) || ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return true;
        if (ts.isExpression(parent)) return false;
    }
    return false;
}

function isKnownNonHostConstructor(declaration: ts.SignatureDeclaration): boolean {
    const source = declaration.getSourceFile();
    if (/[/\\]lib\.[^/\\]+\.d\.ts$/.test(source.fileName)) return true;
    return !source.isDeclarationFile && (ts.isFunctionDeclaration(declaration) || ts.isFunctionExpression(declaration));
}
