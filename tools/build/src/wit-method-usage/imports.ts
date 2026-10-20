import * as ts from 'typescript';

/**
 * Returns a check for runtime imports, re-exports and module calls that load code the analysis
 * cannot see: a computed specifier, or Pumpkin or WASI bindings that neither resolve to a file nor
 * match an ambient module declaration.
 */
export function createUnseenImportCheck(program: ts.Program): (node: ts.Node) => boolean {
    const ambientModules = new Set<string>();
    for (const module of program.getTypeChecker().getAmbientModules()) {
        for (const declaration of module.declarations ?? []) {
            if (ts.isModuleDeclaration(declaration) && ts.isStringLiteral(declaration.name))
                ambientModules.add(declaration.name.text);
        }
    }
    const options = program.getCompilerOptions();
    return (node) => {
        const specifier = runtimeModuleSpecifier(node);
        // A computed import or require can load code that the analysis cannot see.
        if (!specifier || !ts.isStringLiteralLike(specifier)) return isModuleCall(node);
        return (
            /^(?:pumpkin:|wasi:)/.test(specifier.text) &&
            !ambientModules.has(specifier.text) &&
            !ts.resolveModuleName(specifier.text, specifier.getSourceFile().fileName, options, ts.sys).resolvedModule
        );
    };
}

/** Follows an import or export alias to the symbol it names; returns other symbols unchanged. */
export function resolveAlias(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
    return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function runtimeModuleSpecifier(node: ts.Node): ts.Expression | undefined {
    if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        if (
            clause?.isTypeOnly ||
            (clause?.namedBindings &&
                ts.isNamedImports(clause.namedBindings) &&
                !clause.name &&
                onlyTypes(clause.namedBindings.elements))
        )
            return undefined;
        return node.moduleSpecifier;
    }
    if (ts.isExportDeclaration(node)) {
        const clause = node.exportClause;
        if (node.isTypeOnly || (clause && ts.isNamedExports(clause) && onlyTypes(clause.elements))) return undefined;
        return node.moduleSpecifier;
    }
    if (isModuleCall(node)) return node.arguments[0];
    return undefined;
}

/** Checks whether a named import or export list names only types, so it loads nothing at runtime. */
function onlyTypes(elements: readonly (ts.ImportSpecifier | ts.ExportSpecifier)[]): boolean {
    return elements.length > 0 && elements.every((element) => element.isTypeOnly);
}

function isModuleCall(node: ts.Node): node is ts.CallExpression {
    return (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    );
}
