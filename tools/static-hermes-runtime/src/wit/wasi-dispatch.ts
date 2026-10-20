import type { WitAnalysis } from './analysis.ts';
import { cIdentifier, jsName, pascalCase, wasiHostName, witOperationCFunctionName } from './names.ts';
import {
    annotateWitCleanupAvailability,
    generateWitApiFunctionForResolvedOperation,
    generateWitResourceMethodForResolvedPlan,
} from './native-adapters.ts';
import { resourcesIn, type WitApiPackage, type WitFunction, type WitResource, type WitWasiInterface } from './types.ts';

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
        for (const type of [...plan.parameters.map(({ resolvedType }) => resolvedType), plan.resultType]) {
            for (const resource of resourcesIn(type))
                usedResources.add(`${resource.interfaceSpecifier}#${resource.name}`);
        }
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
                        functionName: witOperationCFunctionName(apiPackage, apiInterface, plan.operation, resource),
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

function operationId(apiInterface: WitWasiInterface, operation: WitFunction, resource?: WitResource): string {
    return `${apiInterface.specifier}#${resource ? `${resource.name}.` : ''}${operation.name}`;
}

function noAdapter(operationId: string): Error {
    return new Error(`No Static Hermes JSI adapter is generated for ${operationId}`);
}
