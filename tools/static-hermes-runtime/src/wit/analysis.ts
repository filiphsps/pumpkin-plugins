import { type ResolvedWitDocument, resolvePluginApi, resolveWasiImports, selectWasiFeatures } from './resolver.ts';
import type {
    ResolvedWitType,
    WitApiAdapterPlan,
    WitApiInterface,
    WitApiPackage,
    WitFunction,
    WitParameter,
    WitResource,
    WitWasiAdapterPlan,
    WitWasiInterface
} from './types.ts';

/** Bundle contents and explicit API/WASI selections used to construct a WIT usage plan. */
export interface WitAnalysisOptions {
    /** Bundled JavaScript used to infer Pumpkin methods when no explicit selection is available. */
    bundleSource: string;
    /** Plugin WIT import order, used to keep generated interface ordering stable. */
    pluginImportOrder?: readonly string[];
    /** WASI interface specifiers explicitly requested by the component build. */
    wasiImports?: readonly string[];
    /** Optional fully qualified WASI operation identifiers selected for adapter generation. */
    wasiMethods?: readonly string[];
    /** Optional fully qualified Pumpkin API operation identifiers selected for dispatch generation. */
    apiMethods?: readonly string[];
}

/** Complete event records retained for JavaScript callbacks. */
export interface WitEventFieldSelection {
    /** Declared event case supported by the dispatcher. */
    event: string;
    /** WIT record associated with the event case. */
    record: string;
    /** All fields declared by the event payload record. */
    fields: string[];
}

/** Resolved API and WASI operations, features, adapters, and event fields for a build. */
export interface WitAnalysis {
    /** Pumpkin API interface specifiers available to the plugin. */
    apiInterfaces: string[];
    /** Pumpkin operations selected for native dispatch. */
    apiMethods: string[];
    /** Fully resolved signatures and adapter shapes for selected Pumpkin operations. */
    apiAdapters: WitApiAdapterPlan[];
    /** Direct WASI interface specifiers selected for the plugin. */
    wasiImports: string[];
    /** WASI interface specifiers in the selected dependency closure. */
    wasiInterfaces: string[];
    /** Resolved WASI interfaces consumed by adapter generation. */
    resolvedWasiInterfaces: WitWasiInterface[];
    /** WASI operation identifiers selected for adapter generation. */
    wasiMethods: string[];
    /** Feature flags required by the selected WASI operations. */
    wasiFeatures: string[];
    /** Fully resolved signatures and adapter shapes for selected WASI operations. */
    wasiAdapters: WitWasiAdapterPlan[];
    /** All declared event cases and their complete payload fields. */
    eventFields: WitEventFieldSelection[];
}

interface WitOperation {
    apiInterface: WitApiInterface;
    operation: WitFunction;
    resource?: WitResource;
    operationId: string;
    kind: WitWasiAdapterPlan['kind'];
}

/**
 * Analyze explicit method selections and bundle scans into a deterministic WIT usage plan.
 *
 * @param resolved - Parsed and resolved WIT package graph.
 * @param options - Bundle source, import ordering, and optional operation selections.
 * @returns API/WASI methods, required WASI features, adapters, and event payload fields.
 */
export function analyzeWitUsage(resolved: ResolvedWitDocument, options: WitAnalysisOptions): WitAnalysis {
    const apiPackage = resolvePluginApi(resolved, options.pluginImportOrder);
    const requestedWasiMethods = options.wasiMethods === undefined ? undefined : [...new Set(options.wasiMethods)];
    const wasiImports = [
        ...new Set([...(options.wasiImports ?? []), ...importsFromMethodIds(requestedWasiMethods ?? [])])
    ];
    const wasi = resolveWasiImports(resolved, wasiImports, options.pluginImportOrder);
    const apiOperations = allApiOperations(apiPackage);
    const apiMethods = selectApiMethods(apiOperations, options.bundleSource, options.apiMethods);
    const wasiOperations = allWasiOperations(wasi.interfaces);
    const wasiMethods = selectWasiMethods(wasiOperations, requestedWasiMethods);

    return {
        apiInterfaces: apiPackage.interfaces.map(({ specifier }) => specifier),
        apiMethods,
        apiAdapters: planApiAdapterOperations(apiPackage, apiMethods),
        wasiImports: wasi.imports,
        wasiInterfaces: wasi.interfaces.map(({ specifier }) => specifier),
        resolvedWasiInterfaces: wasi.interfaces,
        wasiMethods,
        wasiFeatures: selectWasiFeatures({ interfaces: wasi.interfaces }, wasiMethods),
        wasiAdapters: planWasiAdapterOperations(wasi.interfaces, requestedWasiMethods),
        eventFields: selectWitEventFields(apiPackage, options.bundleSource)
    };
}

/**
 * Plan Pumpkin API adapters using only resolved parameter and result types.
 *
 * @param apiPackage - Resolved Pumpkin package graph.
 * @param usedMethods - Operation identifiers to include; omitted to plan every declared operation.
 * @returns Adapter plans with parameter and result types resolved for native generation.
 * @throws {Error} If a selected operation is undeclared or has no supported JSI adapter.
 */
export function planApiAdapterOperations(
    apiPackage: WitApiPackage,
    usedMethods?: readonly string[]
): WitApiAdapterPlan[] {
    const selected = usedMethods === undefined ? undefined : new Set(usedMethods);
    const declared = new Set<string>();
    const plans: WitApiAdapterPlan[] = [];
    for (const entry of allApiOperations(apiPackage)) {
        declared.add(entry.operationId);
        if (selected && !selected.has(entry.operationId)) continue;
        const parameters = entry.operation.parameters.map((parameter) =>
            resolveParameter(parameter, entry.operationId)
        );
        const resultType =
            entry.resource && entry.operation.name === 'constructor'
                ? resourceType(entry.apiInterface, entry.resource, apiPackage.packageName)
                : requireResolvedType(entry.operation.resolvedResult, `${entry.operationId} result`);
        if (
            !isSupportedWitMethod(
                resultType,
                parameters.map(({ resolvedType }) => resolvedType)
            )
        ) {
            const path = entry.resource ? `${entry.resource.name}.${entry.operation.name}` : entry.operation.name;
            throw new Error(
                `No Static Hermes adapter is generated for ${entry.apiInterface.specifier}#${path}: unsupported WIT input or result type`
            );
        }
        plans.push({
            operationId: entry.operationId,
            kind: entry.kind,
            apiInterface: entry.apiInterface,
            ...(entry.resource ? { resource: entry.resource } : {}),
            operation: entry.operation,
            parameters,
            resultType
        });
    }
    for (const operationId of selected ?? []) {
        if (!declared.has(operationId)) {
            throw new Error(`Pumpkin operation used by the plugin is not declared in WIT: ${operationId}`);
        }
    }
    return plans;
}

/**
 * Plan WASI adapters using only already-resolved parameter and result types.
 *
 * @param selectedInterfaces - Interfaces in the selected WASI import closure.
 * @param usedMethods - Optional operation IDs to include; when omitted, plan every operation.
 * @returns Adapter plans with parameter and result types resolved for native generation.
 * @throws {Error} If a selected operation is undeclared or has no supported JSI adapter.
 */
export function planWasiAdapterOperations(
    selectedInterfaces: readonly WitWasiInterface[],
    usedMethods?: readonly string[]
): WitWasiAdapterPlan[] {
    const selected = usedMethods === undefined ? undefined : new Set(usedMethods);
    const declared = new Set<string>();
    const plans: WitWasiAdapterPlan[] = [];
    for (const apiInterface of selectedInterfaces) {
        for (const entry of allWasiOperations([apiInterface])) {
            declared.add(entry.operationId);
            if (selected && !selected.has(entry.operationId)) continue;
            const parameters = entry.operation.parameters.map((parameter) =>
                resolveParameter(parameter, entry.operationId)
            );
            const resultType =
                entry.resource && entry.operation.name === 'constructor'
                    ? resourceType(apiInterface, entry.resource, apiInterface.packageName)
                    : requireResolvedType(entry.operation.resolvedResult, `${entry.operationId} result`);
            if (
                !isSupportedWitMethod(
                    resultType,
                    parameters.map(({ resolvedType }) => resolvedType)
                )
            ) {
                throw new Error(`No Static Hermes JSI adapter is generated for ${entry.operationId}`);
            }
            plans.push({
                operationId: entry.operationId,
                kind: entry.kind,
                apiInterface,
                ...(entry.resource ? { resource: entry.resource } : {}),
                operation: entry.operation,
                parameters,
                resultType
            });
        }
    }
    for (const operationId of selected ?? []) {
        if (!declared.has(operationId)) {
            throw new Error(`WASI operation used by the plugin is not declared in WIT: ${operationId}`);
        }
    }
    return plans;
}

/**
 * Retain complete event payloads because JavaScript tags and field access can be dynamic.
 *
 * @param apiPackage - Resolved Pumpkin API package containing the event variant and records.
 * @param _bundleSource - Bundle source retained for compatibility; never used to prune payloads.
 * @returns Every declared event case and all fields from its payload record.
 */
export function selectWitEventFields(apiPackage: WitApiPackage, _bundleSource: string): WitEventFieldSelection[] {
    const eventInterface = apiPackage.interfaces.find(({ name }) => name === 'event');
    const eventVariant = eventInterface?.variants.find(({ name }) => name === 'event');
    if (!eventVariant) return [];
    const records = new Map(
        apiPackage.interfaces.flatMap(({ records: declarations }) =>
            declarations.map((record) => [record.name, record])
        )
    );
    const selected: WitEventFieldSelection[] = [];
    for (const event of eventVariant.cases) {
        const record = records.get(event.type.replace(/^%/, ''));
        if (!record) throw new Error(`WIT event ${event.name} refers to missing record ${event.type}`);
        const fields = record.fields.map(({ name }) => name);
        selected.push({ event: event.name, record: record.name, fields });
    }
    return selected;
}

function allApiOperations(apiPackage: WitApiPackage): WitOperation[] {
    return apiPackage.interfaces.flatMap((apiInterface) => [
        ...apiInterface.functions.map((operation) => ({
            apiInterface,
            operation,
            operationId: `${apiInterface.name}.${operation.name}`,
            kind: 'function' as const
        })),
        ...apiInterface.resources.flatMap((resource) =>
            resource.functions.map((operation) => ({
                apiInterface,
                operation,
                resource,
                operationId: `${apiInterface.name}.${resource.name}.${operation.name}`,
                kind:
                    operation.name === 'constructor'
                        ? ('resource-constructor' as const)
                        : operation.isStatic
                          ? ('resource-static-method' as const)
                          : ('resource-method' as const)
            }))
        )
    ]);
}

function allWasiOperations(interfaces: readonly WitWasiInterface[]): WitOperation[] {
    return interfaces.flatMap((apiInterface) => [
        ...apiInterface.functions.map((operation) => ({
            apiInterface,
            operation,
            operationId: `${apiInterface.specifier}#${operation.name}`,
            kind: 'function' as const
        })),
        ...apiInterface.resources.flatMap((resource) =>
            resource.functions.map((operation) => ({
                apiInterface,
                operation,
                resource,
                operationId: `${apiInterface.specifier}#${resource.name}.${operation.name}`,
                kind:
                    operation.name === 'constructor'
                        ? ('resource-constructor' as const)
                        : operation.isStatic
                          ? ('resource-static-method' as const)
                          : ('resource-method' as const)
            }))
        )
    ]);
}

function selectApiMethods(
    operations: WitOperation[],
    bundleSource: string,
    requestedMethods?: readonly string[]
): string[] {
    const byId = new Map(operations.map((entry) => [entry.operationId, entry]));
    if (requestedMethods !== undefined) {
        const selected = [...new Set(requestedMethods)];
        for (const method of selected) {
            if (!byId.has(method))
                throw new Error(`Pumpkin operation used by the plugin is not declared in WIT: ${method}`);
        }
        return selected;
    }
    if (isEsbuildIifeBundle(bundleSource)) return operations.map(({ operationId }) => operationId);
    return operations
        .filter((entry) => bundleUsesApiOperation(bundleSource, entry))
        .map(({ operationId }) => operationId);
}

function isEsbuildIifeBundle(bundleSource: string): boolean {
    return /^\s*var\s+[$\w]+\s*=\s*\(\(\)\s*=>\s*\{/.test(bundleSource);
}

function selectWasiMethods(operations: WitOperation[], requestedMethods?: readonly string[]): string[] {
    if (requestedMethods === undefined) return operations.map(({ operationId }) => operationId);
    const declared = new Set(operations.map(({ operationId }) => operationId));
    const selected = [...new Set(requestedMethods)];
    for (const method of selected) {
        if (!declared.has(method))
            throw new Error(`WASI operation used by the plugin is not declared in WIT: ${method}`);
    }
    return selected;
}

function bundleUsesApiOperation(bundleSource: string, entry: WitOperation): boolean {
    const { operation, resource, apiInterface } = entry;
    if (!resource) {
        const imports = /import\s*\{([^}]+)\}\s*from\s*(["'])([^"']+)\2/g;
        for (const match of bundleSource.matchAll(imports)) {
            if (match[3] !== apiInterface.specifier) continue;
            const importedBindings = match[1];
            if (importedBindings === undefined) continue;
            for (const binding of importedBindings.split(',')) {
                const names = /^\s*([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(binding);
                if (!names || names[1] !== jsName(operation.name)) continue;
                const localName = names[2] ?? names[1];
                return new RegExp(`\\b${escapeRegExp(localName)}\\s*\\(`).test(bundleSource);
            }
        }
        return false;
    }
    if (operation.name === 'constructor')
        return new RegExp(`\\bnew\\s+${escapeRegExp(jsClassName(resource.name))}\\s*\\(`).test(bundleSource);
    return new RegExp(`\\.${escapeRegExp(jsName(operation.name))}\\s*\\(`).test(bundleSource);
}

function importsFromMethodIds(methods: readonly string[]): string[] {
    return methods.flatMap((method) => {
        const separator = method.indexOf('#');
        return separator > 0 ? [method.slice(0, separator)] : [];
    });
}

function resolveParameter(
    parameter: WitParameter,
    operationId: string
): WitParameter & { resolvedType: ResolvedWitType } {
    return {
        ...parameter,
        resolvedType: requireResolvedType(parameter.resolvedType, `${operationId} parameter ${parameter.name}`)
    };
}

function requireResolvedType(type: ResolvedWitType | undefined, name: string): ResolvedWitType {
    if (!type) throw new Error(`WIT resolver did not resolve ${name}`);
    return type;
}

function resourceType(apiInterface: WitApiInterface, resource: WitResource, packageName: string): ResolvedWitType {
    return {
        kind: 'resource',
        name: resource.name,
        interfaceName: apiInterface.name,
        packageName,
        interfaceSpecifier: apiInterface.specifier,
        interfaceDependencies: apiInterface.dependencies ?? [],
        declaredInterface: apiInterface.name
    };
}

function isSupportedWitMethod(result: ResolvedWitType, parameters: ResolvedWitType[]): boolean {
    return parameters.every(isSupportedWitInput) && isSupportedWitResult(result);
}

function isSupportedWitInput(type: ResolvedWitType): boolean {
    if (type.kind === 'unit' || ['primitive', 'enum', 'flags', 'resource'].includes(type.kind)) return true;
    if (type.kind === 'borrow') return type.item.kind === 'resource';
    if (type.kind === 'record')
        return type.fields.every(({ resolvedType }) => resolvedType && isSupportedWitInput(resolvedType));
    if (type.kind === 'variant')
        return type.cases.every(({ resolvedType }) => !resolvedType || isSupportedWitInput(resolvedType));
    if (type.kind === 'option' || type.kind === 'list') return isSupportedWitInput(type.item);
    if (type.kind === 'tuple') return type.items.every(isSupportedWitInput);
    if (type.kind === 'result') return isSupportedWitInput(type.ok) && isSupportedWitInput(type.error);
    return false;
}

function isSupportedWitResult(type: ResolvedWitType): boolean {
    if (type.kind === 'unit' || type.kind === 'primitive' || type.kind === 'enum' || type.kind === 'flags') return true;
    if (type.kind === 'resource' || type.kind === 'record' || type.kind === 'variant') {
        if (type.kind === 'record')
            return type.fields.every(({ resolvedType }) => resolvedType && isSupportedWitResult(resolvedType));
        if (type.kind === 'variant')
            return type.cases.every(({ resolvedType }) => !resolvedType || isSupportedWitResult(resolvedType));
        return true;
    }
    if (type.kind === 'option' || type.kind === 'list') return isSupportedWitResult(type.item);
    if (type.kind === 'tuple') return type.items.every(isSupportedWitResult);
    if (type.kind === 'result') return isSupportedWitResult(type.ok) && isSupportedWitResult(type.error);
    return false;
}

function jsName(name: string): string {
    return name.replace(/^%/, '').replace(/-([a-zA-Z0-9])/g, (_match, character: string) => character.toUpperCase());
}

function jsClassName(name: string): string {
    return name
        .replace(/^%/, '')
        .replace(/(^|[-_])([a-zA-Z0-9])/g, (_match, _separator: string, character: string) => character.toUpperCase());
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
