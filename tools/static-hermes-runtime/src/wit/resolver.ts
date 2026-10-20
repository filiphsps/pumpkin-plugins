import type {
    WitToolsDocument,
    WitToolsFunction,
    WitToolsInterface,
    WitToolsPackage,
    WitToolsTypeDefinition,
    WitToolsTypeReference,
    WitToolsWorld,
} from './model.ts';
import type { InterfaceDeclarationOrder } from './parser.ts';
import type {
    ResolvedWitType,
    WitApiInterface,
    WitApiPackage,
    WitDependencyAlias,
    WitEnum,
    WitFunction,
    WitRecord,
    WitResource,
    WitTypeAlias,
    WitVariant,
    WitWasiInterface,
} from './types.ts';

/** A resolved package with its worlds and an index of interfaces by name. */
export interface ResolvedWitPackage extends WitApiPackage {
    /** Lookup of the package's interfaces by short name. */
    interfacesByName: Map<string, WitApiInterface>;
    /** Resolved worlds declared by this package. */
    worlds: WitToolsWorld[];
}

/** Normalized WIT package graph together with the wasm-tools source document. */
export interface ResolvedWitDocument {
    /** Resolved interfaces in wasm-tools document order. */
    interfaces: WitApiInterface[];
    /** Resolved packages with their declared worlds and interface lookup maps. */
    packages: ResolvedWitPackage[];
    /** Original wasm-tools document retained for table-index lookups. */
    raw: WitToolsDocument;
}

interface PackageIdentity {
    name: string;
    version: string | undefined;
}

interface ResolutionContext {
    declarationOrder: ReadonlyMap<string, InterfaceDeclarationOrder>;
    document: WitToolsDocument;
    interfaces: WitToolsInterface[];
    interfaceTypes: Map<number, Map<string, number>>;
    packageNames: PackageIdentity[];
    typeNames: Map<number, string>;
}

/**
 * Resolve wasm-tools' index graph into package, dependency, operation, and type models.
 *
 * @param document - Validated tables from `wasm-tools component wit --json`.
 * @param declarationOrder - Optional source declaration order lost from resolved JSON maps.
 * @returns The normalized graph and original document for later lookups.
 */
export function resolveWitDocument(
    document: WitToolsDocument,
    declarationOrder: ReadonlyMap<string, InterfaceDeclarationOrder> = new Map(),
): ResolvedWitDocument {
    const packageNames = document.packages.map(parsePackageIdentity);
    const context: ResolutionContext = {
        document,
        interfaces: document.interfaces,
        packageNames,
        declarationOrder,
        interfaceTypes: new Map(
            document.interfaces.map((entry, index) => [index, new Map(Object.entries(entry.types))]),
        ),
        typeNames: new Map(),
    };
    // A type declared by an interface keeps its own name; any other type takes its first alias.
    for (const iface of document.interfaces) {
        for (const [name, typeIndex] of Object.entries(iface.types)) {
            if (!context.typeNames.has(typeIndex)) context.typeNames.set(typeIndex, name);
        }
    }
    for (const [typeIndex, type] of document.types.entries()) {
        if (type.owner && 'interface' in type.owner && type.name) context.typeNames.set(typeIndex, type.name);
    }

    const resolvedInterfaces = document.interfaces.map((iface, index) =>
        resolveInterface(context, iface, index, declarationOrder),
    );
    const packages = document.packages.map((entry, packageIndex): ResolvedWitPackage => {
        const identity = requireValue(packageNames[packageIndex], `package identity ${packageIndex}`);
        const packageInterfaces = Object.entries(entry.interfaces).map(([, interfaceIndex]) =>
            requireValue(resolvedInterfaces[interfaceIndex], `interface ${interfaceIndex}`),
        );
        const worlds = Object.entries(entry.worlds).map(([, worldIndex]) =>
            requireValue(document.worlds[worldIndex], `world ${worldIndex}`),
        );
        const interfacesByName = new Map(packageInterfaces.map((iface) => [iface.name, iface]));
        return {
            packageName: identity.name,
            version: identity.version,
            interfaces: packageInterfaces,
            worlds,
            interfacesByName,
        };
    });

    return { packages, interfaces: resolvedInterfaces, raw: document };
}

/**
 * Select the package imported by a plugin world and its transitive Pumpkin interfaces.
 *
 * @param resolved - Normalized package graph containing the `plugin` world.
 * @param importOrder - Optional source import order used to keep output deterministic.
 * @returns The plugin package identity and imported Pumpkin interface closure.
 */
export function resolvePluginApi(resolved: ResolvedWitDocument, importOrder?: readonly string[]): WitApiPackage {
    const plugin = resolved.raw.worlds.find((world) => world.name === 'plugin');
    if (!plugin) throw new Error('Prepared WIT document has no plugin world');
    const rootIdentity = resolved.packages[plugin.package];
    if (!rootIdentity) throw new Error(`Plugin world package index ${plugin.package} is missing`);
    const rootPackage = resolved.raw.packages[plugin.package];
    const importedInterfaces = importOrder
        ? importOrder
              .filter((name) => !name.startsWith('wasi:'))
              .map((name) => {
                  const index = rootPackage?.interfaces[name];
                  if (index === undefined) throw new Error(`plugin.wit imports unknown Pumpkin interface ${name}`);
                  return index;
              })
        : Object.values(plugin.imports)
              .filter((entry): entry is { interface: { id: number } } => 'interface' in entry)
              .map(({ interface: imported }) => imported.id)
              .filter(
                  (interfaceIndex) =>
                      !resolved.packages[resolved.raw.interfaces[interfaceIndex]?.package]?.packageName.startsWith(
                          'wasi:',
                      ),
              );
    const visited = new Set<number>();
    const ordered: WitApiInterface[] = [];
    const visit = (interfaceIndex: number): void => {
        if (visited.has(interfaceIndex)) return;
        visited.add(interfaceIndex);
        const iface = resolved.interfaces[interfaceIndex];
        if (!iface) throw new Error(`Plugin WIT imports missing interface index ${interfaceIndex}`);
        ordered.push(iface);
        for (const dependency of iface.dependencies ?? []) {
            const dependencyInterface = findDependencyInterface(resolved, iface, dependency);
            if (!dependencyInterface)
                throw new Error(`WIT interface ${iface.specifier} uses unresolved interface ${dependency}`);
            visit(resolved.interfaces.indexOf(dependencyInterface));
        }
    };
    for (const interfaceIndex of importedInterfaces) visit(interfaceIndex);
    return { packageName: rootIdentity.packageName, version: rootIdentity.version, interfaces: ordered };
}

/**
 * Select the directly imported WASI interfaces and their transitive dependencies.
 *
 * @param resolved - Normalized package graph containing the `plugin` world.
 * @param requestedImports - Optional direct imports to include; omitted selects every WASI import.
 * @param importOrder - Optional source import order used to keep output deterministic.
 * @returns Direct imports and the interface closure required by their dependencies.
 * @throws {Error} If a requested interface is absent from the plugin world.
 */
export function resolveWasiImports(
    resolved: ResolvedWitDocument,
    requestedImports?: string[],
    importOrder?: readonly string[],
): { imports: string[]; interfaces: WitWasiInterface[] } {
    const plugin = resolved.raw.worlds.find(({ name }) => name === 'plugin');
    if (!plugin) throw new Error('Prepared WIT document has no plugin world');
    const imported = importOrder
        ? importOrder
              .filter((name) => name.startsWith('wasi:'))
              .map((specifier) => {
                  const iface = resolved.interfaces.find((entry) => entry.specifier === specifier);
                  if (!iface) throw new Error(`plugin.wit imports unknown WASI interface ${specifier}`);
                  return iface;
              })
        : Object.values(plugin.imports)
              .filter((entry): entry is { interface: { id: number } } => 'interface' in entry)
              .map(({ interface: reference }) => resolved.interfaces[reference.id])
              .filter((iface): iface is WitApiInterface => iface !== undefined)
              .filter((iface) => iface.packageName?.startsWith('wasi:'));
    const available = new Map<string, WitWasiInterface>();
    const addAvailable = (iface: WitApiInterface): void => {
        if (available.has(iface.specifier)) return;
        const wasi = asWasiInterface(iface);
        available.set(iface.specifier, wasi);
        for (const dependency of wasi.dependencies) {
            const definition = resolved.interfaces.find(({ specifier }) => specifier === dependency);
            if (!definition)
                throw new Error(`WIT interface ${iface.specifier} uses unresolved interface ${dependency}`);
            addAvailable(definition);
        }
    };
    for (const iface of imported) addAvailable(iface);

    const imports =
        requestedImports === undefined ? imported.map(({ specifier }) => specifier) : [...new Set(requestedImports)];
    for (const specifier of imports) {
        if (!available.has(specifier)) throw new Error(`WASI interface ${specifier} is not imported by plugin WIT`);
    }

    const selected = new Map<string, WitWasiInterface>();
    const visit = (specifier: string): void => {
        if (selected.has(specifier)) return;
        const iface = available.get(specifier);
        if (!iface) throw new Error(`plugin WIT imports or uses ${specifier}, but no matching interface is declared`);
        selected.set(specifier, iface);
        for (const dependency of iface.dependencies) visit(dependency);
    };
    for (const specifier of imports) visit(specifier);
    return { imports, interfaces: [...selected.values()] };
}

/**
 * Return feature flags attached to selected WASI operations.
 *
 * @param wasi - Resolved WASI interfaces available to the plugin.
 * @param usedMethods - Operation IDs whose required feature flags should be collected.
 * @returns Unique feature names in sorted order.
 */
export function selectWasiFeatures(
    wasi: { interfaces: WitWasiInterface[] },
    usedMethods: readonly string[] = [],
): string[] {
    const selected = new Set(usedMethods);
    const features = new Set<string>();
    for (const iface of wasi.interfaces) {
        for (const operation of allOperations(iface)) {
            const id = `${iface.specifier}#${operation.resource ? `${operation.resource}.` : ''}${operation.fn.name}`;
            if (selected.has(id)) for (const feature of operation.fn.features ?? []) features.add(feature);
        }
    }
    return [...features].sort();
}

function resolveInterface(
    context: ResolutionContext,
    raw: WitToolsInterface,
    interfaceIndex: number,
    declarationOrder: ReadonlyMap<string, InterfaceDeclarationOrder>,
): WitApiInterface {
    const identity = requireValue(context.packageNames[raw.package], `package identity ${raw.package}`);
    const specifier = makeSpecifier(identity, raw.name);
    const dependencyAliases: Record<string, WitDependencyAlias> = {};
    const dependencies: string[] = [];
    const dependencyTypes: Record<string, string[]> = {};
    const declarations: { name: string; index: number; type: WitToolsTypeDefinition }[] = [];
    const importedAliases = new Set<string>();
    const order = declarationOrder.get(makeSpecifier(identity, raw.name));

    for (const [name, typeIndex] of Object.entries(raw.types)) {
        const definition = requireValue(context.document.types[typeIndex], `type ${typeIndex}`);
        if (!definition.name || !definition.owner || !('interface' in definition.owner)) continue;
        if (definition.owner.interface !== interfaceIndex) {
            addDependencyAlias(
                context,
                interfaceIndex,
                name,
                typeIndex,
                dependencyAliases,
                dependencies,
                dependencyTypes,
            );
            continue;
        }
        declarations.push({ name, index: typeIndex, type: definition });
        if (typeof definition.kind === 'object' && 'type' in definition.kind) {
            const target = definition.kind.type;
            if (typeof target === 'number') {
                const targetDefinition = requireValue(context.document.types[target], `type ${target}`);
                const owner = ownerInterface(targetDefinition);
                if (owner !== undefined && owner !== interfaceIndex) {
                    importedAliases.add(name);
                    addDependencyAlias(
                        context,
                        interfaceIndex,
                        name,
                        target,
                        dependencyAliases,
                        dependencies,
                        dependencyTypes,
                    );
                }
            }
        }
    }

    const types: WitTypeAlias[] = [];
    const resources: WitResource[] = [];
    const records: WitRecord[] = [];
    const variants: WitVariant[] = [];
    const enums: WitEnum[] = [];
    const flags: WitEnum[] = [];
    for (const declaration of declarations) {
        const kind = declaration.type.kind;
        if (kind === 'resource') resources.push({ name: declaration.name, functions: [] });
        else if (typeof kind === 'object' && 'record' in kind) {
            records.push({
                name: declaration.name,
                fields: kind.record.fields.map((field) => {
                    const type = resolveReference(context, field.type, interfaceIndex, new Set());
                    return {
                        name: field.name,
                        type: formatReference(context, field.type, interfaceIndex).replace(/^%/, ''),
                        resolvedType: type,
                    };
                }),
            });
        } else if (typeof kind === 'object' && 'variant' in kind) {
            variants.push({
                name: declaration.name,
                cases: kind.variant.cases.map((variant) => ({
                    name: variant.name,
                    type: variant.type === null ? '' : formatReference(context, variant.type, interfaceIndex),
                    ...(variant.type === null
                        ? {}
                        : { resolvedType: resolveReference(context, variant.type, interfaceIndex, new Set()) }),
                })),
            });
        } else if (typeof kind === 'object' && 'enum' in kind) {
            enums.push({ name: declaration.name, values: kind.enum.cases.map(({ name }) => name) });
        } else if (typeof kind === 'object' && 'flags' in kind) {
            flags.push({ name: declaration.name, values: kind.flags.flags.map(({ name }) => name) });
        } else if (typeof kind === 'object' && 'type' in kind) {
            if (!importedAliases.has(declaration.name)) {
                types.push({
                    name: declaration.name,
                    type: formatReference(context, kind.type, interfaceIndex),
                    resolvedType: withAliasMetadata(
                        resolveReference(context, kind.type, interfaceIndex, new Set([declaration.index])),
                        raw.name,
                        declaration.name,
                    ),
                });
            }
        } else if (
            typeof kind === 'object' &&
            ('list' in kind || 'option' in kind || 'tuple' in kind || 'result' in kind || 'handle' in kind)
        ) {
            types.push({
                name: declaration.name,
                type: formatAliasDefinition(context, declaration.index, interfaceIndex),
                resolvedType: withAliasMetadata(
                    resolveReference(context, declaration.index, interfaceIndex, new Set()),
                    raw.name,
                    declaration.name,
                ),
            });
        } else {
            throw new Error(`Unsupported resolved WIT type for ${specifier}.${declaration.name}`);
        }
    }

    const sortByDeclaration = <T extends { name: string }>(items: T[], names: string[] | undefined): T[] => {
        if (!names?.length) return items;
        const indexes = new Map(names.map((name, index) => [name, index]));
        return items.sort(
            (left, right) =>
                (indexes.get(left.name) ?? Number.MAX_SAFE_INTEGER) -
                (indexes.get(right.name) ?? Number.MAX_SAFE_INTEGER),
        );
    };
    const interfaceValue: WitApiInterface = {
        name: raw.name,
        packageName: identity.name,
        version: identity.version,
        specifier,
        functions: [],
        resources: sortByDeclaration(resources, order?.resources),
        records: sortByDeclaration(records, order?.records),
        variants: sortByDeclaration(variants, order?.variants),
        enums: sortByDeclaration(enums, order?.enums),
        flags: sortByDeclaration(flags, order?.flags),
        types: sortByDeclaration(types, order?.types),
        dependencies,
        dependencyAliases,
    };
    const resourceByIndex = new Map<number, WitResource>();
    for (const resource of resources) {
        const index = raw.types[resource.name];
        if (index !== undefined) resourceByIndex.set(index, resource);
    }
    const functions: WitFunction[] = [];
    for (const [functionName, operation] of Object.entries(raw.functions)) {
        const owner = resourceOwner(operation.kind);
        const kind = typeof operation.kind === 'string' ? undefined : Object.keys(operation.kind)[0];
        const resource = owner === undefined ? undefined : resourceByIndex.get(owner);
        if (owner !== undefined && !resource) {
            const resourceType = context.document.types[owner];
            const name = resourceType?.name ?? `type ${owner}`;
            throw new Error(`WIT operation ${specifier}.${functionName} references missing resource ${name}`);
        }
        const functionValue = resolveFunction(
            context,
            operation,
            interfaceIndex,
            kind === 'method',
            kind === 'constructor',
        );
        if (resource) {
            const prefix =
                kind === 'constructor'
                    ? 'constructor'
                    : (functionName
                          .slice(functionName.indexOf(']') + 1)
                          .split('.')
                          .at(-1) ?? functionName);
            resource.functions.push({ ...functionValue, name: prefix, isStatic: kind === 'static' });
        } else {
            functions.push(functionValue);
        }
    }
    interfaceValue.functions = functions;
    if (identity.name.startsWith('wasi:')) {
        interfaceValue.dependencyTypes = dependencyTypes;
    }
    return interfaceValue;
}

function resolveFunction(
    context: ResolutionContext,
    operation: WitToolsFunction,
    interfaceIndex: number,
    isMethod: boolean,
    isConstructor: boolean,
): WitFunction {
    const parameters = isMethod ? operation.params.slice(1) : operation.params;
    return {
        name: functionName(operation, typeof operation.kind === 'string' ? undefined : Object.keys(operation.kind)[0]),
        isStatic: typeof operation.kind === 'object' && 'static' in operation.kind,
        features: operation.features,
        parameters: parameters.map(({ name, type }) => ({
            name,
            type: formatReference(context, type, interfaceIndex),
            resolvedType: resolveReference(context, type, interfaceIndex, new Set()),
        })),
        result:
            isConstructor || operation.result === null
                ? ''
                : formatReference(context, operation.result, interfaceIndex),
        resolvedResult:
            isConstructor || operation.result === null
                ? { kind: 'unit' }
                : resolveReference(context, operation.result, interfaceIndex, new Set()),
    };
}

function functionName(operation: WitToolsFunction, kind?: string): string {
    if (kind === 'constructor') return 'constructor';
    if (typeof operation.kind === 'string') return operation.name;
    return (
        operation.name
            .slice(operation.name.indexOf(']') + 1)
            .split('.')
            .at(-1) ?? operation.name
    );
}

function resourceOwner(kind: WitToolsFunction['kind']): number | undefined {
    if (typeof kind === 'string') return undefined;
    return Object.values(kind)[0];
}

function addDependencyAlias(
    context: ResolutionContext,
    interfaceIndex: number,
    alias: string,
    target: number,
    aliases: Record<string, WitDependencyAlias>,
    dependencies: string[],
    dependencyTypes: Record<string, string[]>,
): void {
    const targetDefinition = requireValue(context.document.types[target], `type ${target}`);
    const owner = ownerInterface(targetDefinition);
    if (owner === undefined || owner === interfaceIndex) return;
    const targetInterface = context.interfaces[owner];
    if (!targetInterface) throw new Error(`WIT type ${target} has missing owner interface ${owner}`);
    const targetIdentity = requireValue(
        context.packageNames[targetInterface.package],
        `package identity ${targetInterface.package}`,
    );
    const dependencySpecifier = makeSpecifier(targetIdentity, targetInterface.name);
    const targetName = context.document.types[target]?.name ?? context.typeNames.get(target) ?? alias;
    if (alias !== targetName) aliases[alias] = { name: targetName, specifier: dependencySpecifier };
    const sourceInterface = requireValue(context.interfaces[interfaceIndex], `interface ${interfaceIndex}`);
    const sourceIdentity = requireValue(
        context.packageNames[sourceInterface.package],
        `package identity ${sourceInterface.package}`,
    );
    const dependency =
        sourceIdentity.name.startsWith('wasi:') || sourceIdentity.name !== targetIdentity.name
            ? dependencySpecifier
            : targetInterface.name;
    if (!dependencies.includes(dependency)) dependencies.push(dependency);
    let imports = dependencyTypes[dependencySpecifier];
    if (!imports) {
        imports = [];
        dependencyTypes[dependencySpecifier] = imports;
    }
    if (!imports.includes(targetName)) imports.push(targetName);
}

function resolveReference(
    context: ResolutionContext,
    reference: WitToolsTypeReference | null,
    interfaceIndex: number,
    visiting: Set<number>,
): ResolvedWitType {
    if (reference === null) return { kind: 'unit' };
    if (typeof reference === 'string') return { kind: 'primitive', name: reference };
    if (visiting.has(reference)) {
        const name = context.document.types[reference]?.name ?? `type ${reference}`;
        throw new Error(`Cyclic WIT type alias involving ${name}`);
    }
    const definition = context.document.types[reference];
    if (!definition) throw new Error(`WIT JSON type reference ${reference} is out of range`);
    const kind = definition.kind;
    const localName = localNameFor(context, interfaceIndex, reference) ?? definition.name;
    const ownerIndex = ownerInterface(definition);
    const ownerRaw = ownerIndex === undefined ? undefined : context.interfaces[ownerIndex];
    const ownerIdentity = ownerRaw ? context.packageNames[ownerRaw.package] : undefined;
    const metadata =
        ownerRaw && ownerIdentity
            ? {
                  name: definition.name ?? localName ?? `anonymous-${reference}`,
                  interfaceName: ownerRaw.name,
                  packageName: ownerIdentity.name,
                  interfaceSpecifier: makeSpecifier(ownerIdentity, ownerRaw.name),
                  interfaceDependencies: [] as string[],
                  declaredInterface: ownerRaw.name,
              }
            : undefined;

    if (kind === 'resource') {
        if (!metadata) return { kind: 'unsupported', source: localName ?? `resource ${reference}` };
        return { kind: 'resource', ...metadata };
    }
    if (typeof kind === 'object' && 'type' in kind) {
        const nested = new Set(visiting).add(reference);
        const resolved = resolveReference(context, kind.type, interfaceIndex, nested);
        const importedNamedType =
            metadata?.interfaceSpecifier !== undefined &&
            'interfaceSpecifier' in resolved &&
            metadata.interfaceSpecifier !== resolved.interfaceSpecifier;
        const aliasName = importedNamedType
            ? (('aliasName' in resolved ? resolved.aliasName : undefined) ??
              ('name' in resolved ? resolved.name : (localName ?? definition.name)))
            : (localName ?? definition.name);
        if (metadata && aliasName && resolved.kind !== 'unit' && resolved.kind !== 'unsupported') {
            return {
                ...resolved,
                declaredInterface: resolved.declaredInterface ?? metadata.declaredInterface,
                aliasName,
            };
        }
        return resolved;
    }
    if (typeof kind === 'object' && 'record' in kind) {
        if (!metadata) return { kind: 'unsupported', source: `record ${localName ?? reference}` };
        return {
            kind: 'record',
            ...metadata,
            fields: kind.record.fields.map((field) => ({
                name: field.name,
                type: formatReference(context, field.type, ownerIndex ?? interfaceIndex),
                resolvedType: resolveReference(
                    context,
                    field.type,
                    ownerIndex ?? interfaceIndex,
                    new Set(visiting).add(reference),
                ),
            })),
        };
    }
    if (typeof kind === 'object' && 'variant' in kind) {
        if (!metadata) return { kind: 'unsupported', source: `variant ${localName ?? reference}` };
        return {
            kind: 'variant',
            ...metadata,
            cases: kind.variant.cases.map((entry) => ({
                name: entry.name,
                type: entry.type === null ? '' : formatReference(context, entry.type, ownerIndex ?? interfaceIndex),
                ...(entry.type === null
                    ? {}
                    : {
                          resolvedType: resolveReference(
                              context,
                              entry.type,
                              ownerIndex ?? interfaceIndex,
                              new Set(visiting).add(reference),
                          ),
                      }),
            })),
        };
    }
    if (typeof kind === 'object' && ('enum' in kind || 'flags' in kind)) {
        if (!metadata)
            return { kind: 'unsupported', source: `${'enum' in kind ? 'enum' : 'flags'} ${localName ?? reference}` };
        if ('enum' in kind) return { kind: 'enum', ...metadata, values: kind.enum.cases.map(({ name }) => name) };
        return { kind: 'flags', ...metadata, values: kind.flags.flags.map(({ name }) => name) };
    }
    if (typeof kind === 'object' && 'handle' in kind) {
        const handle = kind.handle;
        const borrowed = 'borrow' in handle;
        const resourceIndex = borrowed ? handle.borrow : handle.own;
        const resource = resolveReference(context, resourceIndex, interfaceIndex, new Set(visiting).add(reference));
        if (resource.kind === 'resource') return borrowed ? { kind: 'borrow', item: resource } : resource;
        return { kind: 'unsupported', source: `handle ${localName ?? reference}` };
    }
    const containingInterface = requireValue(context.interfaces[interfaceIndex], `interface ${interfaceIndex}`);
    const containingPackage = requireValue(
        context.packageNames[containingInterface.package],
        `package identity ${containingInterface.package}`,
    );
    const containerMetadata = metadata ?? {
        declaredInterface: containingInterface.name,
        packageName: containingPackage.name,
        interfaceSpecifier: makeSpecifier(containingPackage, containingInterface.name),
    };
    if (typeof kind === 'object' && 'list' in kind) {
        return retainResolvedTypeAlias(
            {
                kind: 'list',
                item: resolveReference(context, kind.list, interfaceIndex, new Set(visiting).add(reference)),
            },
            containerMetadata,
            localName,
        );
    }
    if (typeof kind === 'object' && 'option' in kind) {
        return retainResolvedTypeAlias(
            {
                kind: 'option',
                item: resolveReference(context, kind.option, interfaceIndex, new Set(visiting).add(reference)),
            },
            containerMetadata,
            localName,
        );
    }
    if (typeof kind === 'object' && 'result' in kind) {
        return retainResolvedTypeAlias(
            {
                kind: 'result',
                ok: resolveReference(context, kind.result.ok, interfaceIndex, new Set(visiting).add(reference)),
                error: resolveReference(context, kind.result.err, interfaceIndex, new Set(visiting).add(reference)),
            },
            containerMetadata,
            localName,
        );
    }
    if (typeof kind === 'object' && 'tuple' in kind) {
        return retainResolvedTypeAlias(
            {
                kind: 'tuple',
                items: kind.tuple.types.map((item) =>
                    resolveReference(context, item, interfaceIndex, new Set(visiting).add(reference)),
                ),
            },
            containerMetadata,
            localName,
        );
    }
    return { kind: 'unsupported', source: localName ?? `type ${reference}` };
}

function formatReference(
    context: ResolutionContext,
    reference: WitToolsTypeReference | null,
    interfaceIndex: number,
): string {
    if (reference === null) return '';
    if (typeof reference === 'string') return reference;
    const definition = context.document.types[reference];
    if (!definition) throw new Error(`WIT JSON type reference ${reference} is out of range`);
    const localName = localNameFor(context, interfaceIndex, reference);
    const kind = definition.kind;
    if (localName && !(typeof kind === 'object' && 'handle' in kind)) {
        return formatLocalTypeName(context, interfaceIndex, localName);
    }
    if (kind === 'resource') return definition.name ?? `resource-${reference}`;
    if (typeof kind === 'object' && 'type' in kind) return formatReference(context, kind.type, interfaceIndex);
    if (typeof kind === 'object' && 'handle' in kind) {
        const handle = kind.handle;
        const resourceName = formatReference(context, 'borrow' in handle ? handle.borrow : handle.own, interfaceIndex);
        return 'borrow' in handle ? `borrow<${resourceName}>` : resourceName;
    }
    if (typeof kind === 'object' && 'list' in kind)
        return `list<${formatReference(context, kind.list, interfaceIndex)}>`;
    if (typeof kind === 'object' && 'option' in kind)
        return `option<${formatReference(context, kind.option, interfaceIndex)}>`;
    if (typeof kind === 'object' && 'tuple' in kind) {
        return `tuple<${kind.tuple.types.map((item) => formatReference(context, item, interfaceIndex)).join(tupleSeparator(context, interfaceIndex))}>`;
    }
    if (typeof kind === 'object' && 'result' in kind) {
        const { ok, err } = kind.result;
        if (ok === null && err === null) return 'result';
        if (err === null) return `result<${formatReference(context, ok, interfaceIndex)}>`;
        return `result<${ok === null ? '_' : formatReference(context, ok, interfaceIndex)}, ${formatReference(context, err, interfaceIndex)}>`;
    }
    if (typeof kind === 'object' && 'record' in kind) return definition.name ?? `record-${reference}`;
    if (typeof kind === 'object' && 'variant' in kind) return definition.name ?? `variant-${reference}`;
    if (typeof kind === 'object' && 'enum' in kind) return definition.name ?? `enum-${reference}`;
    if (typeof kind === 'object' && 'flags' in kind) return definition.name ?? `flags-${reference}`;
    throw new Error(`Unsupported WIT type reference ${reference}`);
}

function formatAliasDefinition(context: ResolutionContext, index: number, interfaceIndex: number): string {
    const definition = context.document.types[index];
    if (!definition || typeof definition.kind !== 'object')
        throw new Error(`WIT type alias ${index} has no composite kind`);
    const kind = definition.kind;
    if ('list' in kind) return `list<${formatReference(context, kind.list, interfaceIndex)}>`;
    if ('option' in kind) return `option<${formatReference(context, kind.option, interfaceIndex)}>`;
    if ('tuple' in kind) {
        return `tuple<${kind.tuple.types.map((item) => formatReference(context, item, interfaceIndex)).join(tupleSeparator(context, interfaceIndex))}>`;
    }
    if ('result' in kind) {
        const ok = kind.result.ok === null ? '_' : formatReference(context, kind.result.ok, interfaceIndex);
        const error = kind.result.err === null ? '_' : formatReference(context, kind.result.err, interfaceIndex);
        if (ok === '_' && error === '_') return 'result';
        if (error === '_') return `result<${ok}>`;
        return `result<${ok}, ${error}>`;
    }
    if ('handle' in kind) {
        const { borrow, own } = kind.handle as { borrow?: number; own?: number };
        const resourceIndex = borrow ?? own;
        if (resourceIndex === undefined) throw new Error(`WIT handle type ${index} has no resource`);
        const resource = formatReference(context, resourceIndex, interfaceIndex);
        return borrow === undefined ? resource : `borrow<${resource}>`;
    }
    throw new Error(`Unsupported composite alias ${definition.name ?? index}`);
}

function localNameFor(context: ResolutionContext, interfaceIndex: number, reference: number): string | undefined {
    for (const [name, index] of context.interfaceTypes.get(interfaceIndex) ?? []) {
        if (index === reference) return name;
    }
    return undefined;
}

function formatLocalTypeName(context: ResolutionContext, interfaceIndex: number, name: string): string {
    const raw = context.interfaces[interfaceIndex];
    if (!raw) return name;
    const identity = context.packageNames[raw.package];
    if (!identity) return name;
    const order = context.declarationOrder.get(makeSpecifier(identity, raw.name));
    return order?.escapedNames.includes(name) ? `%${name}` : name;
}

function tupleSeparator(context: ResolutionContext, interfaceIndex: number): string {
    const raw = context.interfaces[interfaceIndex];
    return raw && context.packageNames[raw.package]?.name.startsWith('wasi:') ? ',' : ', ';
}

function withAliasMetadata(type: ResolvedWitType, declaredInterface: string, aliasName: string): ResolvedWitType {
    if (type.kind === 'unit' || type.kind === 'unsupported') return type;
    return { ...type, declaredInterface, aliasName };
}

function retainResolvedTypeAlias(
    type: ResolvedWitType,
    metadata: { declaredInterface?: string; packageName?: string; interfaceSpecifier?: string } | undefined,
    localName: string | null | undefined,
): ResolvedWitType {
    if (type.kind === 'unit' || type.kind === 'unsupported') return type;
    return {
        ...type,
        ...(metadata?.declaredInterface ? { declaredInterface: metadata.declaredInterface } : {}),
        ...(localName ? { aliasName: localName } : {}),
        ...(metadata?.packageName ? { packageName: metadata.packageName } : {}),
        ...(metadata?.interfaceSpecifier ? { interfaceSpecifier: metadata.interfaceSpecifier } : {}),
    };
}

function ownerInterface(definition: WitToolsTypeDefinition): number | undefined {
    if (definition.owner && 'interface' in definition.owner) return definition.owner.interface;
    return undefined;
}

function findDependencyInterface(
    resolved: ResolvedWitDocument,
    source: WitApiInterface,
    dependency: string,
): WitApiInterface | undefined {
    return resolved.interfaces.find(
        (candidate) =>
            candidate.specifier === dependency ||
            (candidate.name === dependency && candidate.packageName === source.packageName),
    );
}

function parsePackageIdentity(pkg: WitToolsPackage): PackageIdentity {
    const separator = pkg.name.lastIndexOf('@');
    if (separator < 0) return { name: pkg.name, version: undefined };
    return { name: pkg.name.slice(0, separator), version: pkg.name.slice(separator + 1) };
}

function makeSpecifier(identity: PackageIdentity, name: string): string {
    return `${identity.name}/${name}${identity.version ? `@${identity.version}` : ''}`;
}

function requireValue<T>(value: T | undefined, description: string): T {
    if (value === undefined) throw new Error(`Resolved WIT document is missing ${description}`);
    return value;
}

function asWasiInterface(iface: WitApiInterface): WitWasiInterface {
    if (!iface.packageName?.startsWith('wasi:')) throw new Error(`${iface.specifier} is not a WASI interface`);
    return {
        ...iface,
        packageName: iface.packageName,
        version: iface.version,
        dependencies: iface.dependencies ?? [],
        dependencyTypes: iface.dependencyTypes ?? {},
    };
}

function* allOperations(iface: WitWasiInterface): Generator<{ fn: WitFunction; resource?: string }> {
    for (const fn of iface.functions) yield { fn };
    for (const resource of iface.resources) {
        for (const fn of resource.functions) yield { fn, resource: resource.name };
    }
}
