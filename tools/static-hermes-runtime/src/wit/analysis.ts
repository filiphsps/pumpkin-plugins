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
    WitWasiInterface,
} from './types.ts';

/** Explicit API/WASI selections used to construct a WIT usage plan. */
export interface WitAnalysisOptions {
    /** Optional Pumpkin API operation identifiers; omission includes every declared operation. */
    apiMethods?: readonly string[];
    /** Optional statically registered event names; omission includes every declared event case. */
    eventTypes?: readonly string[];
    /** Plugin WIT import order, used to keep generated interface ordering stable. */
    pluginImportOrder?: readonly string[];
    /** WASI interface specifiers explicitly requested by the component build. */
    wasiImports?: readonly string[];
    /** Optional fully qualified WASI operation identifiers selected for adapter generation. */
    wasiMethods?: readonly string[];
}

/** Complete event records retained for JavaScript callbacks. */
export interface WitEventFieldSelection {
    /** Declared event case supported by the dispatcher. */
    event: string;
    /** All fields declared by the event payload record. */
    fields: string[];
    /** WIT record associated with the event case. */
    record: string;
}

/** Resolved API and WASI operations, features, adapters, and event fields for a build. */
export interface WitAnalysis {
    /** Fully resolved signatures and adapter shapes for selected Pumpkin operations. */
    apiAdapters: WitApiAdapterPlan[];
    /** Pumpkin API interface specifiers available to the plugin. */
    apiInterfaces: string[];
    /** Pumpkin operations selected for native dispatch. */
    apiMethods: string[];
    /** Selected declared event cases and their complete payload fields. */
    eventFields: WitEventFieldSelection[];
    /** Resolved WASI interfaces consumed by adapter generation. */
    resolvedWasiInterfaces: WitWasiInterface[];
    /** Fully resolved signatures and adapter shapes for selected WASI operations. */
    wasiAdapters: WitWasiAdapterPlan[];
    /** Feature flags required by the selected WASI operations. */
    wasiFeatures: string[];
    /** Direct WASI interface specifiers selected for the plugin. */
    wasiImports: string[];
    /** WASI interface specifiers in the selected dependency closure. */
    wasiInterfaces: string[];
    /** WASI operation identifiers selected for adapter generation. */
    wasiMethods: string[];
}

interface WitOperation<Interface extends WitApiInterface = WitApiInterface> {
    apiInterface: Interface;
    kind: WitWasiAdapterPlan['kind'];
    operation: WitFunction;
    operationId: string;
    resource?: WitResource;
}

/** Build an operation identifier from its interface and `<operation>` or `<resource>.<operation>` path. */
type OperationIdFormat = (apiInterface: WitApiInterface, path: string) => string;

const apiOperationId: OperationIdFormat = (apiInterface, path) => `${apiInterface.name}.${path}`;
const wasiOperationId: OperationIdFormat = (apiInterface, path) => `${apiInterface.specifier}#${path}`;

/**
 * Build a deterministic WIT usage plan from explicit selections, defaulting to all declared Pumpkin operations.
 *
 * @param resolved - Parsed and resolved WIT package graph.
 * @param options - Import ordering and optional API/WASI operation selections.
 * @returns API/WASI methods, required WASI features, adapters, and event payload fields.
 */
export function analyzeWitUsage(resolved: ResolvedWitDocument, options: WitAnalysisOptions): WitAnalysis {
    const apiPackage = resolvePluginApi(resolved, options.pluginImportOrder);
    const requestedWasiMethods = options.wasiMethods === undefined ? undefined : [...new Set(options.wasiMethods)];
    const wasiImports = [
        ...new Set([...(options.wasiImports ?? []), ...importsFromMethodIds(requestedWasiMethods ?? [])]),
    ];
    const wasi = resolveWasiImports(resolved, wasiImports, options.pluginImportOrder);
    const apiOperations = allOperations(apiPackage.interfaces, apiOperationId);
    const apiMethods = selectMethods(apiOperations, options.apiMethods, 'Pumpkin');
    const wasiOperations = allOperations(wasi.interfaces, wasiOperationId);
    const wasiMethods = selectMethods(wasiOperations, requestedWasiMethods, 'WASI');

    return {
        apiInterfaces: apiPackage.interfaces.map(({ specifier }) => specifier),
        apiMethods,
        apiAdapters: planAdapters(apiOperations, apiMethods, () => apiPackage.packageName),
        wasiImports: wasi.imports,
        wasiInterfaces: wasi.interfaces.map(({ specifier }) => specifier),
        resolvedWasiInterfaces: wasi.interfaces,
        wasiMethods,
        wasiFeatures: selectWasiFeatures({ interfaces: wasi.interfaces }, wasiMethods),
        wasiAdapters: planAdapters(
            wasiOperations,
            requestedWasiMethods && wasiMethods,
            (apiInterface) => apiInterface.packageName,
        ),
        eventFields: selectWitEventFields(apiPackage, options.eventTypes),
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
    usedMethods?: readonly string[],
): WitApiAdapterPlan[] {
    const operations = allOperations(apiPackage.interfaces, apiOperationId);
    const selected = usedMethods && selectMethods(operations, usedMethods, 'Pumpkin');
    return planAdapters(operations, selected, () => apiPackage.packageName);
}

/**
 * Retain complete payloads for selected events because JavaScript field access can be dynamic.
 *
 * @param apiPackage - Resolved Pumpkin API package containing the event variant and records.
 * @param eventTypes - Static event registrations; omission or an unknown event retains every case.
 * @returns Selected event cases and all fields from their payload records.
 */
export function selectWitEventFields(
    apiPackage: WitApiPackage,
    eventTypes?: readonly string[],
): WitEventFieldSelection[] {
    const eventInterface = apiPackage.interfaces.find(({ name }) => name === 'event');
    const eventVariant = eventInterface?.variants.find(({ name }) => name === 'event');
    if (!eventVariant) return [];
    const requestedEvents = eventTypes === undefined ? undefined : new Set(eventTypes);
    const hasUnknownEvent =
        requestedEvents &&
        [...requestedEvents].some((requested) => eventVariant.cases.every(({ name }) => name !== requested));
    const records = new Map(
        apiPackage.interfaces.flatMap(({ records: declarations }) =>
            declarations.map((record) => [record.name, record]),
        ),
    );
    const selected: WitEventFieldSelection[] = [];
    for (const event of eventVariant.cases) {
        if (requestedEvents && !hasUnknownEvent && !requestedEvents.has(event.name)) continue;
        const record = records.get(event.type.replace(/^%/, ''));
        if (!record) throw new Error(`WIT event ${event.name} refers to missing record ${event.type}`);
        const fields = record.fields.map(({ name }) => name);
        selected.push({ event: event.name, record: record.name, fields });
    }
    return selected;
}

function allOperations<Interface extends WitApiInterface>(
    interfaces: readonly Interface[],
    operationId: OperationIdFormat,
): WitOperation<Interface>[] {
    return interfaces.flatMap((apiInterface) => [
        ...apiInterface.functions.map((operation) => ({
            apiInterface,
            operation,
            operationId: operationId(apiInterface, operation.name),
            kind: 'function' as const,
        })),
        ...apiInterface.resources.flatMap((resource) =>
            resource.functions.map((operation) => ({
                apiInterface,
                operation,
                resource,
                operationId: operationId(apiInterface, `${resource.name}.${operation.name}`),
                kind:
                    operation.name === 'constructor'
                        ? ('resource-constructor' as const)
                        : operation.isStatic
                          ? ('resource-static-method' as const)
                          : ('resource-method' as const),
            })),
        ),
    ]);
}

function selectMethods(
    operations: readonly WitOperation[],
    requestedMethods: readonly string[] | undefined,
    owner: 'Pumpkin' | 'WASI',
): string[] {
    if (requestedMethods === undefined) return operations.map(({ operationId }) => operationId);
    const declared = new Set(operations.map(({ operationId }) => operationId));
    const selected = [...new Set(requestedMethods)];
    for (const method of selected) {
        if (!declared.has(method))
            throw new Error(`${owner} operation used by the plugin is not declared in WIT: ${method}`);
    }
    return selected;
}

/** Plan the selected operations, which must already be declared; omit the selection to plan them all. */
function planAdapters<Interface extends WitApiInterface>(
    operations: readonly WitOperation<Interface>[],
    selectedMethods: readonly string[] | undefined,
    packageName: (apiInterface: Interface) => string,
) {
    const selected = selectedMethods && new Set(selectedMethods);
    return operations.flatMap((entry) => {
        if (selected && !selected.has(entry.operationId)) return [];
        const parameters = entry.operation.parameters.map((parameter) =>
            resolveParameter(parameter, entry.operationId),
        );
        const resultType =
            entry.resource && entry.operation.name === 'constructor'
                ? resourceType(entry.apiInterface, entry.resource, packageName(entry.apiInterface))
                : requireResolvedType(entry.operation.resolvedResult, `${entry.operationId} result`);
        if (
            !isSupportedWitMethod(
                resultType,
                parameters.map(({ resolvedType }) => resolvedType),
            )
        ) {
            const path = entry.resource ? `${entry.resource.name}.${entry.operation.name}` : entry.operation.name;
            throw new Error(
                `No Static Hermes JSI adapter is generated for ${entry.apiInterface.specifier}#${path}: unsupported WIT input or result type`,
            );
        }
        return [
            {
                operationId: entry.operationId,
                kind: entry.kind,
                apiInterface: entry.apiInterface,
                ...(entry.resource ? { resource: entry.resource } : {}),
                operation: entry.operation,
                parameters,
                resultType,
            },
        ];
    });
}

function importsFromMethodIds(methods: readonly string[]): string[] {
    return methods.flatMap((method) => {
        const separator = method.indexOf('#');
        return separator > 0 ? [method.slice(0, separator)] : [];
    });
}

function resolveParameter(
    parameter: WitParameter,
    operationId: string,
): WitParameter & { resolvedType: ResolvedWitType } {
    return {
        ...parameter,
        resolvedType: requireResolvedType(parameter.resolvedType, `${operationId} parameter ${parameter.name}`),
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
        declaredInterface: apiInterface.name,
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
