import * as ts from 'typescript';
import { isWitDeclarationFile, type WitUsageReport } from './report.ts';

/** State shared by the checks of one analysis run. */
export interface Analysis {
    readonly checker: ts.TypeChecker;
    readonly report: WitUsageReport;
    /** Returns the symbols plugin code calls or constructs, indexed on first use. */
    valueUsages(): ValueUsages;
    /** Generated WIT functions and methods by jco name, for members read from values without types. */
    readonly witDeclarations: ReadonlyMap<string, readonly ts.Declaration[]>;
}

/** Symbols that plugin code uses as call or constructor targets. */
interface ValueUsages {
    called: Set<ts.Symbol>;
    constructed: Set<ts.Symbol>;
}

/**
 * Prepares the state for analyzing `pluginSources`, including an index of the generated WIT
 * declarations in `program`.
 */
export function createAnalysis(
    program: ts.Program,
    pluginSources: readonly ts.SourceFile[],
    report: WitUsageReport,
): Analysis {
    const checker = program.getTypeChecker();
    const witDeclarations = new Map<string, ts.Declaration[]>();
    const indexDeclarations = (node: ts.Node): void => {
        if (
            (ts.isMethodDeclaration(node) || ts.isMethodSignature(node) || ts.isFunctionDeclaration(node)) &&
            node.name &&
            ts.isIdentifier(node.name)
        ) {
            const declarations = witDeclarations.get(node.name.text) ?? [];
            declarations.push(node);
            witDeclarations.set(node.name.text, declarations);
        }
        ts.forEachChild(node, indexDeclarations);
    };
    for (const source of program.getSourceFiles()) if (isWitDeclarationFile(source)) indexDeclarations(source);
    let valueUsages: ValueUsages | undefined;
    return {
        checker,
        report,
        witDeclarations,
        valueUsages: () => (valueUsages ??= indexValueUsages(checker, pluginSources)),
    };
}

/** Returns the string values a computed key can take, or `undefined` when one of them isn't a string literal. */
export function literalKeys(checker: ts.TypeChecker, key: ts.Expression): string[] | undefined {
    const keyType = checker.getTypeAtLocation(key);
    const keys = keyType.isUnion() ? keyType.types : [keyType];
    if (!keys.every((type): type is ts.StringLiteralType => type.isStringLiteral())) return undefined;
    return keys.map((type) => type.value);
}

/** Checks whether a type is `any` or `unknown`, so it cannot tell which members exist. */
export function isUntyped(type: ts.Type): boolean {
    return (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
}

/**
 * Identifies installed dependency implementations whose generic JavaScript constructs are not statically typed.
 */
export function isRuntimeDependencySource(source: ts.SourceFile): boolean {
    return /(?:^|[/\\])node_modules[/\\]/.test(source.fileName);
}

/**
 * Checks whether an untyped computed property is invoked as a method or constructor.
 * Ordinary data indexing in JavaScript dependencies cannot name a WIT operation.
 */
export function isUnknownDynamicHostCall(analysis: Analysis, access: ts.ElementAccessExpression): boolean {
    let expression: ts.Expression = access;
    while (
        ts.isParenthesizedExpression(expression.parent) ||
        ts.isAsExpression(expression.parent) ||
        ts.isTypeAssertionExpression(expression.parent) ||
        ts.isNonNullExpression(expression.parent) ||
        ts.isSatisfiesExpression(expression.parent)
    ) {
        expression = expression.parent;
    }

    const parent = expression.parent;
    if (ts.isCallExpression(parent) && parent.expression === expression) return true;
    if (ts.isNewExpression(parent) && parent.expression === expression)
        return !isRuntimeDependencySource(access.getSourceFile());
    if (
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === expression &&
        ['apply', 'bind', 'call'].includes(parent.name.text) &&
        ts.isCallExpression(parent.parent) &&
        parent.parent.expression === parent
    )
        return true;
    if (!ts.isVariableDeclaration(parent) || parent.initializer !== expression || !ts.isIdentifier(parent.name))
        return false;

    const symbol = analysis.checker.getSymbolAtLocation(parent.name);
    if (!symbol) return false;
    const { called, constructed } = analysis.valueUsages();
    if (called.has(symbol)) return true;
    return constructed.has(symbol) && !isRuntimeDependencySource(access.getSourceFile());
}

/**
 * Indexes identifiers used as call or constructor targets so computed members can be followed through a local alias.
 */
function indexValueUsages(checker: ts.TypeChecker, pluginSources: readonly ts.SourceFile[]): ValueUsages {
    const usages: ValueUsages = { called: new Set(), constructed: new Set() };
    const findUses = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
            const expression = node.expression;
            const target = ts.isPropertyAccessExpression(expression)
                ? ['apply', 'bind', 'call'].includes(expression.name.text)
                    ? expression.expression
                    : expression
                : expression;
            if (ts.isIdentifier(target)) {
                const symbol = checker.getSymbolAtLocation(target);
                if (symbol) usages.called.add(symbol);
            }
        } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
            const symbol = checker.getSymbolAtLocation(node.expression);
            if (symbol) usages.constructed.add(symbol);
        }
        ts.forEachChild(node, findUses);
    };
    for (const source of pluginSources) findUses(source);
    return usages;
}
