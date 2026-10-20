/** Resolved WIT type values used by analysis and generators. */
export type ResolvedWitType =
    | { kind: 'primitive'; name: string; aliasName?: string; declaredInterface?: string }
    | { kind: 'unit' }
    | ({ kind: 'borrow'; item: ResolvedWitType } & WitTypeAliasMetadata)
    | ({ kind: 'list' | 'option'; item: ResolvedWitType } & WitTypeAliasMetadata)
    | ({ kind: 'tuple'; items: ResolvedWitType[] } & WitTypeAliasMetadata)
    | ({ kind: 'result'; ok: ResolvedWitType; error: ResolvedWitType } & WitTypeAliasMetadata)
    | (WitOwnedType & { kind: 'resource' })
    | (WitOwnedType & { kind: 'record'; fields: WitRecordField[] })
    | (WitOwnedType & { kind: 'variant'; cases: WitVariantCase[] })
    | (WitOwnedType & { kind: 'enum' | 'flags'; values: string[] })
    | { kind: 'unsupported'; source: string };

/** Qualified identity shared by named WIT resources and data types. */
export interface WitOwnedType {
    /** Original alias name when this type is referenced through an alias. */
    aliasName?: string;
    /** Original declaring interface when this type is reached through an alias. */
    declaredInterface?: string;
    /** Whether wit-bindgen emitted a standalone C cleanup function for this value. */
    hasGeneratedFreeFunction?: boolean;
    /** Other interfaces whose types are referenced by this declaration. */
    interfaceDependencies: string[];
    /** Name of the interface that declares or owns this type. */
    interfaceName: string;
    /** Fully qualified WIT specifier for the declaring interface. */
    interfaceSpecifier: string;
    /** Declared name of the resource or data type. */
    name: string;
    /** Fully qualified package name that owns the interface. */
    packageName: string;
}

/** Alias and owner metadata retained while resolving WIT types. */
export interface WitTypeAliasMetadata {
    /** Alias name used at the current reference site. */
    aliasName?: string;
    /** Interface where the aliased type was declared. */
    declaredInterface?: string;
    /** Whether wit-bindgen emitted a standalone C cleanup function for this value. */
    hasGeneratedFreeFunction?: boolean;
    /** Fully qualified interface that owns the alias or anonymous container. */
    interfaceSpecifier?: string;
    /** Package that owns the alias or anonymous container. */
    packageName?: string;
}

/** Named parameter or field with its source and optional resolved type. */
export interface WitParameter {
    /** Parameter or field name from the WIT declaration. */
    name: string;
    /** Structured type model, when resolution has completed. */
    resolvedType?: ResolvedWitType;
    /** Source type spelling retained alongside the resolved type model. */
    type: string;
}

/** Function or resource method signature from a resolved WIT interface. */
export interface WitFunction {
    /** WASI feature flags required by the operation, when declared. */
    features?: string[];
    /** Whether this operation is a static resource method. */
    isStatic: boolean;
    /** Function or resource operation name. */
    name: string;
    /** Ordered input parameters. */
    parameters: WitParameter[];
    /** Structured result type model, when resolution has completed. */
    resolvedResult?: ResolvedWitType;
    /** Source result type spelling; `unit` represents no result value. */
    result: string;
}

/** Named WIT resource and its constructors, static methods, and instance methods. */
export interface WitResource {
    /** Constructors, static methods, and instance methods declared by the resource. */
    functions: WitFunction[];
    /** Resource name within its declaring interface. */
    name: string;
}

/** Named field in a WIT record. */
export interface WitRecordField extends WitParameter {}

/** WIT record declaration with its named fields. */
export interface WitRecord {
    /** Ordered fields in the record declaration. */
    fields: WitRecordField[];
    /** Record name within its declaring interface. */
    name: string;
}

/** WIT variant case and its optional payload type. */
export interface WitVariantCase extends WitParameter {}

/** WIT variant declaration with its cases. */
export interface WitVariant {
    /** Ordered cases in the variant declaration. */
    cases: WitVariantCase[];
    /** Variant name within its declaring interface. */
    name: string;
}

/** WIT enum or flags declaration and its values. */
export interface WitEnum {
    /** Enum or flags declaration name. */
    name: string;
    /** Declared enum cases or flag names in source order. */
    values: string[];
}

/** Named WIT type alias and its resolved target type. */
export interface WitTypeAlias {
    /** Alias name within its declaring interface. */
    name: string;
    /** Structured model of the aliased target type. */
    resolvedType: ResolvedWitType;
    /** Source spelling of the aliased type. */
    type: string;
}

/** Imported interface alias and the fully qualified interface it names. */
export interface WitDependencyAlias {
    /** Local alias used for an imported interface. */
    name: string;
    /** Fully qualified WIT interface specifier. */
    specifier: string;
}

/** Parsed WIT interface containing its operations, resources, and named types. */
export interface WitApiInterface {
    /** Fully qualified interfaces referenced by this interface. */
    dependencies?: string[];
    /** Local dependency aliases and the interfaces they name. */
    dependencyAliases?: Record<string, WitDependencyAlias>;
    /** Imported dependency types grouped by interface specifier. */
    dependencyTypes?: Record<string, string[]>;
    /** Enum declarations in source order. */
    enums: WitEnum[];
    /** Flags declarations in source order. */
    flags: WitEnum[];
    /** Freestanding operations declared by the interface. */
    functions: WitFunction[];
    /** Interface name within its package. */
    name: string;
    /** Owning package name, when supplied by the resolved document. */
    packageName?: string;
    /** Record declarations in source order. */
    records: WitRecord[];
    /** Resources and their operations declared by the interface. */
    resources: WitResource[];
    /** Fully qualified WIT interface specifier. */
    specifier: string;
    /** Type aliases declared by the interface. */
    types: WitTypeAlias[];
    /** Variant declarations in source order. */
    variants: WitVariant[];
    /** Owning package version, when supplied by the resolved document. */
    version?: string;
}

/** Package identity and resolved interfaces for a WIT package. */
export interface WitApiPackage {
    /** Resolved interfaces selected from this package. */
    interfaces: WitApiInterface[];
    /** Fully qualified package name. */
    packageName: string;
    /** Package version, or `undefined` when the WIT source omits one. */
    version: string | undefined;
}

/** WASI interface with the package identity and dependency graph needed for linking. */
export interface WitWasiInterface extends WitApiInterface {
    /** Transitive interface dependencies required to resolve this import. */
    dependencies: string[];
    /** Imported dependency types grouped by interface specifier. */
    dependencyTypes: Record<string, string[]>;
    /** Fully qualified WASI package name. */
    packageName: string;
    /** WASI package version, or `undefined` when omitted. */
    version: string | undefined;
}

/** Requested WASI imports and their resolved interface definitions. */
export interface WitWasiImports {
    /** Direct WASI interface specifiers requested by the plugin. */
    imports: string[];
    /** Direct interfaces and their transitive dependency closure. */
    interfaces: WitWasiInterface[];
}

/** One selected WASI operation and the type information needed to emit its adapter. */
export interface WitWasiAdapterPlan {
    /** Interface declaring the operation. */
    apiInterface: WitWasiInterface;
    /** Native adapter shape required for this operation. */
    kind: 'function' | 'resource-constructor' | 'resource-static-method' | 'resource-method';
    /** Resolved operation signature. */
    operation: WitFunction;
    /** Stable identifier in `<interface specifier>#<operation path>` form. */
    operationId: string;
    /** Parameters paired with their fully resolved types. */
    parameters: Array<WitParameter & { resolvedType: ResolvedWitType }>;
    /** Resource owner for constructor or resource-method operations. */
    resource?: WitResource;
    /** Fully resolved result type. */
    resultType: ResolvedWitType;
}

/** One selected Pumpkin operation with the resolved types required for native dispatch generation. */
export interface WitApiAdapterPlan {
    /** Interface declaring the operation. */
    apiInterface: WitApiInterface;
    /** Native adapter shape required for this operation. */
    kind: 'function' | 'resource-constructor' | 'resource-static-method' | 'resource-method';
    /** Resolved operation signature. */
    operation: WitFunction;
    /** Stable operation identifier in `<interface>.<resource>.<operation>` form. */
    operationId: string;
    /** Parameters paired with their fully resolved types. */
    parameters: Array<WitParameter & { resolvedType: ResolvedWitType }>;
    /** Resource owner for constructor or resource-method operations. */
    resource?: WitResource;
    /** Fully resolved result type. */
    resultType: ResolvedWitType;
}

/** List the resources a resolved type holds, at any depth. */
export function resourcesIn(type: ResolvedWitType | undefined): Extract<ResolvedWitType, { kind: 'resource' }>[] {
    if (!type) return [];
    switch (type.kind) {
        case 'resource':
            return [type];
        case 'borrow':
        case 'list':
        case 'option':
            return resourcesIn(type.item);
        case 'tuple':
            return type.items.flatMap(resourcesIn);
        case 'record':
            return type.fields.flatMap(({ resolvedType }) => resourcesIn(resolvedType));
        case 'variant':
            return type.cases.flatMap(({ resolvedType }) => resourcesIn(resolvedType));
        case 'result':
            return [...resourcesIn(type.ok), ...resourcesIn(type.error)];
        default:
            return [];
    }
}
