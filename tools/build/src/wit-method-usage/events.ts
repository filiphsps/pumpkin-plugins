import * as ts from 'typescript';
import { type Analysis, isUnknownDynamicHostCall, isUntyped, literalKeys } from './analysis.ts';

/**
 * Records the event types that one node of plugin code registers with a literal name. Marks the
 * event selection incomplete when a registration's event type or target cannot be read statically.
 */
export function trackEventRegistration(analysis: Analysis, node: ts.Node): void {
    const { checker, report } = analysis;
    if (ts.isCallExpression(node) && registerEventMember(checker, node.expression) === 'registerEvent') {
        if (!isPluginEventForwarder(checker, node)) collectRegisteredEventType(analysis, node);
    } else if (
        (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
        registerEventMember(checker, node) === 'registerEvent' &&
        !(ts.isCallExpression(node.parent) && node.parent.expression === node)
    ) {
        report.incompleteEventTypes = true;
    }
    if (
        ts.isElementAccessExpression(node) &&
        mayNameRegisterEvent(checker, node) &&
        isUnknownDynamicHostCall(analysis, node)
    ) {
        report.incompleteEventTypes = true;
    }
}

function registerEventMember(checker: ts.TypeChecker, expression: ts.Expression): string | undefined {
    if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
    if (ts.isElementAccessExpression(expression) && expression.argumentExpression) {
        const keyType = checker.getTypeAtLocation(expression.argumentExpression);
        if (keyType.isStringLiteral()) return keyType.value;
    }
    return undefined;
}

/** Checks whether a computed member can be `registerEvent`: a key that may name it, or a receiver that has it. */
function mayNameRegisterEvent(checker: ts.TypeChecker, access: ts.ElementAccessExpression): boolean {
    const keys = literalKeys(checker, access.argumentExpression);
    if (keys) return keys.includes('registerEvent');
    const receiverType = checker.getTypeAtLocation(access.expression);
    return isUntyped(receiverType) || checker.getPropertyOfType(receiverType, 'registerEvent') !== undefined;
}

function collectRegisteredEventType({ checker, report }: Analysis, call: ts.CallExpression): void {
    const eventType = call.arguments[1];
    if (!eventType || ts.isSpreadElement(eventType)) {
        report.incompleteEventTypes = true;
        return;
    }
    const type = checker.getTypeAtLocation(eventType);
    if (!type.isStringLiteral()) {
        report.incompleteEventTypes = true;
        return;
    }
    report.addEventType(type.value);
}

/**
 * Checks whether a call registers through the context parameter of a `Plugin` class's `registerEvent`
 * method, which only forwards registrations made elsewhere.
 */
function isPluginEventForwarder(checker: ts.TypeChecker, call: ts.CallExpression): boolean {
    const access = call.expression;
    if (!ts.isPropertyAccessExpression(access) && !ts.isElementAccessExpression(access)) return false;
    const receiver = access.expression;
    if (!ts.isIdentifier(receiver)) return false;

    for (let parent = call.parent; parent; parent = parent.parent) {
        if (!ts.isMethodDeclaration(parent)) continue;
        const contextParameter = parent.parameters[0]?.name;
        return (
            ts.isIdentifier(parent.name) &&
            parent.name.text === 'registerEvent' &&
            ts.isClassDeclaration(parent.parent) &&
            parent.parent.name?.text === 'Plugin' &&
            contextParameter !== undefined &&
            ts.isIdentifier(contextParameter) &&
            checker.getSymbolAtLocation(receiver) === checker.getSymbolAtLocation(contextParameter)
        );
    }
    return false;
}
