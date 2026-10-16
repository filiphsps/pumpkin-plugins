import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

/** WIT operations and event variants referenced by the plugin implementation. */
export interface UsedWitMethods {
    /** Sorted event names when registrations are static; `undefined` retains every event variant. */
    eventTypes: string[] | undefined;
    /** Sorted Pumpkin API operation identifiers required by the plugin. */
    pumpkinMethods: string[];
    /** Sorted WASI operation identifiers required by the plugin. */
    wasiMethods: string[];
}

/**
 * Finds the Pumpkin host operations referenced by a plugin's TypeScript or JavaScript sources.
 *
 * The returned identifiers can be used to retain only the required Pumpkin native adapters.
 * An `undefined` result means static analysis could not establish the complete set, so callers
 * should retain all Pumpkin adapters.
 *
 * @param entry - Path to the plugin entry file.
 * @param additionalTypesDir - Optional directory of generated declaration files for dependency types.
 * @returns Sorted Pumpkin WIT operation identifiers, or `undefined` when analysis is incomplete.
 */
export function findUsedPumpkinWitMethods(entry: string, additionalTypesDir?: string): string[] | undefined {
    return findUsedWitMethods(entry, additionalTypesDir)?.pumpkinMethods;
}

/**
 * Finds the WASI host operations referenced by a plugin's TypeScript or JavaScript sources.
 *
 * The returned identifiers can be used to retain only the required WASI native adapters.
 * An `undefined` result means static analysis could not establish the complete set, so callers
 * should retain all WASI adapters.
 *
 * @param entry - Path to the plugin entry file.
 * @param additionalTypesDir - Optional directory of generated declaration files for dependency types.
 * @returns Sorted WASI WIT operation identifiers, or `undefined` when analysis is incomplete.
 */
export function findUsedWasiWitMethods(entry: string, additionalTypesDir?: string): string[] | undefined {
    return findUsedWitMethods(entry, additionalTypesDir)?.wasiMethods;
}

/**
 * Select WIT operations referenced by the plugin and its typed dependencies.
 *
 * Dynamic keys retain every possible member. Declaration-only runtime dependencies cannot
 * reveal their host calls, so they return `undefined` to request full native adapters. Dynamic
 * event registrations set `eventTypes` to `undefined` so callers retain every event converter.
 */
export function findUsedWitMethods(entry: string, additionalTypesDir?: string): UsedWitMethods | undefined {
    const absoluteEntry = path.resolve(entry);
    if (!fs.existsSync(absoluteEntry)) return undefined;
    const configPath = ts.findConfigFile(path.dirname(absoluteEntry), ts.sys.fileExists, 'tsconfig.json');
    let parsed: ts.ParsedCommandLine;
    if (configPath) {
        const config = ts.readConfigFile(configPath, ts.sys.readFile);
        if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
        parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
    } else {
        parsed = ts.parseJsonConfigFileContent({}, ts.sys, path.dirname(absoluteEntry));
    }
    if (parsed.errors.length) {
        throw new Error(
            parsed.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'),
        );
    }

    const additionalTypeFiles = additionalTypesDir
        ? ts.sys.readDirectory(additionalTypesDir, ['.d.ts'], undefined, ['**/*.d.ts'])
        : [];
    const options = {
        ...(configPath
            ? {}
            : {
                  target: ts.ScriptTarget.ES2022,
                  module: ts.ModuleKind.ESNext,
                  moduleResolution: ts.ModuleResolutionKind.Bundler,
                  strict: true,
              }),
        ...parsed.options,
        allowJs: true,
        maxNodeModuleJsDepth: 100,
    };
    const implementationFiles = new Set<string>();
    const runtimeHost: ts.ModuleResolutionHost = {
        ...ts.sys,
        fileExists: (fileName) => !/\.d\.[cm]?ts$/.test(fileName) && ts.sys.fileExists(fileName),
    };
    let incomplete = false;
    collectImplementations(absoluteEntry);
    const program = ts.createProgram(
        [
            ...new Set([
                ...implementationFiles,
                ...parsed.fileNames.filter((fileName) => /\.d\.[cm]?ts$/.test(fileName)),
                ...additionalTypeFiles,
            ]),
        ],
        options,
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
    const eventTypes = new Set<string>();
    let incompleteEventTypes = false;
    const witDeclarations = new Map<string, ts.Declaration[]>();
    const calledValues = new Set<ts.Symbol>();
    const constructedValues = new Set<ts.Symbol>();
    let valueUsagesIndexed = false;
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
        wasiMethods: [...wasiMethods].sort(),
        eventTypes: incompleteEventTypes ? undefined : [...eventTypes].sort(),
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

        if (ts.isCallExpression(node) && registerEventMember(node.expression) === 'registerEvent') {
            if (!isPluginEventForwarder(node)) collectRegisteredEventType(node);
        } else if (
            (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
            registerEventMember(node) === 'registerEvent' &&
            !(ts.isCallExpression(node.parent) && node.parent.expression === node) &&
            !isPluginEventForwarder(node)
        ) {
            incompleteEventTypes = true;
        }

        if (ts.isPropertyAccessExpression(node)) collectMethod(node.name, node.expression, node.name.text);
        else if (ts.isElementAccessExpression(node)) {
            const keyType = checker.getTypeAtLocation(node.argumentExpression);
            const keys = keyType.isUnion() ? keyType.types : [keyType];
            if (keys.every((key) => key.isStringLiteral())) {
                if (
                    keys.some((key) => key.isStringLiteral() && key.value === 'registerEvent') &&
                    isUnknownDynamicHostCall(node)
                ) {
                    incompleteEventTypes = true;
                }
                for (const key of keys) {
                    if (key.isStringLiteral()) collectMethod(node.argumentExpression, node.expression, key.value);
                }
            } else {
                const receiverType = checker.getTypeAtLocation(node.expression);
                if (
                    (receiverType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown) ||
                        checker.getPropertyOfType(receiverType, 'registerEvent')) &&
                    isUnknownDynamicHostCall(node)
                ) {
                    incompleteEventTypes = true;
                }
                collectAllMembers(receiverType, node.argumentExpression, node.expression);
            }
        } else if (ts.isIdentifier(node)) collectMethod(node);
        if (ts.isNewExpression(node)) collectConstructor(node.expression);
        if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) collectReferencedWitConstructor(node);
        if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
            for (const binding of node.name.elements) {
                if (binding.dotDotDotToken) {
                    collectAllMembers(checker.getTypeAtLocation(node.initializer), binding.name, node.initializer);
                    continue;
                }
                const name = binding.propertyName ?? binding.name;
                if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
                    if (name.text === 'registerEvent') incompleteEventTypes = true;
                    collectMethod(name, node.initializer, name.text);
                } else collectAllMembers(checker.getTypeAtLocation(node.initializer), name, node.initializer);
            }
        }
        ts.forEachChild(node, visit);
    }

    function registerEventMember(expression: ts.Expression): string | undefined {
        if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
        if (ts.isElementAccessExpression(expression) && expression.argumentExpression) {
            const keyType = checker.getTypeAtLocation(expression.argumentExpression);
            if (keyType.isStringLiteral()) return keyType.value;
        }
        return undefined;
    }

    function collectRegisteredEventType(call: ts.CallExpression): void {
        const eventType = call.arguments[1];
        if (!eventType || ts.isSpreadElement(eventType)) {
            incompleteEventTypes = true;
            return;
        }
        const type = checker.getTypeAtLocation(eventType);
        if (!type.isStringLiteral()) {
            incompleteEventTypes = true;
            return;
        }
        eventTypes.add(type.value);
    }

    function isPluginEventForwarder(node: ts.Node): boolean {
        if (!ts.isCallExpression(node)) return false;
        const access = node.expression;
        if (!ts.isPropertyAccessExpression(access) && !ts.isElementAccessExpression(access)) return false;
        const receiver = access.expression;
        if (!ts.isIdentifier(receiver)) return false;

        for (let parent = node.parent; parent; parent = parent.parent) {
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
            if (!ts.isElementAccessExpression(name.parent) || isUnknownDynamicHostCall(name.parent)) incomplete = true;
            return;
        }
        if (type.isUnionOrIntersection()) {
            for (const member of type.types) collectAllMembers(member, name, receiver);
            return;
        }
        for (const member of checker.getPropertiesOfType(type)) collectMethod(name, receiver, member.name);
    }

    /**
     * Checks whether an untyped computed property is invoked as a method or constructor.
     * Ordinary data indexing in JavaScript dependencies cannot name a WIT operation.
     */
    function isUnknownDynamicHostCall(access: ts.ElementAccessExpression): boolean {
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

        const symbol = checker.getSymbolAtLocation(parent.name);
        if (!symbol) return false;
        indexValueUsages();
        if (calledValues.has(symbol)) return true;
        return constructedValues.has(symbol) && !isRuntimeDependencySource(access.getSourceFile());
    }

    /**
     * Indexes identifiers used as call or constructor targets so computed members can be followed through a local alias.
     */
    function indexValueUsages(): void {
        if (valueUsagesIndexed) return;
        valueUsagesIndexed = true;
        for (const source of program.getSourceFiles()) {
            if (!isPluginSource(source)) continue;
            findUses(source);
        }

        function findUses(node: ts.Node): void {
            if (ts.isCallExpression(node)) {
                const expression = node.expression;
                const target = ts.isPropertyAccessExpression(expression)
                    ? ['apply', 'bind', 'call'].includes(expression.name.text)
                        ? expression.expression
                        : expression
                    : expression;
                if (ts.isIdentifier(target)) {
                    const symbol = checker.getSymbolAtLocation(target);
                    if (symbol) calledValues.add(symbol);
                }
            } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
                const symbol = checker.getSymbolAtLocation(node.expression);
                if (symbol) constructedValues.add(symbol);
            }
            ts.forEachChild(node, findUses);
        }
    }

    /**
     * Retains a host constructor when plugin code passes its class value to a dynamically typed dependency.
     */
    function collectReferencedWitConstructor(expression: ts.Expression): void {
        if (isTypeOnlyReference(expression)) return;
        if (
            ts.isIdentifier(expression) &&
            ts.isPropertyAccessExpression(expression.parent) &&
            expression.parent.expression === expression
        )
            return;
        const symbol =
            ts.isIdentifier(expression) && ts.isShorthandPropertyAssignment(expression.parent)
                ? checker.getShorthandAssignmentValueSymbol(expression.parent)
                : checker.getSymbolAtLocation(expression);
        if (!symbol) return;
        const resolvedSymbol = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
        for (const declaration of resolvedSymbol.declarations ?? []) {
            if (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration))
                collectWitConstructor(declaration);
        }
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
        visited = new Set<ts.Type>(),
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
        const type = checker.getTypeAtLocation(expression);
        const symbol = checker.getSymbolAtLocation(name);
        const symbols = new Set<ts.Symbol>();
        for (const candidate of [symbol, type.getSymbol()]) {
            if (!candidate) continue;
            symbols.add(candidate.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(candidate) : candidate);
        }

        let resolved = false;
        for (const candidate of symbols) {
            for (const declaration of candidate.declarations ?? []) {
                if (!ts.isClassDeclaration(declaration) && !ts.isClassExpression(declaration)) continue;
                collectWitConstructor(declaration);
                resolved = true;
            }
        }

        if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
            if (!isRuntimeDependencySource(expression.getSourceFile())) incomplete = true;
            return;
        }
        if (type.isUnionOrIntersection()) {
            for (const member of type.types)
                resolved = collectConstructorType(member, expression.getSourceFile()) || resolved;
        } else {
            resolved = collectConstructorType(type, expression.getSourceFile()) || resolved;
        }
        if (!resolved) {
            if (!isRuntimeDependencySource(expression.getSourceFile())) incomplete = true;
        }
    }

    function collectConstructorType(type: ts.Type, source: ts.SourceFile, visited = new Set<ts.Type>()): boolean {
        if (visited.has(type)) return true;
        visited.add(type);
        if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
            if (!isRuntimeDependencySource(source)) incomplete = true;
            return false;
        }
        if (type.isUnionOrIntersection()) {
            let resolved = true;
            for (const member of type.types) resolved = collectConstructorType(member, source, visited) && resolved;
            return resolved;
        }

        let resolved = false;
        let classResolved = false;
        const symbol = type.getSymbol();
        if (symbol) {
            const candidate = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
            for (const declaration of candidate.declarations ?? []) {
                if (!ts.isClassDeclaration(declaration) && !ts.isClassExpression(declaration)) continue;
                collectWitConstructor(declaration);
                resolved = true;
                classResolved = true;
            }
        }

        const signatures = checker.getSignaturesOfType(type, ts.SignatureKind.Construct);
        if (signatures.length > 0) {
            let signaturesResolved = true;
            for (const signature of signatures) {
                const declaration = signature.getDeclaration();
                const parent = declaration?.parent;
                if (parent && (ts.isClassDeclaration(parent) || ts.isClassExpression(parent))) {
                    collectWitConstructor(parent);
                    continue;
                }
                if (classResolved) continue;
                if (declaration && isKnownNonHostConstructor(declaration)) continue;
                signaturesResolved = false;
            }
            if (!signaturesResolved) incomplete = true;
            resolved = signaturesResolved || resolved;
        }
        return resolved;
    }

    function collectWitConstructor(declaration: ts.ClassDeclaration | ts.ClassExpression): void {
        if (!declaration.name) return;
        const wasiSpecifier = wasiModuleSpecifier(declaration.getSourceFile());
        if (wasiSpecifier) {
            wasiMethods.add(`${wasiSpecifier}#${toWitName(declaration.name.text)}.constructor`);
            return;
        }
        const interfaceName = pumpkinInterfaceName(declaration.getSourceFile().fileName);
        if (interfaceName) pumpkinMethods.add(`${interfaceName}.${toWitName(declaration.name.text)}.constructor`);
    }

    function isKnownNonHostConstructor(declaration: ts.SignatureDeclaration): boolean {
        const source = declaration.getSourceFile();
        if (/[/\\]lib\.[^/\\]+\.d\.ts$/.test(source.fileName)) return true;
        return (
            !source.isDeclarationFile && (ts.isFunctionDeclaration(declaration) || ts.isFunctionExpression(declaration))
        );
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

/**
 * Identifies installed dependency implementations whose generic JavaScript constructs are not statically typed.
 */
function isRuntimeDependencySource(source: ts.SourceFile): boolean {
    return /(?:^|[/\\])node_modules[/\\]/.test(source.fileName);
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
