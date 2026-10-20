import * as ts from 'typescript';
import { type Analysis, isUnknownDynamicHostCall, isUntyped, literalKeys } from './analysis.ts';
import { resolveAlias } from './imports.ts';

/**
 * Records the WIT operations that one node of plugin code reads as a member, by property access,
 * computed key, imported name or destructuring.
 */
export function trackMemberAccess(analysis: Analysis, node: ts.Node): void {
    if (ts.isPropertyAccessExpression(node)) collectMethod(analysis, node.name, node.expression, node.name.text);
    else if (ts.isElementAccessExpression(node)) {
        const keys = literalKeys(analysis.checker, node.argumentExpression);
        if (keys) for (const key of keys) collectMethod(analysis, node.argumentExpression, node.expression, key);
        else {
            const receiverType = analysis.checker.getTypeAtLocation(node.expression);
            collectAllMembers(analysis, receiverType, node.argumentExpression, node.expression);
        }
    } else if (ts.isIdentifier(node)) collectMethod(analysis, node);
    if (ts.isObjectBindingPattern(node)) collectDestructuredMembers(analysis, node);
    else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isObjectLiteralExpression(node.left)
    )
        collectAssignedMembers(analysis, node.left, node.right);
    else if (isUnsupportedDestructuringTarget(node)) analysis.report.incomplete = true;
}

/**
 * Collects members taken from a destructuring pattern in a declaration, parameter, for-of
 * loop or enclosing pattern, using the type of the value the pattern destructures.
 */
function collectDestructuredMembers(analysis: Analysis, pattern: ts.ObjectBindingPattern): void {
    const type = analysis.checker.getTypeAtLocation(pattern);
    for (const binding of pattern.elements) {
        if (binding.dotDotDotToken) {
            // Members later read from an untyped rest object are collected where they are accessed.
            if (!isUntyped(type)) collectAllMembers(analysis, type, binding.name, pattern);
            continue;
        }
        const name = binding.propertyName ?? binding.name;
        if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
            if (name.text === 'registerEvent') analysis.report.incompleteEventTypes = true;
            collectMethod(analysis, name, pattern, name.text);
        } else collectAllMembers(analysis, type, name, pattern);
    }
}

/** Collects members taken by a destructuring assignment such as `({ method } = resource)`. */
function collectAssignedMembers(analysis: Analysis, target: ts.ObjectLiteralExpression, source: ts.Expression): void {
    const type = analysis.checker.getTypeAtLocation(source);
    for (const property of target.properties) {
        if (ts.isSpreadAssignment(property)) {
            collectAllMembers(analysis, type, property, source);
            continue;
        }
        if (ts.isPropertyAssignment(property) && containsAssignmentPattern(property.initializer))
            analysis.report.incomplete = true;
        const name = property.name;
        if (name && (ts.isIdentifier(name) || ts.isStringLiteral(name))) {
            if (name.text === 'registerEvent') analysis.report.incompleteEventTypes = true;
            collectMethod(analysis, name, source, name.text);
        } else if (name) collectAllMembers(analysis, type, name, source);
    }
}

function collectAllMembers(analysis: Analysis, type: ts.Type, name: ts.Node, receiver: ts.Node): void {
    if (isUntyped(type)) {
        if (!ts.isElementAccessExpression(name.parent) || isUnknownDynamicHostCall(analysis, name.parent))
            analysis.report.incomplete = true;
        return;
    }
    if (type.isUnionOrIntersection()) {
        for (const member of type.types) collectAllMembers(analysis, member, name, receiver);
        return;
    }
    for (const member of analysis.checker.getPropertiesOfType(type))
        collectMethod(analysis, name, receiver, member.name);
}

function collectMethod(analysis: Analysis, name: ts.Node, receiver?: ts.Node, memberName?: string): void {
    const { checker } = analysis;
    const symbol = checker.getSymbolAtLocation(name);
    const declarations = new Set(symbol ? (resolveAlias(checker, symbol).declarations ?? []) : []);
    if (receiver && memberName) {
        const receiverType = checker.getTypeAtLocation(receiver);
        const members = new Set<ts.Declaration>();
        collectInheritedMethodDeclarations(checker, receiverType, memberName, members);
        // Compiled dependency parameters lose their TypeScript resource types, and JavaScript
        // infers types such as rest objects without the members code reads from them. Keep every
        // matching WIT operation rather than mistaking an unresolved member for unused code.
        if (isUntyped(receiverType) || (members.size === 0 && /\.[cm]?jsx?$/.test(receiver.getSourceFile().fileName))) {
            for (const declaration of analysis.witDeclarations.get(memberName) ?? []) members.add(declaration);
        }
        for (const member of members) declarations.add(member);
    }
    for (const declaration of declarations) analysis.report.addOperation(declaration);
}

function collectInheritedMethodDeclarations(
    checker: ts.TypeChecker,
    type: ts.Type,
    memberName: string,
    declarations: Set<ts.Declaration>,
    visited = new Set<ts.Type>(),
): void {
    if (visited.has(type)) return;
    visited.add(type);

    if (type.isUnionOrIntersection()) {
        for (const member of type.types)
            collectInheritedMethodDeclarations(checker, member, memberName, declarations, visited);
    }

    for (const declaration of checker.getPropertyOfType(type, memberName)?.declarations ?? [])
        declarations.add(declaration);

    if ((type.flags & ts.TypeFlags.Object) === 0) return;
    const objectType = type as ts.ObjectType;
    if ((objectType.objectFlags & ts.ObjectFlags.Interface) === 0) return;
    for (const base of checker.getBaseTypes(objectType as ts.InterfaceType))
        collectInheritedMethodDeclarations(checker, base, memberName, declarations, visited);
}

/**
 * Finds destructuring assignments whose members the analysis does not follow: object patterns
 * nested in an array assignment or used as a for-of or for-in target.
 */
function isUnsupportedDestructuringTarget(node: ts.Node): boolean {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        return ts.isArrayLiteralExpression(node.left) && containsAssignmentPattern(node.left);
    }
    if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
        return ts.isExpression(node.initializer) && containsAssignmentPattern(node.initializer);
    }
    return false;
}

function containsAssignmentPattern(node: ts.Node): boolean {
    if (ts.isObjectLiteralExpression(node)) return true;
    return ts.forEachChild(node, containsAssignmentPattern) ?? false;
}
