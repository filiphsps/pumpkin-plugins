import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

/** Find calls to Pumpkin resource methods in the plugin's typed source graph. */
export function findUsedPumpkinWitMethods(entry: string, additionalTypesDir?: string): string[] | undefined {
    return findUsedWitMethods(entry, additionalTypesDir)?.pumpkinMethods;
}

/** Find calls to WASI functions and resource methods in the plugin's typed source graph. */
export function findUsedWasiWitMethods(entry: string, additionalTypesDir?: string): string[] | undefined {
    return findUsedWitMethods(entry, additionalTypesDir)?.wasiMethods;
}

/** Find calls declared by either the Pumpkin or WASI WIT bindings. */
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
    const program = ts.createProgram([...new Set([...parsed.fileNames, ...additionalTypeFiles])], parsed.options);
    const checker = program.getTypeChecker();
    const pumpkinMethods = new Set<string>();
    const wasiMethods = new Set<string>();
    for (const source of program.getSourceFiles()) {
        if (!isPluginSource(source)) continue;
        visit(source);
    }
    return {
        pumpkinMethods: [...pumpkinMethods].sort(),
        wasiMethods: [...wasiMethods].sort()
    };

    function visit(node: ts.Node): void {
        if (ts.isCallExpression(node)) {
            if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.name))
                collectMethod(node.expression.name, node.expression.expression);
            else if (ts.isIdentifier(node.expression)) collectMethod(node.expression);
        }
        if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) collectConstructor(node.expression);
        ts.forEachChild(node, visit);
    }

    function collectMethod(name: ts.Identifier, receiver?: ts.Expression): void {
        const symbol = checker.getSymbolAtLocation(name);
        const resolvedSymbol =
            symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
        const declarations = new Set(resolvedSymbol?.declarations ?? []);
        if (receiver) collectInheritedMethodDeclarations(checker.getTypeAtLocation(receiver), name.text, declarations);
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

    function collectConstructor(name: ts.Identifier): void {
        const symbol = checker.getSymbolAtLocation(name);
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
    if (source.isDeclarationFile || /\.(?:test|spec)\.[cm]?tsx?$/.test(source.fileName)) return false;
    const normalized = source.fileName.split(path.sep).join('/');
    return !normalized.split('/').includes('test');
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
