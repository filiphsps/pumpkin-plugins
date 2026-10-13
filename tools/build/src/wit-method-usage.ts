import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

/** Select referenced Pumpkin operations, or retain full adapters when analysis is incomplete. */
export function findUsedPumpkinWitMethods(entry: string, additionalTypesDir?: string): string[] | undefined {
    return findUsedWitMethods(entry, additionalTypesDir)?.pumpkinMethods;
}

/** Select referenced WASI operations, or retain full adapters when analysis is incomplete. */
export function findUsedWasiWitMethods(entry: string, additionalTypesDir?: string): string[] | undefined {
    return findUsedWitMethods(entry, additionalTypesDir)?.wasiMethods;
}

/**
 * Select WIT operations referenced by the plugin and its typed dependencies.
 *
 * Dynamic keys retain every possible member. Declaration-only runtime dependencies cannot
 * reveal their host calls, so they return `undefined` to request full native adapters.
 */
export function findUsedWitMethods(
    entry: string,
    additionalTypesDir?: string
): { pumpkinMethods: string[]; wasiMethods: string[] } | undefined {
    const absoluteEntry = path.resolve(entry);
    if (!fs.existsSync(absoluteEntry)) return undefined;
    const configPath = ts.findConfigFile(path.dirname(absoluteEntry), ts.sys.fileExists, 'tsconfig.json');
    if (!configPath) return undefined;

    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
    if (parsed.errors.length) {
        throw new Error(
            parsed.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n')
        );
    }

    const additionalTypeFiles = additionalTypesDir
        ? ts.sys.readDirectory(additionalTypesDir, ['.d.ts'], undefined, ['**/*.d.ts'])
        : [];
    const options = { ...parsed.options, allowJs: true, maxNodeModuleJsDepth: 100 };
    const implementationFiles = new Set<string>();
    const runtimeHost: ts.ModuleResolutionHost = {
        ...ts.sys,
        fileExists: (fileName) => !/\.d\.[cm]?ts$/.test(fileName) && ts.sys.fileExists(fileName)
    };
    let incomplete = false;
    collectImplementations(absoluteEntry);
    const program = ts.createProgram(
        [
            ...new Set([
                ...implementationFiles,
                ...parsed.fileNames.filter((fileName) => /\.d\.[cm]?ts$/.test(fileName)),
                ...additionalTypeFiles
            ])
        ],
        options
    );
    const checker = program.getTypeChecker();
    const hostModules = new Set<string>();
    for (const module of checker.getAmbientModules()) {
        for (const declaration of module.declarations ?? []) {
            if (ts.isModuleDeclaration(declaration) && ts.isStringLiteral(declaration.name))
                hostModules.add(declaration.name.text);
        }
    }
    const pumpkinMethods = new Set<string>();
    const wasiMethods = new Set<string>();
    const witDeclarations = new Map<string, ts.Declaration[]>();
    for (const source of program.getSourceFiles()) {
        if (!pumpkinInterfaceName(source.fileName) && !wasiModuleSpecifier(source)) continue;
        indexDeclarations(source);
    }
    for (const source of program.getSourceFiles()) {
        if (!isPluginSource(source)) continue;
        visit(source);
    }
    if (incomplete) return undefined;
    return {
        pumpkinMethods: [...pumpkinMethods].sort(),
        wasiMethods: [...wasiMethods].sort()
    };

    function indexDeclarations(node: ts.Node): void {
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
    }

    function collectImplementations(fileName: string): void {
        if (implementationFiles.has(fileName)) return;
        implementationFiles.add(fileName);
        const content = ts.sys.readFile(fileName);
        if (content === undefined) {
            incomplete = true;
            return;
        }
        const source = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
        inspect(source);

        function inspect(node: ts.Node): void {
            let specifier: ts.Expression | undefined;
            if (ts.isImportDeclaration(node)) {
                const clause = node.importClause;
                if (clause?.isTypeOnly) return;
                if (
                    clause?.namedBindings &&
                    ts.isNamedImports(clause.namedBindings) &&
                    !clause.name &&
                    clause.namedBindings.elements.length > 0 &&
                    clause.namedBindings.elements.every((item) => item.isTypeOnly)
                )
                    return;
                specifier = node.moduleSpecifier;
            } else if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
                if (
                    node.exportClause &&
                    ts.isNamedExports(node.exportClause) &&
                    node.exportClause.elements.length > 0 &&
                    node.exportClause.elements.every((item) => item.isTypeOnly)
                )
                    return;
                specifier = node.moduleSpecifier;
            } else if (
                ts.isCallExpression(node) &&
                (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                    (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
            ) {
                specifier = node.arguments[0];
                if (!specifier || !ts.isStringLiteralLike(specifier)) incomplete = true;
            }
            if (specifier && ts.isStringLiteralLike(specifier) && !/^(?:pumpkin:|wasi:|node:)/.test(specifier.text)) {
                const resolution = ts.resolveModuleName(specifier.text, fileName, options, runtimeHost).resolvedModule;
                if (resolution && !/\.d\.[cm]?ts$/.test(resolution.resolvedFileName))
                    collectImplementations(resolution.resolvedFileName);
                else {
                    const declaration = ts.resolveModuleName(specifier.text, fileName, options, ts.sys).resolvedModule;
                    if (!declaration || !pumpkinInterfaceName(declaration.resolvedFileName)) incomplete = true;
                }
            }
            ts.forEachChild(node, inspect);
        }
    }

    function visit(node: ts.Node): void {
        const moduleSpecifier = runtimeModuleSpecifier(node);
        if (
            moduleSpecifier &&
            ts.isStringLiteralLike(moduleSpecifier) &&
            /^(?:pumpkin:|wasi:)/.test(moduleSpecifier.text) &&
            !hostModules.has(moduleSpecifier.text) &&
            !ts.resolveModuleName(moduleSpecifier.text, moduleSpecifier.getSourceFile().fileName, options, ts.sys)
                .resolvedModule
        ) {
            incomplete = true;
        }

        if (ts.isPropertyAccessExpression(node)) collectMethod(node.name, node.expression, node.name.text);
        else if (ts.isElementAccessExpression(node)) {
            const keyType = checker.getTypeAtLocation(node.argumentExpression);
            const keys = keyType.isUnion() ? keyType.types : [keyType];
            if (keys.every((key) => key.isStringLiteral())) {
                for (const key of keys) {
                    if (key.isStringLiteral()) collectMethod(node.argumentExpression, node.expression, key.value);
                }
            } else {
                collectAllMembers(checker.getTypeAtLocation(node.expression), node.argumentExpression, node.expression);
            }
        } else if (ts.isIdentifier(node)) collectMethod(node);
        if (ts.isNewExpression(node)) collectConstructor(node.expression);
        if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
            for (const binding of node.name.elements) {
                if (binding.dotDotDotToken) {
                    collectAllMembers(checker.getTypeAtLocation(node.initializer), binding.name, node.initializer);
                    continue;
                }
                const name = binding.propertyName ?? binding.name;
                if (ts.isIdentifier(name) || ts.isStringLiteral(name)) collectMethod(name, node.initializer, name.text);
                else collectAllMembers(checker.getTypeAtLocation(node.initializer), name, node.initializer);
            }
        }
        ts.forEachChild(node, visit);
    }

    function runtimeModuleSpecifier(node: ts.Node): ts.Expression | undefined {
        if (ts.isImportDeclaration(node)) {
            const clause = node.importClause;
            if (
                clause?.isTypeOnly ||
                (clause?.namedBindings &&
                    ts.isNamedImports(clause.namedBindings) &&
                    !clause.name &&
                    clause.namedBindings.elements.length > 0 &&
                    clause.namedBindings.elements.every((item) => item.isTypeOnly))
            )
                return undefined;
            return node.moduleSpecifier;
        }
        if (ts.isExportDeclaration(node)) {
            if (
                node.isTypeOnly ||
                (node.exportClause &&
                    ts.isNamedExports(node.exportClause) &&
                    node.exportClause.elements.length > 0 &&
                    node.exportClause.elements.every((item) => item.isTypeOnly))
            )
                return undefined;
            return node.moduleSpecifier;
        }
        if (
            ts.isCallExpression(node) &&
            (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
        )
            return node.arguments[0];
        return undefined;
    }

    function collectAllMembers(type: ts.Type, name: ts.Node, receiver: ts.Expression): void {
        if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
            incomplete = true;
            return;
        }
        if (type.isUnionOrIntersection()) {
            for (const member of type.types) collectAllMembers(member, name, receiver);
            return;
        }
        for (const member of checker.getPropertiesOfType(type)) collectMethod(name, receiver, member.name);
    }

    function collectMethod(name: ts.Node, receiver?: ts.Expression, memberName?: string): void {
        const symbol = checker.getSymbolAtLocation(name);
        const resolvedSymbol =
            symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
        const declarations = new Set(resolvedSymbol?.declarations ?? []);
        if (receiver && memberName) {
            const receiverType = checker.getTypeAtLocation(receiver);
            collectInheritedMethodDeclarations(receiverType, memberName, declarations);
            // Compiled dependency parameters lose their TypeScript resource types. Keep every
            // matching WIT operation rather than mistaking an unresolved member for unused code.
            if (receiverType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
                for (const declaration of witDeclarations.get(memberName) ?? []) declarations.add(declaration);
            }
        }
        for (const declaration of declarations) collectWitMethod(declaration);
    }

    function collectInheritedMethodDeclarations(
        type: ts.Type,
        memberName: string,
        declarations: Set<ts.Declaration>,
        visited = new Set<ts.Type>()
    ): void {
        if (visited.has(type)) return;
        visited.add(type);

        if (type.isUnionOrIntersection()) {
            for (const member of type.types)
                collectInheritedMethodDeclarations(member, memberName, declarations, visited);
        }

        for (const declaration of checker.getPropertyOfType(type, memberName)?.declarations ?? [])
            declarations.add(declaration);

        if ((type.flags & ts.TypeFlags.Object) === 0) return;
        const objectType = type as ts.ObjectType;
        if ((objectType.objectFlags & ts.ObjectFlags.Interface) === 0) return;
        for (const base of checker.getBaseTypes(objectType as ts.InterfaceType))
            collectInheritedMethodDeclarations(base, memberName, declarations, visited);
    }

    function collectWitMethod(declaration: ts.Declaration): void {
        const source = declaration.getSourceFile();
        const wasiSpecifier = wasiModuleSpecifier(source);
        if (wasiSpecifier) {
            collectWasiMethod(wasiSpecifier, declaration);
            return;
        }
        const interfaceName = pumpkinInterfaceName(source.fileName);
        if (!interfaceName) return;
        if (ts.isFunctionDeclaration(declaration)) {
            const declarationName = declaration.name;
            if (!declarationName || !ts.isIdentifier(declarationName)) return;
            pumpkinMethods.add(`${interfaceName}.${toWitName(declarationName.text)}`);
            return;
        }
        if (!ts.isMethodDeclaration(declaration) && !ts.isMethodSignature(declaration)) return;
        const declarationName = declaration.name;
        if (!ts.isIdentifier(declarationName)) return;
        const parent = declaration.parent;
        if (!ts.isClassDeclaration(parent) && !ts.isClassExpression(parent) && !ts.isInterfaceDeclaration(parent))
            return;
        const resourceName = parent.name;
        if (!resourceName || !ts.isIdentifier(resourceName)) return;
        pumpkinMethods.add(`${interfaceName}.${toWitName(resourceName.text)}.${toWitName(declarationName.text)}`);
    }

    function collectConstructor(expression: ts.Expression): void {
        const name = ts.isPropertyAccessExpression(expression) ? expression.name : expression;
        const symbol = checker.getSymbolAtLocation(name) ?? checker.getTypeAtLocation(expression).getSymbol();
        const resolvedSymbol =
            symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
        for (const declaration of resolvedSymbol?.declarations ?? []) {
            if (!ts.isClassDeclaration(declaration) && !ts.isClassExpression(declaration)) continue;
            const wasiSpecifier = wasiModuleSpecifier(declaration.getSourceFile());
            if (!declaration.name) continue;
            if (wasiSpecifier) {
                wasiMethods.add(`${wasiSpecifier}#${toWitName(declaration.name.text)}.constructor`);
                continue;
            }
            const interfaceName = pumpkinInterfaceName(declaration.getSourceFile().fileName);
            if (interfaceName) pumpkinMethods.add(`${interfaceName}.${toWitName(declaration.name.text)}.constructor`);
        }
    }

    function collectWasiMethod(specifier: string, declaration: ts.Declaration): void {
        if (ts.isFunctionDeclaration(declaration) && declaration.name) {
            wasiMethods.add(`${specifier}#${toWitName(declaration.name.text)}`);
            return;
        }
        if (!ts.isMethodDeclaration(declaration) && !ts.isMethodSignature(declaration)) return;
        const memberName = declaration.name;
        const resource = declaration.parent;
        if (!memberName || !ts.isIdentifier(memberName)) return;
        if (!ts.isClassDeclaration(resource) && !ts.isClassExpression(resource) && !ts.isInterfaceDeclaration(resource))
            return;
        if (!resource.name) return;
        wasiMethods.add(`${specifier}#${toWitName(resource.name.text)}.${toWitName(memberName.text)}`);
    }
}

function isPluginSource(source: ts.SourceFile): boolean {
    return !source.isDeclarationFile && !/\.(?:test|spec)\.[cm]?tsx?$/.test(source.fileName);
}

function pumpkinInterfaceName(fileName: string): string | undefined {
    return /(?:^|[/\\])interfaces[/\\]pumpkin-plugin-([\w-]+)\.d\.ts$/.exec(fileName)?.[1];
}

function wasiModuleSpecifier(source: ts.SourceFile): string | undefined {
    for (const statement of source.statements) {
        if (
            ts.isModuleDeclaration(statement) &&
            ts.isStringLiteral(statement.name) &&
            statement.name.text.startsWith('wasi:')
        )
            return statement.name.text;
    }
    return undefined;
}

function toWitName(name: string): string {
    return name
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
        .replace(/([a-z\d])([A-Z])/g, '$1-$2')
        .toLowerCase();
}
