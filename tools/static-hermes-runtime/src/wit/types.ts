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
    /** Declared name of the resource or data type. */
    name: string;
    /** Name of the interface that declares or owns this type. */
    interfaceName: string;
    /** Fully qualified package name that owns the interface. */
    packageName: string;
    /** Fully qualified WIT specifier for the declaring interface. */
    interfaceSpecifier: string;
    /** Other interfaces whose types are referenced by this declaration. */
    interfaceDependencies: string[];
    /** Original declaring interface when this type is reached through an alias. */
    declaredInterface?: string;
    /** Original alias name when this type is referenced through an alias. */
    aliasName?: string;
}

/** Alias and owner metadata retained while resolving WIT types. */
export interface WitTypeAliasMetadata {
    /** Interface where the aliased type was declared. */
    declaredInterface?: string;
    /** Alias name used at the current reference site. */
    aliasName?: string;
    /** Package that owns the alias or anonymous container. */
    packageName?: string;
    /** Fully qualified interface that owns the alias or anonymous container. */
    interfaceSpecifier?: string;
}

/** Named parameter or field with its source and optional resolved type. */
export interface WitParameter {
    /** Parameter or field name from the WIT declaration. */
    name: string;
    /** Source type spelling retained alongside the resolved type model. */
    type: string;
    /** Structured type model, when resolution has completed. */
    resolvedType?: ResolvedWitType;
}

/** Function or resource method signature from a resolved WIT interface. */
export interface WitFunction {
    /** Function or resource operation name. */
    name: string;
    /** Whether this operation is a static resource method. */
    isStatic: boolean;
    /** WASI feature flags required by the operation, when declared. */
    features?: string[];
    /** Ordered input parameters. */
    parameters: WitParameter[];
    /** Source result type spelling; `unit` represents no result value. */
    result: string;
    /** Structured result type model, when resolution has completed. */
    resolvedResult?: ResolvedWitType;
}

/** Named WIT resource and its constructors, static methods, and instance methods. */
export interface WitResource {
    /** Resource name within its declaring interface. */
    name: string;
    /** Constructors, static methods, and instance methods declared by the resource. */
    functions: WitFunction[];
}

/** Named field in a WIT record. */
export interface WitRecordField extends WitParameter {}

/** WIT record declaration with its named fields. */
export interface WitRecord {
    /** Record name within its declaring interface. */
    name: string;
    /** Ordered fields in the record declaration. */
    fields: WitRecordField[];
}

/** WIT variant case and its optional payload type. */
export interface WitVariantCase extends WitParameter {}

/** WIT variant declaration with its cases. */
export interface WitVariant {
    /** Variant name within its declaring interface. */
    name: string;
    /** Ordered cases in the variant declaration. */
    cases: WitVariantCase[];
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
    /** Source spelling of the aliased type. */
    type: string;
    /** Structured model of the aliased target type. */
    resolvedType: ResolvedWitType;
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
    /** Interface name within its package. */
    name: string;
    /** Fully qualified WIT interface specifier. */
    specifier: string;
    /** Owning package name, when supplied by the resolved document. */
    packageName?: string;
    /** Owning package version, when supplied by the resolved document. */
    version?: string;
    /** Freestanding operations declared by the interface. */
    functions: WitFunction[];
    /** Resources and their operations declared by the interface. */
    resources: WitResource[];
    /** Record declarations in source order. */
    records: WitRecord[];
    /** Variant declarations in source order. */
    variants: WitVariant[];
    /** Enum declarations in source order. */
    enums: WitEnum[];
    /** Flags declarations in source order. */
    flags: WitEnum[];
    /** Type aliases declared by the interface. */
    types: WitTypeAlias[];
    /** Fully qualified interfaces referenced by this interface. */
    dependencies?: string[];
    /** Imported dependency types grouped by interface specifier. */
    dependencyTypes?: Record<string, string[]>;
    /** Local dependency aliases and the interfaces they name. */
    dependencyAliases?: Record<string, WitDependencyAlias>;
}

/** Package identity and resolved interfaces for a WIT package. */
export interface WitApiPackage {
    /** Fully qualified package name. */
    packageName: string;
    /** Package version, or `undefined` when the WIT source omits one. */
    version: string | undefined;
    /** Resolved interfaces selected from this package. */
    interfaces: WitApiInterface[];
}

/** WASI interface with the package identity and dependency graph needed for linking. */
export interface WitWasiInterface extends WitApiInterface {
    /** Fully qualified WASI package name. */
    packageName: string;
    /** WASI package version, or `undefined` when omitted. */
    version: string | undefined;
    /** Transitive interface dependencies required to resolve this import. */
    dependencies: string[];
    /** Imported dependency types grouped by interface specifier. */
    dependencyTypes: Record<string, string[]>;
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
    /** Stable identifier in `<interface specifier>#<operation path>` form. */
    operationId: string;
    /** Native adapter shape required for this operation. */
    kind: 'function' | 'resource-constructor' | 'resource-static-method' | 'resource-method';
    /** Interface declaring the operation. */
    apiInterface: WitWasiInterface;
    /** Resource owner for constructor or resource-method operations. */
    resource?: WitResource;
    /** Resolved operation signature. */
    operation: WitFunction;
    /** Parameters paired with their fully resolved types. */
    parameters: Array<WitParameter & { resolvedType: ResolvedWitType }>;
    /** Fully resolved result type. */
    resultType: ResolvedWitType;
}

/** One selected Pumpkin operation with the resolved types required for native dispatch generation. */
export interface WitApiAdapterPlan {
    /** Stable operation identifier in `<interface>.<resource>.<operation>` form. */
    operationId: string;
    /** Native adapter shape required for this operation. */
    kind: 'function' | 'resource-constructor' | 'resource-static-method' | 'resource-method';
    /** Interface declaring the operation. */
    apiInterface: WitApiInterface;
    /** Resource owner for constructor or resource-method operations. */
    resource?: WitResource;
    /** Resolved operation signature. */
    operation: WitFunction;
    /** Parameters paired with their fully resolved types. */
    parameters: Array<WitParameter & { resolvedType: ResolvedWitType }>;
    /** Fully resolved result type. */
    resultType: ResolvedWitType;
}
