import type { WitAnalysis } from './analysis.ts';
import {
    annotateWitCleanupAvailability,
    generateWitApiFunctionForResolvedOperation,
    generateWitResourceMethodForResolvedPlan,
} from './native-adapters.ts';
import type { ResolvedWitType, WitApiPackage, WitFunction, WitResource, WitWasiInterface } from './types.ts';

/**
 * Generate WASI resource methods, resource drops, and interface host objects from a resolved plan.
 *
 * @param interfaces - Selected WASI interfaces and their transitive dependencies.
 * @param analysis - Resolved operation plans produced by WIT analysis.
 * @returns Deterministic C++ adapters for the selected WASI operations.
 * @throws {Error} If a selected operation cannot be generated from its resolved WIT types.
 */
export function generateWasiAdapterDispatch(
    interfaces: readonly WitWasiInterface[],
    analysis: WitAnalysis,
    availableFreeFunctions?: ReadonlySet<string>,
): string {
    const adapterPlans = availableFreeFunctions
        ? annotateWitCleanupAvailability(analysis.wasiAdapters, availableFreeFunctions)
        : analysis.wasiAdapters;
    const plansByOperation = new Map(adapterPlans.map((plan) => [plan.operationId, plan]));
    const usedResources = new Set<string>();
    for (const plan of analysis.wasiAdapters) {
        if (plan.resource) usedResources.add(`${plan.apiInterface.specifier}#${plan.resource.name}`);
        for (const parameter of plan.parameters) collectWitResources(parameter.resolvedType, usedResources);
        collectWitResources(plan.resultType, usedResources);
    }

    const resourceMethods: string[] = [];
    const resourceDrops: string[] = [];
    const installations: string[] = [];
    for (const apiInterface of interfaces) {
        const apiPackage: WitApiPackage = {
            packageName: apiInterface.packageName,
            version: apiInterface.version,
            interfaces: [...interfaces],
        };
        const namespace = cIdentifier(apiInterface.packageName);
        const functionApiName = `generated${pascalCase(apiInterface.name)}Api`;
        const apiFunctions: string[] = [];
        const resourceApiInstallations: string[] = [];
        for (const operation of apiInterface.functions) {
            const plan = plansByOperation.get(operationId(apiInterface, operation));
            if (!plan) continue;
            const adapter = generateWitApiFunctionForResolvedOperation({
                apiPackage,
                apiInterface,
                operation: plan.operation,
                parameters: plan.parameters,
                resultType: plan.resultType,
            });
            if (!adapter) throw noAdapter(plan.operationId);
            apiFunctions.push(adapter);
        }

        for (const resource of apiInterface.resources) {
            const resourceApiName = `generated${pascalCase(apiInterface.name)}${pascalCase(resource.name)}Api`;
            const resourceApiFunctions: string[] = [];
            if (usedResources.has(`${apiInterface.specifier}#${resource.name}`)) {
                resourceDrops.push(`  if (packageName == ${JSON.stringify(apiPackage.packageName)} && interfaceName == ${JSON.stringify(apiInterface.name)} && resourceName == ${JSON.stringify(resource.name)}) {
    ${namespace}_${cIdentifier(apiInterface.name)}_${cIdentifier(resource.name)}_drop_own(${namespace}_${cIdentifier(apiInterface.name)}_own_${cIdentifier(resource.name)}_t{handle});
    return;
  }`);
            }

            for (const operation of resource.functions) {
                const plan = plansByOperation.get(operationId(apiInterface, operation, resource));
                if (!plan) continue;
                if (plan.kind === 'resource-method') {
                    const adapter = generateWitResourceMethodForResolvedPlan(apiPackage, plan);
                    if (!adapter) throw noAdapter(plan.operationId);
                    resourceMethods.push(adapter);
                    continue;
                }
                const adapter = generateWitApiFunctionForResolvedOperation({
                    apiPackage,
                    apiInterface,
                    operation: plan.operation,
                    parameters: plan.parameters,
                    resultType: plan.resultType,
                    options: {
                        functionName: wasiOperationCFunctionName(apiPackage, apiInterface, plan.operation, resource),
                        apiObjectName: resourceApiName,
                        propertyName:
                            plan.operation.name === 'constructor' ? 'constructor' : jsName(plan.operation.name),
                    },
                });
                if (!adapter) throw noAdapter(plan.operationId);
                resourceApiFunctions.push(adapter);
            }

            resourceApiInstallations.push(`  { Object ${resourceApiName}(runtime);
${resourceApiFunctions.join('\n')}
    ${functionApiName}.setProperty(runtime, ${JSON.stringify(jsName(resource.name))}, std::move(${resourceApiName}));
  }`);
        }

        installations.push(`  { Object ${functionApiName}(runtime);
${apiFunctions.join('\n')}
${resourceApiInstallations.join('\n')}
    runtime.global().setProperty(runtime, ${JSON.stringify(wasiHostName(apiInterface))}, std::move(${functionApiName}));
  }`);
    }

    return `void generatedWasiDropResource(const std::string &packageName, const std::string &interfaceName, const std::string &resourceName, int32_t handle) {
${resourceDrops.join('\n')}
}

Value generatedWasiResourceMethod(Runtime &runtime, const std::string &packageName, const std::string &interfaceName, const std::string &resourceName, const std::string &methodName, std::shared_ptr<ResourceState> state) {
${resourceMethods.join('\n')}
  return Value::undefined();
}

void installGeneratedWasiApiFunctions(Runtime &runtime) {
${installations.join('\n')}
}`;
}

function collectWitResources(type: ResolvedWitType, resources: Set<string>): void {
    switch (type.kind) {
        case 'resource':
            resources.add(`${type.interfaceSpecifier}#${type.name}`);
            return;
        case 'borrow':
        case 'list':
        case 'option':
            collectWitResources(type.item, resources);
            return;
        case 'record':
            for (const field of type.fields) {
                if (field.resolvedType) collectWitResources(field.resolvedType, resources);
            }
            return;
        case 'variant':
            for (const variant of type.cases) {
                if (variant.resolvedType) collectWitResources(variant.resolvedType, resources);
            }
            return;
        case 'tuple':
            for (const item of type.items) collectWitResources(item, resources);
            return;
        case 'result':
            collectWitResources(type.ok, resources);
            collectWitResources(type.error, resources);
            return;
        case 'unit':
        case 'primitive':
        case 'enum':
        case 'flags':
        case 'unsupported':
            return;
        default:
            return void assertNever(type);
    }
}

function operationId(apiInterface: WitWasiInterface, operation: WitFunction, resource?: WitResource): string {
    return `${apiInterface.specifier}#${resource ? `${resource.name}.` : ''}${operation.name}`;
}

function wasiOperationCFunctionName(
    apiPackage: WitApiPackage,
    apiInterface: WitWasiInterface,
    operation: WitFunction,
    resource?: WitResource,
): string {
    const namespace = cIdentifier(apiPackage.packageName);
    const interfaceName = cIdentifier(apiInterface.name);
    if (!resource) return `${namespace}_${interfaceName}_${cIdentifier(operation.name)}`;
    if (operation.name === 'constructor')
        return `${namespace}_${interfaceName}_constructor_${cIdentifier(resource.name)}`;
    const kind = operation.isStatic ? 'static' : 'method';
    return `${namespace}_${interfaceName}_${kind}_${cIdentifier(resource.name)}_${cIdentifier(operation.name)}`;
}

function noAdapter(operationId: string): Error {
    return new Error(`No Static Hermes JSI adapter is generated for ${operationId}`);
}

function cIdentifier(witName: string): string {
    return witName
        .replace(/^%/, '')
        .replace(/[^a-zA-Z0-9_]/g, '_')
        .replace(/_+/g, '_')
        .toLowerCase();
}

function jsName(witName: string): string {
    return witName.replace(/^%/, '').replace(/-([a-zA-Z0-9])/g, (_match, character: string) => character.toUpperCase());
}

function pascalCase(value: string): string {
    return value
        .split(/[^a-zA-Z0-9]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join('');
}

function wasiHostName(apiInterface: WitWasiInterface): string {
    const namespace = apiInterface.packageName.slice(apiInterface.packageName.indexOf(':') + 1);
    return `__pumpkinWasi${pascalCase(namespace)}${pascalCase(apiInterface.name)}`;
}

function assertNever(type: never): never {
    throw new Error(`Unhandled resolved WIT resource type: ${JSON.stringify(type)}`);
}
