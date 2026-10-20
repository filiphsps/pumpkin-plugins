import type { WitAnalysis } from './analysis.ts';
import { cIdentifier, jsName, pascalCase } from './names.ts';
import {
    generateWitApiFunctionForResolvedOperation,
    generateWitResourceMethodForResolvedPlan,
} from './native-adapters.ts';
import type { WitApiAdapterPlan, WitApiPackage } from './types.ts';

interface ResourceApiGroup {
    functions: string[];
    interfaceName: string;
    resourceName: string;
}

/** Generate native Pumpkin dispatch from resolved operation plans. */
export function generatePumpkinMethodDispatch(apiPackage: WitApiPackage, analysis: WitAnalysis): string {
    const namespace = cIdentifier(apiPackage.packageName);
    const apiFunctions = new Map<string, string[]>();
    const resourceApiFunctions = new Map<string, ResourceApiGroup>();
    const resourceMethods: string[] = [];

    for (const plan of analysis.apiAdapters) {
        if (plan.kind === 'function') {
            const adapter = generateWitApiFunctionForResolvedOperation({
                apiPackage,
                apiInterface: plan.apiInterface,
                operation: plan.operation,
                parameters: plan.parameters,
                resultType: plan.resultType,
            });
            if (!adapter) throw unsupportedPlanError(plan);
            append(apiFunctions, plan.apiInterface.name, adapter);
            continue;
        }

        if (!plan.resource) throw unsupportedPlanError(plan);
        if (plan.kind === 'resource-method') {
            const branch = generateWitResourceMethodForResolvedPlan(apiPackage, plan, {
                includePackageName: false,
                preserveArgumentCheckLine: true,
            });
            if (!branch) throw unsupportedPlanError(plan);
            resourceMethods.push(branch);
            continue;
        }

        const resource = plan.resource;
        const apiObjectName = `generated${pascalCase(plan.apiInterface.name)}${pascalCase(resource.name)}Api`;
        const methodName = plan.operation.name === 'constructor' ? 'constructor' : jsName(plan.operation.name);
        const nativeOperation =
            plan.operation.name === 'constructor'
                ? `${namespace}_${cIdentifier(plan.apiInterface.name)}_constructor_${cIdentifier(resource.name)}`
                : `${namespace}_${cIdentifier(plan.apiInterface.name)}_static_${cIdentifier(resource.name)}_${cIdentifier(plan.operation.name)}`;
        const adapter = generateWitApiFunctionForResolvedOperation({
            apiPackage,
            apiInterface: plan.apiInterface,
            operation: plan.operation,
            parameters: plan.parameters,
            resultType: plan.resultType,
            options: {
                functionName: nativeOperation,
                apiObjectName,
                propertyName: methodName,
            },
        });
        if (!adapter) throw unsupportedPlanError(plan);
        appendResource(resourceApiFunctions, plan.apiInterface.name, resource.name, adapter);
    }

    // Any resource can reach JavaScript nested in a result, event payload or callback, and wit-bindgen
    // emits a drop function for every resource in the imported interfaces, so each one gets a branch.
    const drops = apiPackage.interfaces.flatMap((apiInterface) =>
        apiInterface.resources.map(({ name }) => {
            const iface = cIdentifier(apiInterface.name);
            const resource = cIdentifier(name);
            return `  if (interfaceName == ${JSON.stringify(apiInterface.name)} && resourceName == ${JSON.stringify(name)}) {
    ${namespace}_${iface}_${resource}_drop_own(${namespace}_${iface}_own_${resource}_t{handle});
    return;
  }`;
        }),
    );
    const interfaceNames = new Set([
        ...apiFunctions.keys(),
        ...[...resourceApiFunctions.values()].map(({ interfaceName }) => interfaceName),
    ]);
    const functionInstallations = [...interfaceNames].map((interfaceName) => {
        const apiObject = `generated${pascalCase(interfaceName)}Api`;
        const functions = apiFunctions.get(interfaceName) ?? [];
        const resourceInstallations = [...resourceApiFunctions.values()]
            .filter((resource) => resource.interfaceName === interfaceName)
            .map((resource) => {
                const resourceApiObject = `generated${pascalCase(interfaceName)}${pascalCase(resource.resourceName)}Api`;
                const resourceApiValue = `${resourceApiObject}Value`;
                return [
                    `    { Value ${resourceApiValue} = ${apiObject}.getProperty(runtime, ${JSON.stringify(jsName(resource.resourceName))});`,
                    `      Object ${resourceApiObject} = ${resourceApiValue}.isObject() ? ${resourceApiValue}.asObject(runtime) : Object(runtime);`,
                    resource.functions.join('\n'),
                    `      ${apiObject}.setProperty(runtime, ${JSON.stringify(jsName(resource.resourceName))}, std::move(${resourceApiObject}));`,
                    '    }',
                ].join('\n');
            });
        const apiObjectValue = `${apiObject}Value`;
        return [
            `  { Value ${apiObjectValue} = host.getProperty(runtime, ${JSON.stringify(interfaceName)});`,
            `    Object ${apiObject} = ${apiObjectValue}.isObject() ? ${apiObjectValue}.asObject(runtime) : Object(runtime);`,
            functions.join('\n'),
            resourceInstallations.join('\n'),
            `    host.setProperty(runtime, ${JSON.stringify(interfaceName)}, std::move(${apiObject}));`,
            '  }',
        ].join('\n');
    });
    return [
        'void generatedWitDropResource(const std::string &interfaceName, const std::string &resourceName, int32_t handle) {',
        `    ${drops.join('\n')}`,
        '    throw std::runtime_error("No generated drop for Pumpkin resource " + interfaceName + "." + resourceName);',
        '}',
        '',
        'Value generatedWitSimpleMethod(Runtime &runtime, const std::string &interfaceName, const std::string &resourceName, const std::string &methodName, std::shared_ptr<ResourceState> state) {',
        `    ${resourceMethods.join('\n')}`,
        '    return Value::undefined();',
        '}',
        '',
        'void installGeneratedWitApiFunctions(Runtime &runtime, Object &host) {',
        `    ${functionInstallations.join('\n')}`,
        '}',
    ].join('\n');
}

function append(destination: Map<string, string[]>, key: string, value: string): void {
    const entries = destination.get(key) ?? [];
    entries.push(value);
    destination.set(key, entries);
}

function appendResource(
    destination: Map<string, ResourceApiGroup>,
    interfaceName: string,
    resourceName: string,
    value: string,
): void {
    const key = `${interfaceName}.${resourceName}`;
    const group = destination.get(key) ?? { interfaceName, resourceName, functions: [] };
    group.functions.push(value);
    destination.set(key, group);
}

function unsupportedPlanError(plan: WitApiAdapterPlan): Error {
    const operationPath = plan.resource ? `${plan.resource.name}.${plan.operation.name}` : plan.operation.name;
    return new Error(`No Static Hermes adapter is generated for ${plan.apiInterface.specifier}#${operationPath}`);
}
