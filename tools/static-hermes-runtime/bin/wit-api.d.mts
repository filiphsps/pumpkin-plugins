export interface WitParameter {
    name: string;
    type: string;
}

export interface WitFunction {
    name: string;
    isStatic: boolean;
    features?: string[];
    parameters: WitParameter[];
    result: string;
}

export interface WitResource {
    name: string;
    functions: WitFunction[];
}

export interface WitRecord {
    name: string;
    fields: WitParameter[];
}

export interface WitVariant {
    name: string;
    cases: WitParameter[];
}

export interface WitEnum {
    name: string;
    values: string[];
}

export interface WitTypeAlias {
    name: string;
    type: string;
}

export interface WitDependencyAlias {
    name: string;
    specifier: string;
}

export interface WitApiInterface {
    name: string;
    specifier: string;
    functions: WitFunction[];
    resources: WitResource[];
    records: WitRecord[];
    variants: WitVariant[];
    enums: WitEnum[];
    flags: WitEnum[];
    types: WitTypeAlias[];
    dependencies?: string[];
    dependencyAliases?: Record<string, WitDependencyAlias>;
}

export interface WitApiPackage {
    packageName: string;
    version: string | undefined;
    interfaces: WitApiInterface[];
}

export interface WitWasiInterface extends WitApiInterface {
    packageName: string;
    version: string | undefined;
    dependencies: string[];
    dependencyTypes: Record<string, string[]>;
}

export interface WitWasiImports {
    imports: string[];
    interfaces: WitWasiInterface[];
}

export interface WitWasiAdapterPlan {
    operationId: string;
    kind: 'function' | 'resource-constructor' | 'resource-static-method' | 'resource-method';
    apiInterface: WitWasiInterface;
    resource?: WitResource;
    operation: WitFunction;
    parameters: Array<WitParameter & { resolvedType: unknown }>;
    resultType: unknown;
}

export function readWitPackage(witDir: string): WitApiPackage;
export function readWasiWitImports(witDir: string, requestedImports?: string[]): WitWasiImports;
export function wasiFeaturesForMethods(witDir: string, usedMethods?: string[]): string[];
export function generateEsmFacade(apiInterface: WitApiInterface, allInterfaces?: WitApiInterface[]): string;
export function generateWasiEsmFacade(apiInterface: WitWasiInterface): string;
export function generateWitSimpleMethodDispatch(
    apiPackage: WitApiPackage,
    bundleSource?: string,
    apiMethods?: string[]
): string;
export function planWasiAdapterDispatch(
    selectedInterfaces: WitWasiInterface[],
    allInterfaces?: WitWasiInterface[],
    usedMethods?: string[]
): WitWasiAdapterPlan[];
export function generateWasiAdapterDispatch(
    selectedInterfaces: WitWasiInterface[],
    allInterfaces?: WitWasiInterface[],
    usedMethods?: string[]
): string;
export function generateWitEventDispatch(apiPackage: WitApiPackage, bundleSource?: string): string;
