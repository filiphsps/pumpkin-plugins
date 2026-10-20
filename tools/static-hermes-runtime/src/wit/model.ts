/** Primitive WIT values emitted directly in wasm-tools' resolved JSON. */
export type WitPrimitive =
    | 'bool'
    | 'u8'
    | 'u16'
    | 'u32'
    | 'u64'
    | 's8'
    | 's16'
    | 's32'
    | 's64'
    | 'f32'
    | 'f64'
    | 'char'
    | 'string';

/** A primitive WIT value or an index into the resolved document's type table. */
export type WitToolsTypeReference = WitPrimitive | number;

/** A WIT field or case whose type reference has already been validated. */
export interface WitToolsNamedType {
    /** Field or case name from the resolved WIT document. */
    name: string;
    /** Primitive or type-table reference; `null` denotes a payload-free case. */
    type: WitToolsTypeReference | null;
}

/** A named type definition from the pinned wasm-tools JSON format. */
export interface WitToolsTypeDefinition {
    /** Structural definition and any referenced type indexes. */
    kind: WitToolsTypeKind;
    /** Declared type name, or `null` for an anonymous type. */
    name: string | null;
    /** Owning interface or world, or `null` for an unowned type. */
    owner: WitToolsTypeOwner | null;
}

/** Every type form present in the pinned Pumpkin and WASI WIT inputs. */
export type WitToolsTypeKind =
    | 'resource'
    | { record: { fields: WitToolsNamedType[] } }
    | { variant: { cases: WitToolsNamedType[] } }
    | { enum: { cases: Array<{ name: string }> } }
    | { flags: { flags: Array<{ name: string }> } }
    | { option: WitToolsTypeReference }
    | { result: { ok: WitToolsTypeReference | null; err: WitToolsTypeReference | null } }
    | { list: WitToolsTypeReference }
    | { tuple: { types: WitToolsTypeReference[] } }
    | { type: WitToolsTypeReference }
    | { handle: { borrow: number } | { own: number } };

/** The interface or world that owns a named type. */
export type WitToolsTypeOwner = { interface: number } | { world: number };

/** The WIT operation kind emitted by wasm-tools. */
export type WitToolsFunctionKind = 'freestanding' | { constructor: number } | { method: number } | { static: number };

/** One resolved function parameter. */
export interface WitToolsParameter {
    /** Parameter name from the WIT function signature. */
    name: string;
    /** Primitive or index into the document's type table. */
    type: WitToolsTypeReference;
}

/** A resolved WIT function, including its resource operation kind. */
export interface WitToolsFunction {
    /** WIT feature flags required by this operation. */
    features: string[];
    /** Whether this is a freestanding function, constructor, method, or static method. */
    kind: WitToolsFunctionKind;
    /** Function name, including the resource method name when applicable. */
    name: string;
    /** Ordered function parameters. */
    params: WitToolsParameter[];
    /** Result type reference, or `null` for a function with no result. */
    result: WitToolsTypeReference | null;
}

/** A WIT interface in the resolved package graph. */
export interface WitToolsInterface {
    /** Map from operation names to their resolved declarations. */
    functions: Record<string, WitToolsFunction>;
    /** Interface name within its package. */
    name: string;
    /** Index of the owning package in the document's package table. */
    package: number;
    /** Map from declared type names to type-table indexes. */
    types: Record<string, number>;
}

/** An interface or type imported into a WIT world. */
export type WitToolsWorldImport = { interface: { id: number } } | { type: number };

/** A resolved world and its imported names. */
export interface WitToolsWorld {
    /** Imported interface or type entries, keyed by their world import name. */
    imports: Record<string, WitToolsWorldImport>;
    /** World name within its package. */
    name: string;
    /** Index of the owning package in the document's package table. */
    package: number;
}

/** Package-level names mapped to resolved interface and world indexes. */
export interface WitToolsPackage {
    /** Map from interface names to interface-table indexes. */
    interfaces: Record<string, number>;
    /** Fully qualified package name and optional version, as emitted by wasm-tools. */
    name: string;
    /** Map from world names to world-table indexes. */
    worlds: Record<string, number>;
}

/** Fully resolved JSON document emitted by the pinned wasm-tools release. */
export interface WitToolsDocument {
    /** Resolved interfaces and their operation/type indexes. */
    interfaces: WitToolsInterface[];
    /** Package identities and their interface/world indexes. */
    packages: WitToolsPackage[];
    /** Shared named type definitions referenced by indexes. */
    types: WitToolsTypeDefinition[];
    /** Resolved worlds, including each world's import references. */
    worlds: WitToolsWorld[];
}

type JsonObject = Record<string, unknown>;

const primitives = new Set<WitPrimitive>([
    'bool',
    'u8',
    'u16',
    'u32',
    'u64',
    's8',
    's16',
    's32',
    's64',
    'f32',
    'f64',
    'char',
    'string',
]);

/**
 * Parse and validate JSON from the pinned wasm-tools WIT command.
 *
 * @param source - JSON output from `wasm-tools component wit --json`.
 * @returns The validated document with references between its tables checked.
 * @throws {Error} If the JSON shape, a field value, or a table reference is invalid.
 */
export function parseWitToolsJson(source: string): WitToolsDocument {
    let parsed: unknown;
    try {
        parsed = JSON.parse(source) as unknown;
    } catch (error) {
        throw new Error(`Invalid wasm-tools WIT JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const root = objectAt(parsed, 'document');
    const document: WitToolsDocument = {
        worlds: arrayAt(root.worlds, 'worlds').map(parseWorld),
        interfaces: arrayAt(root.interfaces, 'interfaces').map(parseInterface),
        types: arrayAt(root.types, 'types').map(parseTypeDefinition),
        packages: arrayAt(root.packages, 'packages').map(parsePackage),
    };
    validateReferences(document);
    return document;
}

function parseWorld(value: unknown): WitToolsWorld {
    const at = 'world';
    const world = objectAt(value, at);
    const imports: Record<string, WitToolsWorldImport> = {};
    for (const [name, rawImport] of Object.entries(objectAt(world.imports, `${at}.imports`))) {
        const entry = objectAt(rawImport, `${at}.imports.${name}`);
        if ('interface' in entry) {
            const importedInterface = objectAt(entry.interface, `${at}.imports.${name}.interface`);
            imports[name] = {
                interface: { id: integerAt(importedInterface.id, `${at}.imports.${name}.interface.id`) },
            };
        } else if ('type' in entry) {
            imports[name] = { type: integerAt(entry.type, `${at}.imports.${name}.type`) };
        } else {
            throw new Error(`Unsupported WIT JSON world import "${name}"`);
        }
    }
    return {
        name: stringAt(world.name, `${at}.name`),
        package: integerAt(world.package, `${at}.package`),
        imports,
    };
}

function parseInterface(value: unknown): WitToolsInterface {
    const rawInterface = objectAt(value, 'interface');
    const name = stringAt(rawInterface.name, 'interface.name');
    const types: Record<string, number> = {};
    for (const [typeName, id] of Object.entries(objectAt(rawInterface.types, `interface ${name}.types`))) {
        types[typeName] = integerAt(id, `interface ${name}.types.${typeName}`);
    }
    const functions: Record<string, WitToolsFunction> = {};
    for (const [functionName, rawFunction] of Object.entries(
        objectAt(rawInterface.functions, `interface ${name}.functions`),
    )) {
        functions[functionName] = parseFunction(rawFunction, `interface ${name}.${functionName}`);
    }
    return {
        name,
        package: integerAt(rawInterface.package, `interface ${name}.package`),
        types,
        functions,
    };
}

function parseFunction(value: unknown, at: string): WitToolsFunction {
    const fn = objectAt(value, at);
    return {
        name: stringAt(fn.name, `${at}.name`),
        kind: parseFunctionKind(fn.kind, at),
        params: arrayAt(fn.params, `${at}.params`).map((parameter) => {
            const entry = objectAt(parameter, `${at}.parameter`);
            return {
                name: stringAt(entry.name, `${at}.parameter.name`),
                type: typeReferenceAt(entry.type, `${at}.parameter.type`),
            };
        }),
        result: fn.result === undefined || fn.result === null ? null : typeReferenceAt(fn.result, `${at}.result`),
        features: parseFeatures(fn.stability, at),
    };
}

function parseFunctionKind(value: unknown, at: string): WitToolsFunctionKind {
    if (value === 'freestanding') return value;
    const kind = objectAt(value, `${at}.kind`);
    for (const name of ['constructor', 'method', 'static'] as const) {
        if (Object.hasOwn(kind, name))
            return { [name]: integerAt(kind[name], `${at}.kind.${name}`) } as WitToolsFunctionKind;
    }
    throw new Error(`Unsupported WIT JSON operation kind for ${at}`);
}

function parseFeatures(value: unknown, at: string): string[] {
    if (value === undefined) return [];
    const stability = objectAt(value, `${at}.stability`);
    if (!('unstable' in stability)) return [];
    const unstable = objectAt(stability.unstable, `${at}.stability.unstable`);
    return unstable.feature === undefined ? [] : [stringAt(unstable.feature, `${at}.stability.unstable.feature`)];
}

function parseTypeDefinition(value: unknown): WitToolsTypeDefinition {
    const type = objectAt(value, 'type definition');
    const name = type.name === null ? null : stringAt(type.name, 'type definition.name');
    const kind = parseTypeKind(type.kind, name ?? '(anonymous type)');
    return {
        name,
        kind,
        owner: type.owner === null ? null : parseOwner(type.owner, name ?? '(anonymous type)'),
    };
}

function parseTypeKind(value: unknown, name: string): WitToolsTypeKind {
    if (value === 'resource') return value;
    const kind = objectAt(value, `type ${name}.kind`);
    const keys = Object.keys(kind);
    if (keys.length !== 1) throw new Error(`Invalid WIT JSON type kind for ${name}`);
    const key = keys[0];
    switch (key) {
        case 'record': {
            const fields = arrayAt(objectAt(kind.record, `type ${name}.record`).fields, `type ${name}.fields`).map(
                (field) => parseNamedType(field, `type ${name}.field`),
            );
            return { record: { fields } };
        }
        case 'variant': {
            const cases = arrayAt(objectAt(kind.variant, `type ${name}.variant`).cases, `type ${name}.cases`).map(
                (variant) => parseNamedType(variant, `type ${name}.case`),
            );
            return { variant: { cases } };
        }
        case 'enum':
            return {
                enum: { cases: namedCases(objectAt(kind.enum, `type ${name}.enum`).cases, `type ${name}.enum.cases`) },
            };
        case 'flags':
            return {
                flags: {
                    flags: namedCases(objectAt(kind.flags, `type ${name}.flags`).flags, `type ${name}.flags.flags`),
                },
            };
        case 'option':
            return { option: typeReferenceAt(kind.option, `type ${name}.option`) };
        case 'result': {
            const result = objectAt(kind.result, `type ${name}.result`);
            return {
                result: {
                    ok:
                        result.ok === undefined || result.ok === null
                            ? null
                            : typeReferenceAt(result.ok, `type ${name}.result.ok`),
                    err:
                        result.err === undefined || result.err === null
                            ? null
                            : typeReferenceAt(result.err, `type ${name}.result.err`),
                },
            };
        }
        case 'list':
            return { list: typeReferenceAt(kind.list, `type ${name}.list`) };
        case 'tuple':
            return {
                tuple: {
                    types: arrayAt(objectAt(kind.tuple, `type ${name}.tuple`).types, `type ${name}.tuple.types`).map(
                        (item) => typeReferenceAt(item, `type ${name}.tuple item`),
                    ),
                },
            };
        case 'type':
            return { type: typeReferenceAt(kind.type, `type ${name}.type`) };
        case 'handle': {
            const handle = objectAt(kind.handle, `type ${name}.handle`);
            if ('borrow' in handle)
                return { handle: { borrow: integerAt(handle.borrow, `type ${name}.handle.borrow`) } };
            if ('own' in handle) return { handle: { own: integerAt(handle.own, `type ${name}.handle.own`) } };
            throw new Error(`Invalid WIT JSON handle type for ${name}`);
        }
        default:
            throw new Error(`Unsupported WIT JSON type kind "${key}" for ${name}`);
    }
}

function parseNamedType(value: unknown, at: string): WitToolsNamedType {
    const named = objectAt(value, at);
    return {
        name: stringAt(named.name, `${at}.name`),
        type: named.type === null ? null : typeReferenceAt(named.type, `${at}.type`),
    };
}

function namedCases(value: unknown, at: string): Array<{ name: string }> {
    return arrayAt(value, at).map((item) => ({ name: stringAt(objectAt(item, at).name, `${at}.name`) }));
}

function parseOwner(value: unknown, name: string): WitToolsTypeOwner {
    const owner = objectAt(value, `type ${name}.owner`);
    if ('interface' in owner) return { interface: integerAt(owner.interface, `type ${name}.owner.interface`) };
    if ('world' in owner) return { world: integerAt(owner.world, `type ${name}.owner.world`) };
    throw new Error(`Invalid WIT JSON owner for ${name}`);
}

function parsePackage(value: unknown): WitToolsPackage {
    const pkg = objectAt(value, 'package');
    return {
        name: stringAt(pkg.name, 'package.name'),
        interfaces: integerMapAt(pkg.interfaces, 'package.interfaces'),
        worlds: integerMapAt(pkg.worlds, 'package.worlds'),
    };
}

function integerMapAt(value: unknown, at: string): Record<string, number> {
    const map: Record<string, number> = {};
    for (const [name, id] of Object.entries(objectAt(value, at))) map[name] = integerAt(id, `${at}.${name}`);
    return map;
}

function typeReferenceAt(value: unknown, at: string): WitToolsTypeReference {
    if (typeof value === 'number') return integerAt(value, at);
    if (typeof value === 'string' && primitives.has(value as WitPrimitive)) return value as WitPrimitive;
    throw new Error(`Unsupported WIT JSON type reference at ${at}`);
}

function validateReferences(document: WitToolsDocument): void {
    for (const world of document.worlds) {
        assertIndex(world.package, document.packages.length, `world ${world.name} package`);
        for (const [name, imported] of Object.entries(world.imports)) {
            if ('interface' in imported)
                assertIndex(imported.interface.id, document.interfaces.length, `world ${world.name} import ${name}`);
            else assertIndex(imported.type, document.types.length, `world ${world.name} import ${name}`);
        }
    }
    for (const apiInterface of document.interfaces) {
        assertIndex(apiInterface.package, document.packages.length, `interface ${apiInterface.name} package`);
        for (const [name, id] of Object.entries(apiInterface.types))
            assertIndex(id, document.types.length, `interface ${apiInterface.name} type ${name}`);
        for (const [name, fn] of Object.entries(apiInterface.functions)) {
            for (const parameter of fn.params)
                assertTypeReference(
                    parameter.type,
                    document,
                    `function ${apiInterface.name}.${name} parameter ${parameter.name}`,
                );
            if (fn.result !== null)
                assertTypeReference(fn.result, document, `function ${apiInterface.name}.${name} result`);
            if (typeof fn.kind !== 'string') {
                const resourceId = Object.values(fn.kind)[0];
                if (resourceId === undefined)
                    throw new Error(`WIT function ${apiInterface.name}.${name} has no resource`);
                assertIndex(resourceId, document.types.length, `function ${apiInterface.name}.${name} resource`);
            }
        }
    }
    for (const [index, type] of document.types.entries()) {
        if (type.owner && 'interface' in type.owner)
            assertIndex(type.owner.interface, document.interfaces.length, `type ${type.name ?? index} owner`);
        if (type.owner && 'world' in type.owner)
            assertIndex(type.owner.world, document.worlds.length, `type ${type.name ?? index} owner`);
        for (const reference of typeReferences(type.kind))
            assertTypeReference(reference, document, `type ${type.name ?? index}`);
    }
    for (const pkg of document.packages) {
        for (const [name, id] of Object.entries(pkg.interfaces))
            assertIndex(id, document.interfaces.length, `package ${pkg.name} interface ${name}`);
        for (const [name, id] of Object.entries(pkg.worlds))
            assertIndex(id, document.worlds.length, `package ${pkg.name} world ${name}`);
    }
}

function typeReferences(kind: WitToolsTypeKind): WitToolsTypeReference[] {
    if (typeof kind === 'string') return [];
    if ('record' in kind) return kind.record.fields.flatMap(({ type }) => (type === null ? [] : [type]));
    if ('variant' in kind) return kind.variant.cases.flatMap(({ type }) => (type === null ? [] : [type]));
    if ('enum' in kind || 'flags' in kind) return [];
    if ('option' in kind || 'list' in kind || 'type' in kind) return [Object.values(kind)[0] as WitToolsTypeReference];
    if ('result' in kind)
        return [kind.result.ok, kind.result.err].filter((type): type is WitToolsTypeReference => type !== null);
    if ('tuple' in kind) return kind.tuple.types;
    return [Object.values(kind.handle)[0] as number];
}

function assertTypeReference(reference: WitToolsTypeReference, document: WitToolsDocument, at: string): void {
    if (typeof reference === 'number') assertIndex(reference, document.types.length, at);
}

function assertIndex(index: number, length: number, at: string): void {
    if (index < 0 || index >= length) throw new Error(`WIT JSON type reference ${index} is out of range at ${at}`);
}

function objectAt(value: unknown, at: string): JsonObject {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new Error(`Invalid wasm-tools WIT JSON at ${at}: expected an object`);
    return value as JsonObject;
}

function arrayAt(value: unknown, at: string): unknown[] {
    if (!Array.isArray(value)) throw new Error(`Invalid wasm-tools WIT JSON at ${at}: expected an array`);
    return value;
}

function stringAt(value: unknown, at: string): string {
    if (typeof value !== 'string') throw new Error(`Invalid wasm-tools WIT JSON at ${at}: expected a string`);
    return value;
}

function integerAt(value: unknown, at: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new Error(`Invalid wasm-tools WIT JSON at ${at}: expected a non-negative integer`);
    }
    return value;
}
