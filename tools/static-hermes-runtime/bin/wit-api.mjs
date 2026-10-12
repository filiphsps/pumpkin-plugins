import * as fs from 'node:fs';
import * as path from 'node:path';

/** Read the interfaces imported by a plugin world and the operations each interface declares. */
export function readWitPackage(witDir) {
    const root = path.resolve(witDir);
    const pluginSource = stripComments(fs.readFileSync(path.join(root, 'plugin.wit'), 'utf8'));
    const packageMatch = /\bpackage\s+([^;]+);/.exec(pluginSource);
    if (!packageMatch) throw new Error(`plugin.wit has no package declaration in ${root}`);
    const [packageName, version] = packageMatch[1].trim().split('@', 2);
    const pluginWorld = namedBlock(pluginSource, 'world', 'plugin', path.join(root, 'plugin.wit'));
    const imports = [...pluginWorld.matchAll(/\bimport\s+([^;]+);/g)]
        .map((match) => match[1].trim())
        .filter((name) => !name.includes(':'))
        .map((name) => name.replace(/^%/, ''));
    const interfaceFiles = new Map();
    for (const filename of fs.readdirSync(root).filter((value) => value.endsWith('.wit') && value !== 'plugin.wit')) {
        const witPath = path.join(root, filename);
        const source = stripComments(fs.readFileSync(witPath, 'utf8'));
        for (const match of source.matchAll(/\binterface\s+%?([a-zA-Z][\w-]*)\s*\{/g)) {
            interfaceFiles.set(match[1], { witPath, source });
        }
    }

    const interfaceDefinitions = new Map();
    for (const [name, { witPath, source }] of interfaceFiles) {
        const body = namedBlock(source, 'interface', name, witPath);
        const parsed = parseInterfaceBody(body, witPath);
        const dependencies = [...body.matchAll(/\buse\s+%?([a-zA-Z][\w-]*)\s*\.\s*\{/g)].map((match) => match[1]);
        interfaceDefinitions.set(name, {
            name,
            specifier: `${packageName}/${name}${version ? `@${version}` : ''}`,
            functions: parsed.functions,
            resources: parsed.resources,
            records: parsed.records,
            variants: parsed.variants,
            enums: parsed.enums,
            flags: parsed.flags,
            types: parsed.types,
            dependencies,
            dependencyAliases: parseWitDependencyAliases(body, packageName, version)
        });
    }

    const interfaces = [];
    const visited = new Set();
    /** Add an imported interface and recursively include its WIT dependencies. */
    const visit = (name) => {
        if (visited.has(name)) return;
        visited.add(name);
        const interfaceFile = interfaceFiles.get(name);
        const definition = interfaceDefinitions.get(name);
        if (!interfaceFile || !definition) {
            throw new Error(
                `plugin.wit imports or references ${name}, but no interface ${name} is declared in ${root}`
            );
        }
        interfaces.push(definition);
        for (const dependency of definition.dependencies) visit(dependency);
    };
    for (const name of new Set(imports)) visit(name);

    return { packageName, version, interfaces };
}

/** Read the WASI interfaces imported by a plugin and their transitive WIT `use` dependencies. */
export function readWasiWitImports(witDir, requestedImports) {
    const root = path.resolve(witDir);
    const pluginPath = path.join(root, 'plugin.wit');
    const pluginSource = stripComments(fs.readFileSync(pluginPath, 'utf8'));
    const pluginWorld = namedBlock(pluginSource, 'world', 'plugin', pluginPath);
    const importedInterfaces = [...pluginWorld.matchAll(/\bimport\s+(wasi:[\w-]+\/[\w-]+(?:@[\w.+-]+)?)\s*;/g)].map(
        (match) => match[1]
    );
    const imports = requestedImports === undefined ? importedInterfaces : [...new Set(requestedImports)];
    const definitions = readWasiInterfaceDefinitions(root);
    const available = new Set();
    /** Mark an imported interface and its dependencies as available to adapters. */
    const includeAvailable = (specifier) => {
        if (available.has(specifier)) return;
        const definition = definitions.get(specifier);
        if (!definition)
            throw new Error(`plugin WIT imports or uses ${specifier}, but no matching interface is declared`);
        available.add(specifier);
        for (const dependency of definition.dependencies) includeAvailable(dependency);
    };
    for (const specifier of importedInterfaces) includeAvailable(specifier);

    for (const specifier of imports) {
        if (!available.has(specifier)) {
            throw new Error(`WASI interface ${specifier} is not imported by plugin WIT`);
        }
    }

    const interfaces = [];
    const visited = new Set();
    /** Add a requested WASI interface and recursively include its dependencies. */
    const visit = (specifier) => {
        if (visited.has(specifier)) return;
        visited.add(specifier);
        const definition = definitions.get(specifier);
        if (!definition)
            throw new Error(`plugin WIT imports or uses ${specifier}, but no matching interface is declared`);
        interfaces.push(definition);
        for (const dependency of definition.dependencies) visit(dependency);
    };

    for (const specifier of imports) visit(specifier);
    return { imports, interfaces };
}

/** Return the WIT feature flags required by selected imported operations. */
export function wasiFeaturesForMethods(witDir, usedMethods = []) {
    const selected = new Set(usedMethods);
    const features = new Set();
    const { interfaces } = readWasiWitImports(witDir);

    for (const apiInterface of interfaces) {
        for (const { operation, operationId } of wasiOperations(apiInterface)) {
            if (!selected.has(operationId)) continue;
            for (const feature of operation.features ?? []) features.add(feature);
        }
    }

    return [...features].sort();
}

/** Generate a JavaScript facade for a WASI interface using its declared exports and resources. */
export function generateWasiEsmFacade(apiInterface) {
    const hostName = wasiHostName(apiInterface);
    const prelude = /* JavaScript */ `const __api = () => {
    const api = globalThis[${JSON.stringify(hostName)}];
    if (!api) throw new Error(${JSON.stringify(`Static Hermes has no host adapter for WASI interface ${apiInterface.specifier}`)});
    return api;
};
const __assertWasiResourceUsable = (resource) => {
    if (resource && resource.__isValid === false) throw new Error("Cannot use a disposed or transferred resource");
    return resource;
};
const __unwrapWasi = (value) => {
    if (value === null || typeof value !== "object" || ArrayBuffer.isView(value)) return value;
    const resource = value.__staticHermesWasiResource;
    if (resource !== undefined) return __assertWasiResourceUsable(resource);
    if (Array.isArray(value)) return value.map(__unwrapWasi);
    const result = {};
    for (const [key, item] of Object.entries(value)) result[key] = __unwrapWasi(item);
    return result;
};
const __wrapWasi = (value) => {
    if (value === null || typeof value !== "object" || ArrayBuffer.isView(value)) return value;
    if (Array.isArray(value)) return value.map(__wrapWasi);
    const errorCode = value.__staticHermesWasiError;
    if (errorCode !== undefined) {
        const label = typeof errorCode === "string" ? errorCode : errorCode && typeof errorCode.tag === "string" ? errorCode.tag : "unknown";
        const error = new Error("WASI error: " + label);
        error.payload = errorCode;
        throw error;
    }
    return new Proxy(value, {
        get(target, key) {
            if (key === "__staticHermesWasiResource") return target;
            if (key === "__isValid") return Reflect.get(target, key, target);
            if (key === Symbol.dispose) {
                const drop = Reflect.get(target, "drop", target);
                return typeof drop === "function" ? (...args) => Reflect.apply(drop, target, args) : undefined;
            }
            if (key !== "drop" && target.__isValid === false) {
                throw new Error("Cannot use a disposed or transferred resource");
            }
            const member = Reflect.get(target, key, target);
            if (typeof member !== "function") return __wrapWasi(member);
            return (...args) => __wrapWasi(Reflect.apply(member, target, args.map(__unwrapWasi)));
        }
    });
};`;

    const functions = apiInterface.functions
        .map((operation) => {
            const name = jsName(operation.name);
            return `export function ${name}(...args) {
    return __wrapWasi(__api()[${JSON.stringify(name)}](...args.map(__unwrapWasi)));
}`;
        })
        .join('\n');
    const resources = apiInterface.resources
        .map((resource) => {
            const className = jsClassName(resource.name);
            const resourceName = jsName(resource.name);
            const constructorOperation = resource.functions.find((operation) => operation.name === 'constructor');
            const constructorMethod = constructorOperation
                ? /* JavaScript */ `    constructor(...args) {
        const resource = __api()[${JSON.stringify(resourceName)}];
        const create = resource && resource["constructor"];
        if (typeof create !== "function") throw new Error(${JSON.stringify(`Static Hermes has no constructor adapter for ${apiInterface.name}.${resource.name}`)});
        return __wrapWasi(Reflect.apply(create, resource, args.map(__unwrapWasi)));
    }`
                : `    constructor() { throw new Error(${JSON.stringify(`${className} cannot be constructed directly`)}); }`;
            const staticMethods = resource.functions
                .filter((operation) => operation.isStatic)
                .map((operation) => {
                    const name = jsName(operation.name);
                    return /* JavaScript */ `    static ${name}(...args) {
        const resource = __api()[${JSON.stringify(resourceName)}];
        const method = resource && resource[${JSON.stringify(name)}];
        if (typeof method !== "function") throw new Error(${JSON.stringify(`Static Hermes has no adapter for ${apiInterface.name}.${resource.name}.${operation.name}`)});
        return __wrapWasi(Reflect.apply(method, resource, args.map(__unwrapWasi)));
    }`;
                });
            return /* JavaScript */ `export class ${className} {
${[constructorMethod, ...staticMethods].join('\n')}
}`;
        })
        .join('\n');

    return `${[prelude, functions, resources].filter(Boolean).join('\n')}\n`;
}

/** Generate the JavaScript facade for one imported WIT interface. */
export function generateEsmFacade(apiInterface, allInterfaces = [apiInterface]) {
    const allowsTaskCancellationDuringUnload = apiInterface.specifier.startsWith('pumpkin:plugin/scheduler@');
    const prelude = /* JavaScript */ `const __allowTaskCancellationDuringUnload = ${allowsTaskCancellationDuringUnload};
const __assertHostCallsAllowed = (operationName) => {
    if (
        globalThis.__staticHermesPluginUnloading === true &&
        !(__allowTaskCancellationDuringUnload && operationName === "cancel-task")
    ) {
        throw new Error("Pumpkin host calls are unavailable during plugin unload");
    }
};
const __api = (operationName) => {
    __assertHostCallsAllowed(operationName);
    const api = globalThis.__pumpkinHost[${JSON.stringify(apiInterface.name)}];
    if (!api) throw new Error(${JSON.stringify(`Static Hermes has no host adapter for Pumpkin interface ${apiInterface.name}`)});
    return api;
};
const __assertResourceUsable = (resource, facade) => {
    if ((facade && facade.__staticHermesDisposed === true) || (resource && resource.__isValid === false)) throw new Error("Cannot use a disposed or transferred resource");
    return resource;
};
const __resourceApi = (name) => {
    const api = __api()[name];
    if (!api) throw new Error("Static Hermes has no host adapter for Pumpkin resource " + name);
    return api;
};
const __unwrap = (value) => {
    if (value === null || typeof value !== "object") return value;
    if (ArrayBuffer.isView(value)) return value;
    const resource = value.__staticHermesResource;
    if (resource !== undefined) return __assertResourceUsable(resource, value);
    if (Array.isArray(value)) return value.map(__unwrap);
    const result = {};
    for (const [key, item] of Object.entries(value)) result[key] = __unwrap(item);
    return result;
};
const __wrap = (Type, value) => {
    if (value === undefined || value === null) return value;
    const result = Object.create(Type.prototype);
    Object.defineProperty(result, "__staticHermesResource", { value });
    Object.defineProperty(result, "__staticHermesDisposed", { value: false, writable: true });
    return result;
};`;

    const resourceTypes = new Map(
        apiInterface.resources.map((resource) => [resource.name, { ...resource, interfaceName: apiInterface.name }])
    );
    for (const dependencyName of apiInterface.dependencies ?? []) {
        const dependency = allInterfaces.find((candidate) => candidate.name === dependencyName);
        for (const resource of dependency?.resources ?? []) {
            if (!resourceTypes.has(resource.name)) {
                resourceTypes.set(resource.name, { ...resource, interfaceName: dependency.name });
            }
        }
    }
    function resourceClassName(resource) {
        return resource.interfaceName === apiInterface.name
            ? jsClassName(resource.name)
            : `${jsClassName(resource.interfaceName)}${jsClassName(resource.name)}`;
    }
    /** Generate a value expression that wraps resources owned by this or a dependency interface. */
    function wrapResource(resource, value) {
        return `__wrap(${resourceClassName(resource)}, ${value})`;
    }
    /** Generate a wrapper expression for resource-valued method results. */
    function wrapResourceResult(type) {
        if (typeof type !== 'string') return 'value';
        const directResource = resourceTypes.get(type.trim().replace(/^%/, ''));
        if (directResource) return wrapResource(directResource, 'value');

        const optionalResource = /^option<\s*([^<>]+?)\s*>$/.exec(type);
        const listResource = /^list<\s*([^<>]+?)\s*>$/.exec(type);
        const resource = resourceTypes.get(
            (optionalResource?.[1].trim() ?? listResource?.[1].trim())?.replace(/^%/, '')
        );
        if (!resource) return 'value';
        if (optionalResource) return `value == null ? value : ${wrapResource(resource, 'value')}`;
        return `value.map((item) => ${wrapResource(resource, 'item')})`;
    }
    const functions = apiInterface.functions
        .map((operation) => {
            const name = jsName(operation.name);
            const result = wrapResourceResult(operation.result);
            return /* JavaScript */ `export function ${name}(...args) {
    const value = __api(${JSON.stringify(operation.name)})[${JSON.stringify(name)}](...args.map(__unwrap));
    return ${result};
}`;
        })
        .join('\n');

    const resources = [...resourceTypes.values()]
        .map((resource) => {
            const className = resourceClassName(resource);
            const localResource = resource.interfaceName === apiInterface.name;
            const constructorOperation = resource.functions.find((operation) => operation.name === 'constructor');
            const instanceFunctions = resource.functions.filter(
                (operation) => !operation.isStatic && operation.name !== 'constructor'
            );
            const staticFunctions = localResource ? resource.functions.filter((operation) => operation.isStatic) : [];
            const constructorMethod = !localResource
                ? ''
                : constructorOperation
                  ? /* JavaScript */ `    constructor(...args) {
        const native = __resourceApi(${JSON.stringify(jsName(resource.name))})["constructor"](...args.map(__unwrap));
        Object.defineProperty(this, "__staticHermesResource", { value: native });
        Object.defineProperty(this, "__staticHermesDisposed", { value: false, writable: true });
    }`
                  : /* JavaScript */ `    constructor() { throw new Error(${JSON.stringify(`${className} cannot be constructed directly`)}); }`;
            const staticMethods = staticFunctions.map((operation) => {
                const name = jsName(operation.name);
                const result = wrapResourceResult(operation.result);
                return /* JavaScript */ `    static ${name}(...args) {
        const value = __resourceApi(${JSON.stringify(jsName(resource.name))})[${JSON.stringify(name)}](...args.map(__unwrap));
        return ${result};
    }`;
            });
            const instanceMethods = instanceFunctions.map((operation) => {
                const name = jsName(operation.name);
                const result = wrapResourceResult(operation.result);
                return /* JavaScript */ `    ${name}(...args) {
        __assertHostCallsAllowed();
        const native = __assertResourceUsable(this.__staticHermesResource, this);
        const method = native && native[${JSON.stringify(name)}];
        if (typeof method !== "function") throw new Error(${JSON.stringify(`Static Hermes host resource does not implement ${resource.name}.${operation.name}`)});
        const value = method.apply(native, args.map(__unwrap));
        return ${result};
    }`;
            });
            const disposeMethod = /* JavaScript */ `    [Symbol.dispose]() {
        if (this.__staticHermesDisposed) return;
        this.__staticHermesDisposed = true;
        const native = this.__staticHermesResource;
        if (native && typeof native[Symbol.dispose] === "function") native[Symbol.dispose]();
        else if (native && typeof native.drop === "function") native.drop();
    }`;
            const methods = [constructorMethod, ...staticMethods, ...instanceMethods, disposeMethod].join('\n');

            return `${localResource ? 'export ' : ''}class ${className} {
${methods}
}`;
        })
        .join('\n');

    return `${[prelude, functions, resources].filter(Boolean).join('\n')}\n`;
}

/** Resolve a WIT operation's parameters and result once for adapter planning and generation. */
function resolveWitOperationTypes(apiPackage, apiInterface, operation, resultSource) {
    const result = resultSource || operation.result;
    return {
        parameters: operation.parameters.map((parameter) => ({
            ...parameter,
            resolvedType: resolveWitType(apiPackage, apiInterface, parameter.type)
        })),
        resultType: result ? resolveWitType(apiPackage, apiInterface, result) : { kind: 'unit' }
    };
}

/** Select an operation by explicit identity or by its call in the bundle. */
function isWitOperationUsed(usedMethods, operationId, bundleUsesOperation) {
    return usedMethods ? usedMethods.has(operationId) : bundleUsesOperation();
}

/** Generate native resource-method adapters for WIT operations used by the plugin bundle. */
export function generateWitSimpleMethodDispatch(apiPackage, bundleSource = '', apiMethods) {
    const namespace = cIdentifier(apiPackage.packageName);
    const cases = [];
    const resourceDrops = new Map();
    const apiFunctions = new Map();
    const resourceApiFunctions = new Map();
    const usedMethods = apiMethods === undefined ? undefined : new Set(apiMethods);
    for (const apiInterface of apiPackage.interfaces) {
        for (const operation of apiInterface.functions) {
            const functionId = `${apiInterface.name}.${operation.name}`;
            if (
                !isWitOperationUsed(
                    usedMethods,
                    functionId,
                    () => !bundleSource || bundleUsesWitFunction(bundleSource, apiInterface, operation)
                )
            )
                continue;

            const { parameters, resultType } = resolveWitOperationTypes(apiPackage, apiInterface, operation);
            if (
                !isSupportedMethod(
                    resultType,
                    parameters.map((parameter) => parameter.resolvedType)
                )
            ) {
                throw new Error(
                    `No Static Hermes adapter is generated for ${apiInterface.specifier}#${operation.name}: unsupported WIT input or result type`
                );
            }

            const adapter = generateWitApiFunction(apiPackage, apiInterface, operation, parameters, resultType, {
                resourceDrops
            });
            if (!adapter)
                throw new Error(
                    `No Static Hermes adapter is generated for ${apiInterface.specifier}#${operation.name}`
                );
            const functions = apiFunctions.get(apiInterface.name) ?? [];
            functions.push(adapter);
            apiFunctions.set(apiInterface.name, functions);
        }

        for (const resource of apiInterface.resources) {
            for (const operation of resource.functions) {
                const methodId = `${apiInterface.name}.${resource.name}.${operation.name}`;
                if (operation.name === 'constructor') {
                    if (
                        !isWitOperationUsed(
                            usedMethods,
                            methodId,
                            () => !bundleSource || bundleUsesConstructor(bundleSource, resource)
                        )
                    )
                        continue;

                    const { parameters, resultType } = resolveWitOperationTypes(
                        apiPackage,
                        apiInterface,
                        operation,
                        resource.name
                    );
                    if (
                        !isSupportedMethod(
                            resultType,
                            parameters.map((parameter) => parameter.resolvedType)
                        )
                    ) {
                        throw new Error(
                            `No Static Hermes adapter is generated for ${apiInterface.specifier}#${resource.name}.constructor: unsupported WIT input or result type`
                        );
                    }

                    const iface = cIdentifier(apiInterface.name);
                    const resourceName = cIdentifier(resource.name);
                    const apiObjectName = `generated${pascalCase(apiInterface.name)}${pascalCase(resource.name)}Api`;
                    const adapter = generateWitApiFunction(
                        apiPackage,
                        apiInterface,
                        operation,
                        parameters,
                        resultType,
                        {
                            functionName: `${namespace}_${iface}_constructor_${resourceName}`,
                            apiObjectName,
                            propertyName: 'constructor',
                            resourceDrops
                        }
                    );
                    if (!adapter)
                        throw new Error(
                            `No Static Hermes adapter is generated for ${apiInterface.specifier}#${resource.name}.constructor`
                        );

                    const resourceKey = `${apiInterface.name}.${resource.name}`;
                    const resourceFunctions = resourceApiFunctions.get(resourceKey) ?? {
                        interfaceName: apiInterface.name,
                        resourceName: resource.name,
                        functions: []
                    };
                    resourceFunctions.functions.push(adapter);
                    resourceApiFunctions.set(resourceKey, resourceFunctions);
                    continue;
                }

                if (operation.isStatic) {
                    if (
                        !isWitOperationUsed(
                            usedMethods,
                            methodId,
                            () => !bundleSource || bundleUsesCall(bundleSource, jsName(operation.name))
                        )
                    )
                        continue;

                    const { parameters, resultType } = resolveWitOperationTypes(apiPackage, apiInterface, operation);
                    if (
                        !isSupportedMethod(
                            resultType,
                            parameters.map((parameter) => parameter.resolvedType)
                        )
                    ) {
                        throw new Error(
                            `No Static Hermes adapter is generated for ${apiInterface.specifier}#${resource.name}.${operation.name}: unsupported WIT input or result type`
                        );
                    }

                    const iface = cIdentifier(apiInterface.name);
                    const resourceName = cIdentifier(resource.name);
                    const method = cIdentifier(operation.name);
                    const apiObjectName = `generated${pascalCase(apiInterface.name)}${pascalCase(resource.name)}Api`;
                    const adapter = generateWitApiFunction(
                        apiPackage,
                        apiInterface,
                        operation,
                        parameters,
                        resultType,
                        {
                            functionName: `${namespace}_${iface}_static_${resourceName}_${method}`,
                            apiObjectName,
                            propertyName: jsName(operation.name),
                            resourceDrops
                        }
                    );
                    if (!adapter)
                        throw new Error(
                            `No Static Hermes adapter is generated for ${apiInterface.specifier}#${resource.name}.${operation.name}`
                        );

                    const resourceKey = `${apiInterface.name}.${resource.name}`;
                    const resourceFunctions = resourceApiFunctions.get(resourceKey) ?? {
                        interfaceName: apiInterface.name,
                        resourceName: resource.name,
                        functions: []
                    };
                    resourceFunctions.functions.push(adapter);
                    resourceApiFunctions.set(resourceKey, resourceFunctions);
                    continue;
                }

                if (
                    !isWitOperationUsed(
                        usedMethods,
                        methodId,
                        () => !bundleSource || bundleUsesCall(bundleSource, jsName(operation.name))
                    )
                )
                    continue;
                const { parameters, resultType } = resolveWitOperationTypes(apiPackage, apiInterface, operation);
                if (
                    !isSupportedMethod(
                        resultType,
                        parameters.map((parameter) => parameter.resolvedType)
                    )
                ) {
                    throw new Error(
                        `No Static Hermes adapter is generated for ${apiInterface.specifier}#${resource.name}.${operation.name}: unsupported WIT input or result type`
                    );
                }

                const jsMethod = jsName(operation.name);
                const iface = cIdentifier(apiInterface.name);
                const resourceName = cIdentifier(resource.name);
                const method = cIdentifier(operation.name);
                const functionName = `${namespace}_${iface}_method_${resourceName}_${method}`;
                const borrowType = `${namespace}_${iface}_borrow_${resourceName}_t`;
                const inputs = [];
                const beforeCall = [];
                const cleanup = [];
                const callArguments = [`${borrowType}{state->handle}`];
                for (const [index, parameter] of parameters.entries()) {
                    const input = generateWitInput(apiPackage, apiInterface, parameter, index);
                    if (!input)
                        throw new Error(
                            `No Static Hermes adapter is generated for ${apiInterface.specifier}#${resource.name}.${operation.name}: unsupported parameter ${parameter.name}`
                        );
                    inputs.push(...input.setup);
                    beforeCall.push(...(input.beforeCall ?? []));
                    cleanup.push(...input.cleanup);
                    callArguments.push(input.argument);
                }
                const result = generateWitResult(
                    apiPackage,
                    apiInterface,
                    resultType,
                    functionName,
                    callArguments,
                    resourceDrops
                );
                if (!result)
                    throw new Error(
                        `No Static Hermes adapter is generated for ${apiInterface.specifier}#${resource.name}.${operation.name}: unsupported result type`
                    );
                const body = [
                    ...inputs,
                    ...result.setup,
                    ...beforeCall,
                    result.call,
                    ...result.cleanup,
                    ...cleanup,
                    result.return
                ].filter(Boolean);
                const argumentCheck =
                    parameters.length === 0
                        ? ''
                        : `if (count < ${parameters.length}) throw JSError(rt, ${JSON.stringify(`${resource.name}.${jsMethod} expects ${parameters.length} argument${parameters.length === 1 ? '' : 's'}`)});`;
                cases.push(`  if (interfaceName == ${JSON.stringify(apiInterface.name)} && resourceName == ${JSON.stringify(resource.name)} && methodName == ${JSON.stringify(jsMethod)}) {
    return hostFunction(runtime, ${JSON.stringify(jsMethod)}, ${parameters.length}, [state = std::move(state)](Runtime &rt, const Value &, const Value *args, std::size_t count) -> Value {
      ${argumentCheck}
      ${body.join('\n      ')}
    });
  }`);
            }
        }
    }
    const drops = [...resourceDrops.values()].map(([interfaceName, resourceName]) => {
        const iface = cIdentifier(interfaceName);
        const resource = cIdentifier(resourceName);
        return `  if (interfaceName == ${JSON.stringify(interfaceName)} && resourceName == ${JSON.stringify(resourceName)}) {
    ${namespace}_${iface}_${resource}_drop_own(${namespace}_${iface}_own_${resource}_t{handle});
    return;
  }`;
    });
    const interfaceNames = new Set([
        ...apiFunctions.keys(),
        ...[...resourceApiFunctions.values()].map(({ interfaceName }) => interfaceName)
    ]);
    const functionInstallations = [...interfaceNames].map((interfaceName) => {
        const apiObject = `generated${pascalCase(interfaceName)}Api`;
        const functions = apiFunctions.get(interfaceName) ?? [];
        const resourceInstallations = [...resourceApiFunctions.values()]
            .filter((resource) => resource.interfaceName === interfaceName)
            .map((resource) => {
                const resourceApiObject = `generated${pascalCase(interfaceName)}${pascalCase(resource.resourceName)}Api`;
                const resourceApiValue = `${resourceApiObject}Value`;
                return `    { Value ${resourceApiValue} = ${apiObject}.getProperty(runtime, ${JSON.stringify(jsName(resource.resourceName))});\n      Object ${resourceApiObject} = ${resourceApiValue}.isObject() ? ${resourceApiValue}.asObject(runtime) : Object(runtime);\n${resource.functions.join('\n')}\n      ${apiObject}.setProperty(runtime, ${JSON.stringify(jsName(resource.resourceName))}, std::move(${resourceApiObject}));\n    }`;
            });
        const apiObjectValue = `${apiObject}Value`;
        return `  { Value ${apiObjectValue} = host.getProperty(runtime, ${JSON.stringify(interfaceName)});\n    Object ${apiObject} = ${apiObjectValue}.isObject() ? ${apiObjectValue}.asObject(runtime) : Object(runtime);\n${functions.join('\n')}\n${resourceInstallations.join('\n')}\n    host.setProperty(runtime, ${JSON.stringify(interfaceName)}, std::move(${apiObject}));\n  }`;
    });
    return /* cpp */ `void generatedWitDropResource(const std::string &interfaceName, const std::string &resourceName, int32_t handle) {
    ${drops.join('\n')}
}

Value generatedWitSimpleMethod(Runtime &runtime, const std::string &interfaceName, const std::string &resourceName, const std::string &methodName, std::shared_ptr<ResourceState> state) {
    ${cases.join('\n')}
    return Value::undefined();
}

void installGeneratedWitApiFunctions(Runtime &runtime, Object &host) {
    ${functionInstallations.join('\n')}
}`;
}

/** Select used WASI operations and verify that their WIT types have native conversions. */
export function planWasiAdapterDispatch(selectedInterfaces, allInterfaces = selectedInterfaces, usedMethods) {
    const selected = usedMethods === undefined ? undefined : new Set(usedMethods);
    const declared = new Set();
    const operations = [];

    for (const apiInterface of selectedInterfaces) {
        const apiPackage = { packageName: apiInterface.packageName, interfaces: allInterfaces };
        for (const { operation, operationId, kind, resource, resultSource } of wasiOperations(apiInterface)) {
            declared.add(operationId);
            if (selected && !selected.has(operationId)) continue;
            const planned = planWasiOperation(
                apiPackage,
                apiInterface,
                operation,
                operationId,
                kind,
                resource,
                resultSource
            );
            if (!planned) throw new Error(`No Static Hermes JSI adapter is generated for ${operationId}`);
            operations.push(planned);
        }
    }

    for (const operationId of selected ?? []) {
        if (declared.has(operationId)) continue;
        throw new Error(`WASI operation used by the plugin is not declared in WIT: ${operationId}`);
    }
    return operations;
}

/** Resolve and validate the native conversions for one used WASI operation. */
function planWasiOperation(apiPackage, apiInterface, operation, operationId, kind, resource, resultSource) {
    const { parameters, resultType } = resolveWitOperationTypes(apiPackage, apiInterface, operation, resultSource);
    const functionName = wasiOperationCFunctionName(apiPackage, apiInterface, operation, resource);
    const supported =
        isSupportedMethod(
            resultType,
            parameters.map((parameter) => parameter.resolvedType)
        ) &&
        parameters.every((parameter, index) => generateWitInput(apiPackage, apiInterface, parameter, index)) &&
        generateWitResult(apiPackage, apiInterface, resultType, functionName, [], new Map());
    if (!supported) return undefined;
    return { operationId, kind, apiInterface, resource, operation, parameters, resultType };
}

/** Return the generated C function name for a WASI function or resource operation. */
function wasiOperationCFunctionName(apiPackage, apiInterface, operation, resource) {
    const namespace = cIdentifier(apiPackage.packageName);
    const interfaceName = cIdentifier(apiInterface.name);
    if (!resource) return `${namespace}_${interfaceName}_${cIdentifier(operation.name)}`;
    if (operation.name === 'constructor') {
        return `${namespace}_${interfaceName}_constructor_${cIdentifier(resource.name)}`;
    }
    const kind = operation.isStatic ? 'static' : 'method';
    return `${namespace}_${interfaceName}_${kind}_${cIdentifier(resource.name)}_${cIdentifier(operation.name)}`;
}

/** Generate WASI resource methods, resource drops, and interface host objects from imported WIT. */
export function generateWasiAdapterDispatch(selectedInterfaces, allInterfaces = selectedInterfaces, usedMethods) {
    const plannedOperations = planWasiAdapterDispatch(selectedInterfaces, allInterfaces, usedMethods);
    const plansByOperation = new Map(plannedOperations.map((planned) => [planned.operationId, planned]));
    const usedResources = new Set();
    for (const planned of plannedOperations) {
        if (planned.resource) usedResources.add(`${planned.apiInterface.specifier}#${planned.resource.name}`);
        for (const parameter of planned.parameters) collectWitResources(parameter.resolvedType, usedResources);
        collectWitResources(planned.resultType, usedResources);
    }
    const resourceMethods = [];
    const resourceDrops = [];
    const installations = [];

    for (const apiInterface of selectedInterfaces) {
        const apiPackage = { packageName: apiInterface.packageName, interfaces: allInterfaces };
        const namespace = cIdentifier(apiInterface.packageName);
        const functionApiName = `generated${pascalCase(apiInterface.name)}Api`;
        const apiFunctions = [];
        const resourceApiInstallations = [];
        for (const operation of apiInterface.functions) {
            const planned = plansByOperation.get(wasiOperationId(apiInterface, operation));
            if (!planned) continue;
            const { parameters, resultType } = planned;
            const adapter = generateWitApiFunction(apiPackage, apiInterface, operation, parameters, resultType);
            if (!adapter)
                throw new Error(
                    `No Static Hermes JSI adapter is generated for ${apiInterface.specifier}#${operation.name}`
                );
            apiFunctions.push(adapter);
        }

        for (const resource of apiInterface.resources) {
            const resourceApiName = `generated${pascalCase(apiInterface.name)}${pascalCase(resource.name)}Api`;
            const resourceApiFunctions = [];
            if (usedResources.has(`${apiInterface.specifier}#${resource.name}`))
                resourceDrops.push(`  if (packageName == ${JSON.stringify(apiPackage.packageName)} && interfaceName == ${JSON.stringify(apiInterface.name)} && resourceName == ${JSON.stringify(resource.name)}) {
    ${namespace}_${cIdentifier(apiInterface.name)}_${cIdentifier(resource.name)}_drop_own(${namespace}_${cIdentifier(apiInterface.name)}_own_${cIdentifier(resource.name)}_t{handle});
    return;
  }`);

            for (const operation of resource.functions) {
                const operationId = wasiOperationId(apiInterface, operation, resource);
                const planned = plansByOperation.get(operationId);
                if (!planned) continue;
                const { parameters, resultType } = planned;

                if (planned.kind !== 'resource-method') {
                    const adapter = generateWitApiFunction(
                        apiPackage,
                        apiInterface,
                        operation,
                        parameters,
                        resultType,
                        {
                            functionName: wasiOperationCFunctionName(apiPackage, apiInterface, operation, resource),
                            apiObjectName: resourceApiName,
                            propertyName: operation.name === 'constructor' ? 'constructor' : jsName(operation.name)
                        }
                    );
                    if (!adapter) throw new Error(`No Static Hermes JSI adapter is generated for ${operationId}`);
                    resourceApiFunctions.push(adapter);
                    continue;
                }

                const functionName = wasiOperationCFunctionName(apiPackage, apiInterface, operation, resource);
                const borrowType = `${namespace}_${cIdentifier(apiInterface.name)}_borrow_${cIdentifier(resource.name)}_t`;
                const inputs = [];
                const beforeCall = [];
                const cleanup = [];
                const callArguments = [`${borrowType}{state->handle}`];
                for (const [index, parameter] of parameters.entries()) {
                    const input = generateWitInput(apiPackage, apiInterface, parameter, index);
                    if (!input) break;
                    inputs.push(...input.setup);
                    beforeCall.push(...(input.beforeCall ?? []));
                    cleanup.push(...input.cleanup);
                    callArguments.push(input.argument);
                }
                const result = generateWitResult(
                    apiPackage,
                    apiInterface,
                    resultType,
                    functionName,
                    callArguments,
                    new Map()
                );
                if (!result) throw new Error(`No Static Hermes JSI adapter is generated for ${operationId}`);

                const methodName = jsName(operation.name);
                const argumentCheck = parameters.length
                    ? `if (count < ${parameters.length}) throw JSError(rt, ${JSON.stringify(`${resource.name}.${methodName} expects ${parameters.length} argument${parameters.length === 1 ? '' : 's'}`)});`
                    : '';
                const body = [
                    argumentCheck,
                    ...inputs,
                    ...result.setup,
                    ...beforeCall,
                    result.call,
                    ...cleanup,
                    ...result.cleanup,
                    result.return
                ].filter(Boolean);
                resourceMethods.push(`  if (packageName == ${JSON.stringify(apiPackage.packageName)} && interfaceName == ${JSON.stringify(apiInterface.name)} && resourceName == ${JSON.stringify(resource.name)} && methodName == ${JSON.stringify(methodName)}) {
    return hostFunction(runtime, ${JSON.stringify(methodName)}, ${parameters.length}, [state = std::move(state)](Runtime &rt, const Value &, const Value *args, std::size_t count) -> Value {
      ${body.join('\n      ')}
    });
  }`);
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

/** Iterate WIT operations with their selection identity and resource metadata. */
function* wasiOperations(apiInterface) {
    for (const operation of apiInterface.functions) {
        yield { operation, operationId: wasiOperationId(apiInterface, operation), kind: 'function' };
    }
    for (const resource of apiInterface.resources) {
        for (const operation of resource.functions) {
            const kind =
                operation.name === 'constructor'
                    ? 'resource-constructor'
                    : operation.isStatic
                      ? 'resource-static-method'
                      : 'resource-method';
            yield {
                operation,
                operationId: wasiOperationId(apiInterface, operation, resource),
                kind,
                resource,
                resultSource: operation.name === 'constructor' ? resource.name : undefined
            };
        }
    }
}

/** Build the operation identity used to select a WASI function or resource method. */
function wasiOperationId(apiInterface, operation, resource) {
    const resourcePrefix = resource ? `${resource.name}.` : '';
    return `${apiInterface.specifier}#${resourcePrefix}${operation.name}`;
}

/** Collect resource types contained in a selected operation's input or output. */
function collectWitResources(type, resources) {
    if (!type) return;
    if (type.kind === 'resource') resources.add(`${type.interfaceSpecifier}#${type.name}`);
    if (type.item) collectWitResources(type.item, resources);
    for (const field of type.fields ?? []) collectWitResources(field.resolvedType, resources);
    for (const variant of type.cases ?? []) collectWitResources(variant.resolvedType, resources);
    for (const item of type.items ?? []) collectWitResources(item, resources);
    if (type.kind === 'result') {
        collectWitResources(type.ok, resources);
        collectWitResources(type.error, resources);
    }
}

/** Generate a WIT free-function adapter inside its interface API object. */
function generateWitApiFunction(
    apiPackage,
    apiInterface,
    operation,
    parameters,
    resultType,
    {
        functionName,
        apiObjectName = `generated${pascalCase(apiInterface.name)}Api`,
        propertyName = jsName(operation.name),
        resourceDrops = new Map()
    } = {}
) {
    const nativeFunctionName = functionName ?? wasiOperationCFunctionName(apiPackage, apiInterface, operation);
    const inputs = [];
    const beforeCall = [];
    const cleanup = [];
    const callArguments = [];
    for (const [index, parameter] of parameters.entries()) {
        const input = generateWitInput(apiPackage, apiInterface, parameter, index);
        if (!input) return undefined;
        inputs.push(...input.setup);
        beforeCall.push(...(input.beforeCall ?? []));
        cleanup.push(...input.cleanup);
        callArguments.push(input.argument);
    }

    const result = generateWitResult(
        apiPackage,
        apiInterface,
        resultType,
        nativeFunctionName,
        callArguments,
        resourceDrops
    );
    if (!result) return undefined;
    const argumentCheck =
        parameters.length === 0
            ? ''
            : `if (count < ${parameters.length}) throw JSError(rt, ${JSON.stringify(`${jsName(operation.name)} expects ${parameters.length} argument${parameters.length === 1 ? '' : 's'}`)});`;
    const body = [
        argumentCheck,
        ...inputs,
        ...result.setup,
        ...beforeCall,
        result.call,
        ...cleanup,
        ...result.cleanup,
        result.return
    ].filter(Boolean);
    return `    ${apiObjectName}.setProperty(
        runtime, ${JSON.stringify(propertyName)},
        hostFunction(runtime, ${JSON.stringify(propertyName)}, ${parameters.length},
            [](Runtime &rt, const Value &, const Value *args, std::size_t count) -> Value {
                ${body.join('\n                ')}
            }));`;
}

/** Check whether the bundle calls a method using dot notation. */
function bundleUsesCall(source, method) {
    return new RegExp(`\\.${escapeRegExp(method)}\\s*\\(`).test(source);
}

/** Check whether a resource constructor is instantiated in the JavaScript bundle. */
function bundleUsesConstructor(source, resource) {
    return new RegExp(`\\bnew\\s+${escapeRegExp(jsClassName(resource.name))}\\s*\\(`).test(source);
}

/** Find a free function call through its Pumpkin WIT import binding in the bundled source. */
function bundleUsesWitFunction(source, apiInterface, operation) {
    const imports = /import\s*\{([^}]+)\}\s*from\s*(["'])([^"']+)\2/g;
    for (const match of source.matchAll(imports)) {
        if (match[3] !== apiInterface.specifier) continue;
        for (const binding of match[1].split(',')) {
            const names = /^\s*([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(binding);
            if (!names || names[1] !== jsName(operation.name)) continue;
            const localName = names[2] ?? names[1];
            return new RegExp(`\\b${escapeRegExp(localName)}\\s*\\(`).test(source);
        }
    }
    return false;
}

/** Resolve a WIT type expression, including aliases and nested generic types. */
function resolveWitType(apiPackage, apiInterface, source, visited = new Set()) {
    const type = source.trim().replace(/^%/, '');
    const generic = /^([a-z-]+)<([\s\S]*)>$/.exec(type);
    const owner = {
        declaredInterface: apiInterface.name,
        packageName: apiInterface.packageName ?? apiPackage.packageName
    };
    if (type === 'result') return { kind: 'result', ...owner, ok: { kind: 'unit' }, error: { kind: 'unit' } };
    if (generic) {
        const [, name, contents] = generic;
        if (name === 'borrow')
            return { kind: 'borrow', ...owner, item: resolveWitType(apiPackage, apiInterface, contents, visited) };
        if (name === 'result') {
            const [okSource, errorSource = '_'] = splitTopLevel(contents, ',').map((part) => part.trim());
            return {
                kind: 'result',
                ...owner,
                ok: resolveWitType(apiPackage, apiInterface, okSource || '_', visited),
                error: resolveWitType(apiPackage, apiInterface, errorSource || '_', visited)
            };
        }
        if (name === 'option' || name === 'list') {
            return { kind: name, ...owner, item: resolveWitType(apiPackage, apiInterface, contents, visited) };
        }
        if (name === 'tuple') {
            return {
                kind: 'tuple',
                ...owner,
                items: splitTopLevel(contents, ',').map((part) =>
                    resolveWitType(apiPackage, apiInterface, part, visited)
                )
            };
        }
        return { kind: 'unsupported', source: type };
    }

    if (type === '_') return { kind: 'unit' };
    if (['bool', 'char', 'u8', 's8', 'u16', 's16', 'u32', 's32', 'u64', 's64', 'f32', 'f64', 'string'].includes(type)) {
        return { kind: 'primitive', name: type };
    }

    const definition = findWitTypeDefinition(apiPackage, apiInterface, type);
    if (!definition) return { kind: 'unsupported', source: type };
    if (
        definition.kind === 'resource' ||
        definition.kind === 'record' ||
        definition.kind === 'variant' ||
        definition.kind === 'enum' ||
        definition.kind === 'flags'
    ) {
        const resolved = { ...definition, declaredInterface: definition.interfaceName };
        const definitionInterface = apiPackage.interfaces.find(
            (candidate) => candidate.specifier === definition.interfaceSpecifier
        ) ?? {
            name: definition.interfaceName,
            packageName: definition.packageName,
            specifier: definition.interfaceSpecifier,
            dependencies: definition.interfaceDependencies ?? []
        };
        if (definition.kind === 'record') {
            resolved.fields = definition.fields.map((field) => ({
                ...field,
                resolvedType: resolveWitType(apiPackage, definitionInterface, field.type, visited)
            }));
        } else if (definition.kind === 'variant') {
            resolved.cases = definition.cases.map((variant) => ({
                ...variant,
                resolvedType: variant.type
                    ? resolveWitType(apiPackage, definitionInterface, variant.type, visited)
                    : undefined
            }));
        }
        return resolved;
    }
    const key = `${definition.interfaceName}.${type}`;
    if (visited.has(key)) return { kind: 'unsupported', source: type };
    const nested = new Set(visited).add(key);
    const resolved = resolveWitType(
        apiPackage,
        {
            name: definition.interfaceName,
            packageName: definition.packageName,
            specifier: definition.interfaceSpecifier,
            dependencies: definition.interfaceDependencies ?? []
        },
        definition.type,
        nested
    );
    return { ...resolved, aliasName: definition.name, declaredInterface: definition.interfaceName };
}

/** Find a named WIT type in the current interface or its dependencies. */
function findWitTypeDefinition(apiPackage, apiInterface, name) {
    const definitions = [];
    const dependencyAlias = apiInterface.dependencyAliases?.[name];
    const definitionName = dependencyAlias?.name ?? name;
    for (const candidateInterface of apiPackage.interfaces) {
        const metadata = {
            interfaceName: candidateInterface.name,
            packageName: candidateInterface.packageName ?? apiPackage.packageName,
            interfaceSpecifier: candidateInterface.specifier,
            interfaceDependencies: candidateInterface.dependencies ?? []
        };
        const declarationGroups = [
            ['resource', candidateInterface.resources],
            ['record', candidateInterface.records],
            ['variant', candidateInterface.variants],
            ['enum', candidateInterface.enums],
            ['flags', candidateInterface.flags],
            ['alias', candidateInterface.types]
        ];
        for (const [kind, declarations] of declarationGroups) {
            for (const declaration of declarations ?? []) {
                if (declaration.name === definitionName) definitions.push({ kind, ...declaration, ...metadata });
            }
        }
    }
    const ownerPackage = apiInterface.packageName ?? apiPackage.packageName;
    const dependencies = [
        { interfaceName: apiInterface.name, packageName: ownerPackage, specifier: apiInterface.specifier },
        ...(apiInterface.dependencies ?? []).map((dependency) => {
            const dependencyInterface = apiPackage.interfaces.find(
                (candidate) =>
                    candidate.specifier === dependency ||
                    (candidate.name === dependency &&
                        (candidate.packageName ?? apiPackage.packageName) === ownerPackage)
            );
            return dependencyInterface
                ? {
                      interfaceName: dependencyInterface.name,
                      packageName: dependencyInterface.packageName ?? ownerPackage,
                      specifier: dependencyInterface.specifier
                  }
                : { interfaceName: dependency, packageName: ownerPackage };
        })
    ];
    for (const dependency of dependencies) {
        if (dependencyAlias && dependency.specifier !== dependencyAlias.specifier) continue;
        const local = definitions.filter((definition) =>
            dependency.specifier
                ? definition.interfaceSpecifier === dependency.specifier
                : definition.interfaceName === dependency.interfaceName &&
                  definition.packageName === dependency.packageName
        );
        if (local.length === 1) return local[0];
    }
    return definitions.length === 1 ? definitions[0] : undefined;
}

/** Check whether a method's input and result types can use a native adapter. */
function isSupportedMethod(result, parameters) {
    return parameters.every(isSupportedInput) && isSupportedResult(result);
}

/** Check whether a resolved WIT type can be converted from a JavaScript argument. */
function isSupportedInput(type) {
    if (type.kind === 'unit') return true;
    if (['primitive', 'enum', 'flags', 'resource'].includes(type.kind)) return true;
    if (type.kind === 'borrow') return type.item.kind === 'resource';
    if (type.kind === 'record') return type.fields.every((field) => isSupportedInput(field.resolvedType));
    if (type.kind === 'variant')
        return type.cases.every((variant) => !variant.type || isSupportedInput(variant.resolvedType));
    if (type.kind === 'option' || type.kind === 'list') return isSupportedInput(type.item);
    if (type.kind === 'tuple') return type.items.every(isSupportedInput);
    if (type.kind === 'result') return isSupportedInput(type.ok) && isSupportedInput(type.error);
    return false;
}

/** Check whether a resolved WIT type can be converted to a JavaScript result. */
function isSupportedResult(type) {
    if (type.kind === 'unit' || type.kind === 'primitive' || type.kind === 'enum' || type.kind === 'flags') return true;
    return isSupportedWitResultValue(type);
}

/** Check whether a WIT error can be converted to the facade's error marker. */
function isSupportedWitError(type) {
    return type.kind === 'unit' || isSupportedWitResultValue(type);
}

/** Check whether a WIT value can be converted recursively to a JavaScript value. */
function isSupportedWitResultValue(type) {
    if (['unit', 'primitive', 'enum', 'flags', 'resource'].includes(type.kind)) return true;
    if (type.kind === 'record') return type.fields.every((field) => isSupportedWitResultValue(field.resolvedType));
    if (type.kind === 'variant')
        return type.cases.every((variant) => !variant.type || isSupportedWitResultValue(variant.resolvedType));
    if (type.kind === 'option' || type.kind === 'list') return isSupportedWitResultValue(type.item);
    if (type.kind === 'tuple') return type.items.every(isSupportedWitResultValue);
    if (type.kind === 'result') return isSupportedWitResultValue(type.ok) && isSupportedWitResultValue(type.error);
    return false;
}

/** Resolve a field's WIT type using its containing definition. */
function resolveWitTypeFromField(field, parent, apiPackage) {
    if (field.resolvedType) return field.resolvedType;
    const ownerInterface = apiPackage.interfaces.find(
        (apiInterface) =>
            apiInterface.specifier === parent.interfaceSpecifier ||
            (apiInterface.name === (parent.declaredInterface ?? parent.interfaceName) &&
                apiInterface.packageName === parent.packageName)
    );
    return resolveWitType(apiPackage, ownerInterface ?? { name: parent.interfaceName, dependencies: [] }, field.type);
}

/** Generate native argument setup, call input, and cleanup for one WIT parameter. */
function generateWitInput(apiPackage, apiInterface, parameter, index) {
    const type = parameter.resolvedType;
    const name = `argument${index}`;
    const collectOwnership = containsWitResource(type) && !['resource', 'borrow'].includes(type.kind);
    const ownership = collectOwnership ? `${name}OwnedResources` : undefined;
    if (type.kind === 'option') {
        const item = generateWitInputValue(
            apiPackage,
            apiInterface,
            type.item,
            `args[${index}]`,
            `${name}Value`,
            ownership,
            false
        );
        if (!item) return undefined;
        const itemType = witCType(apiPackage, apiInterface, type.item);
        const setup = [
            `${itemType} ${name}Storage{};`,
            `${itemType} *${name} = nullptr;`,
            `if (!args[${index}].isNull() && !args[${index}].isUndefined()) {`,
            ...item.setup.map((line) => `  ${line}`),
            `  ${name}Storage = ${item.expression};`,
            `  ${name} = &${name}Storage;`,
            '}'
        ];
        return {
            setup: [...(ownership ? [`std::vector<std::shared_ptr<ResourceState>> ${ownership};`] : []), ...setup],
            beforeCall: ownership ? [`for (const auto &resource : ${ownership}) resource->transfer();`] : [],
            argument: name,
            cleanup: [witFreeCode(apiPackage, apiInterface, type.item, `${name}Storage`)].filter(Boolean)
        };
    }
    const value = generateWitInputValue(apiPackage, apiInterface, type, `args[${index}]`, name, ownership, false);
    if (!value) return undefined;

    const aggregate = ['record', 'variant', 'tuple', 'list', 'option', 'result'].includes(type.kind);
    const cleanup =
        type.kind === 'primitive' && type.name === 'string'
            ? [`plugin_string_free(&${name});`]
            : aggregate && !(type.kind === 'list' && type.item.kind === 'primitive' && type.item.name === 'u8')
              ? [witFreeCode(apiPackage, apiInterface, type, name)].filter(Boolean)
              : [];
    const setup = [...(ownership ? [`std::vector<std::shared_ptr<ResourceState>> ${ownership};`] : []), ...value.setup];
    return {
        setup,
        beforeCall:
            type.kind === 'resource'
                ? [`${name}State->transfer();`]
                : ownership
                  ? [`for (const auto &resource : ${ownership}) resource->transfer();`]
                  : [],
        argument: value.passByPointer ? `&${name}` : value.expression,
        cleanup
    };
}

/** Recursively convert a JavaScript value into a WIT C API value. */
function generateWitInputValue(apiPackage, apiInterface, type, input, name, ownership, copyByteLists) {
    if (type.kind === 'unit') return { setup: [], expression: 'Value::undefined()' };
    if (type.kind === 'primitive') {
        if (type.name === 'string') {
            return {
                setup: [`plugin_string_t ${name} = wasiInputString(rt, ${input});`],
                expression: name,
                passByPointer: true
            };
        }
        return { setup: [], expression: primitiveInput(type, input, 'rt') };
    }
    if (type.kind === 'enum') {
        const cType = witCType(apiPackage, apiInterface, type);
        const enumName = `${name}Name`;
        const setup = [`const auto ${enumName} = utf8(rt, ${input});`, `${cType} ${name}{};`];
        for (const value of type.values) {
            setup.push(
                `if (${enumName} == ${JSON.stringify(value)}) ${name} = static_cast<${cType}>(${enumValue(apiPackage, type, value)});`
            );
        }
        setup.push(
            `if (${type.values.map((value) => `${enumName} != ${JSON.stringify(value)}`).join(' && ')}) throw JSError(rt, ${JSON.stringify(`Unknown ${type.name} value`)});`
        );
        return { setup, expression: name };
    }
    if (type.kind === 'flags') {
        const cType = witCType(apiPackage, apiInterface, type);
        const object = `${name}Object`;
        const setup = [`const auto ${object} = ${input}.asObject(rt);`, `${cType} ${name}{};`];
        for (const flag of type.values) {
            const property = jsName(flag);
            const value = `${name}Flag${pascalCase(flag)}`;
            setup.push(
                `const auto ${value} = ${object}.getProperty(rt, ${JSON.stringify(property)});`,
                `if (!${value}.isUndefined() && !${value}.isNull() && ${value}.getBool()) ${name} |= static_cast<${cType}>(${enumValue(apiPackage, type, flag)});`
            );
        }
        return { setup, expression: name };
    }
    if (type.kind === 'resource' || (type.kind === 'borrow' && type.item.kind === 'resource')) {
        const resource = type.kind === 'borrow' ? type.item : type;
        const borrowed = type.kind === 'borrow';
        const state = `${name}State`;
        const resourcePackage = apiPackage.packageName.startsWith('wasi:')
            ? (resource.packageName ?? apiPackage.packageName)
            : '';
        const setup = [
            `auto ${state} = getWitResourceState(rt, ${input}, ${JSON.stringify(resource.interfaceName)}, ${JSON.stringify(resource.name)}, ${JSON.stringify(resourcePackage)});`,
            ...(!borrowed
                ? [
                      `if (!${state}->owned) throw JSError(rt, ${JSON.stringify(`Expected an owned ${resource.name} resource`)});`,
                      ...(ownership ? [`${ownership}.push_back(${state});`] : [])
                  ]
                : []),
            `${witCType(apiPackage, apiInterface, type)} ${name}{${state}->handle};`
        ];
        return { setup, expression: name };
    }
    if (type.kind === 'record') {
        const object = `${name}Object`;
        const setup = [
            `const auto ${object} = ${input}.asObject(rt);`,
            `${witCType(apiPackage, apiInterface, type)} ${name}{};`
        ];
        for (const field of type.fields) {
            const fieldType = field.resolvedType ?? resolveWitTypeFromField(field, type, apiPackage);
            const fieldName = `${name}${pascalCase(field.name)}`;
            const value = generateWitInputValue(
                apiPackage,
                apiInterface,
                fieldType,
                `${object}.getProperty(rt, ${JSON.stringify(jsName(field.name))})`,
                fieldName,
                ownership,
                true
            );
            if (!value) return undefined;
            setup.push(...value.setup, `${name}.${cFieldIdentifier(field.name)} = ${value.expression};`);
        }
        return { setup, expression: name, passByPointer: true };
    }
    if (type.kind === 'tuple') {
        const array = `${name}Array`;
        const setup = [
            `const auto ${array} = ${input}.asObject(rt).asArray(rt);`,
            `${witCType(apiPackage, apiInterface, type)} ${name}{};`
        ];
        for (const [index, itemType] of type.items.entries()) {
            const itemName = `${name}Item${index}`;
            const item = generateWitInputValue(
                apiPackage,
                apiInterface,
                itemType,
                `${array}.getValueAtIndex(rt, ${index})`,
                itemName,
                ownership,
                true
            );
            if (!item) return undefined;
            setup.push(...item.setup, `${name}.f${index} = ${item.expression};`);
        }
        return { setup, expression: name, passByPointer: true };
    }
    if (type.kind === 'variant') {
        const object = `${name}Object`;
        const tag = `${name}Tag`;
        const setup = [
            `const auto ${object} = ${input}.asObject(rt);`,
            `const auto ${tag} = utf8(rt, ${object}.getProperty(rt, "tag"));`,
            `${witCType(apiPackage, apiInterface, type)} ${name}{};`
        ];
        const alternatives = [];
        for (const variant of type.cases) {
            const payloadType = variant.resolvedType;
            const tagValue = JSON.stringify(jsVariantTag(variant.name));
            const branch = [`${name}.tag = ${enumValue(apiPackage, type, variant.name)};`];
            if (payloadType) {
                const payload = generateWitInputValue(
                    apiPackage,
                    apiInterface,
                    payloadType,
                    `${object}.getProperty(rt, "val")`,
                    `${name}${pascalCase(variant.name)}`,
                    ownership,
                    true
                );
                if (!payload) return undefined;
                branch.push(...payload.setup, `${name}.val.${cFieldIdentifier(variant.name)} = ${payload.expression};`);
            }
            alternatives.push(`if (${tag} == ${tagValue}) { ${branch.join(' ')} }`);
        }
        setup.push(
            `${alternatives.join(' else ')} else { throw JSError(rt, ${JSON.stringify(`Unknown ${type.name} variant`)}); }`
        );
        return { setup, expression: name, passByPointer: true };
    }
    if (type.kind === 'option') {
        const valueType = type.item;
        const value = generateWitInputValue(
            apiPackage,
            apiInterface,
            valueType,
            input,
            `${name}Value`,
            ownership,
            true
        );
        if (!value) return undefined;
        const cType = witCType(apiPackage, apiInterface, type);
        return {
            setup: [
                `${cType} ${name}{};`,
                `if (!${input}.isNull() && !${input}.isUndefined()) {`,
                ...value.setup.map((line) => `  ${line}`),
                `  ${name}.is_some = true;`,
                `  ${name}.val = ${value.expression};`,
                '}'
            ],
            expression: name,
            passByPointer: true
        };
    }
    if (type.kind === 'result') {
        const object = `${name}Object`;
        const tag = `${name}Tag`;
        const cType = witCType(apiPackage, apiInterface, type);
        const setup = [
            `const auto ${object} = ${input}.asObject(rt);`,
            `const auto ${tag} = utf8(rt, ${object}.getProperty(rt, "tag"));`,
            `${cType} ${name}{};`
        ];
        for (const [tagName, itemType, branch] of [
            ['ok', type.ok, 'ok'],
            ['err', type.error, 'err']
        ]) {
            const value = generateWitInputValue(
                apiPackage,
                apiInterface,
                itemType,
                `${object}.getProperty(rt, "val")`,
                `${name}${pascalCase(tagName)}`,
                ownership,
                true
            );
            if (!value) return undefined;
            setup.push(
                `${branch === 'ok' ? 'if' : 'else if'} (${tag} == ${JSON.stringify(tagName)}) {`,
                ...value.setup.map((line) => `  ${line}`),
                `  ${name}.is_err = ${branch === 'err' ? 'true' : 'false'};`,
                ...(itemType.kind === 'unit' ? [] : [`  ${name}.val.${branch} = ${value.expression};`]),
                '}'
            );
        }
        setup.push(`else { throw JSError(rt, ${JSON.stringify('WIT result tag must be "ok" or "err"')}); }`);
        return { setup, expression: name, passByPointer: true };
    }
    if (type.kind === 'list') {
        const cType = witCType(apiPackage, apiInterface, type);
        if (type.item.kind === 'primitive' && type.item.name === 'u8') {
            const typed = `${name}Typed`;
            const buffer = `${name}Buffer`;
            if (!copyByteLists) {
                return {
                    setup: [
                        `auto ${typed} = ${input}.asObject(rt).asUint8Array(rt);`,
                        `auto ${buffer} = ${typed}.buffer(rt);`,
                        `${cType} ${name}{${buffer}.data(rt) + ${typed}.byteOffset(rt), ${typed}.byteLength(rt)};`
                    ],
                    expression: name,
                    passByPointer: true
                };
            }
            const data = `${name}Data`;
            const size = `${name}Size`;
            return {
                setup: [
                    `auto ${typed} = ${input}.asObject(rt).asUint8Array(rt);`,
                    `auto ${buffer} = ${typed}.buffer(rt);`,
                    `const std::size_t ${size} = ${typed}.byteLength(rt);`,
                    `auto *${data} = static_cast<uint8_t *>(${size} ? std::malloc(${size}) : nullptr);`,
                    `if (${size} && !${data}) throw JSError(rt, "WIT byte-list allocation failed");`,
                    `if (${size}) std::memcpy(${data}, ${buffer}.data(rt) + ${typed}.byteOffset(rt), ${size});`,
                    `${cType} ${name}{${data}, ${size}};`
                ],
                expression: name,
                passByPointer: true
            };
        }
        const array = `${name}Array`;
        const size = `${name}Size`;
        const data = `${name}Data`;
        const index = `${name}Index`;
        const itemType = witCType(apiPackage, apiInterface, type.item);
        const item = generateWitInputValue(
            apiPackage,
            apiInterface,
            type.item,
            `${array}.getProperty(rt, std::to_string(${index}).c_str())`,
            `${name}Item`,
            ownership,
            true
        );
        if (!item) return undefined;
        return {
            setup: [
                `const auto ${array} = ${input}.asObject(rt);`,
                `if (!${array}.isArray(rt) && !${array}.isTypedArray(rt)) throw JSError(rt, "Expected a WIT list as an array or typed array");`,
                `const std::size_t ${size} = static_cast<std::size_t>(${array}.getProperty(rt, "length").asNumber());`,
                `auto *${data} = static_cast<${itemType} *>(${size} ? std::calloc(${size}, sizeof(${itemType})) : nullptr);`,
                `if (${size} && !${data}) throw JSError(rt, "WIT list allocation failed");`,
                `for (std::size_t ${index} = 0; ${index} < ${size}; ++${index}) {`,
                ...item.setup.map((line) => `  ${line}`),
                `  ${data}[${index}] = ${item.expression};`,
                '}',
                `${cType} ${name}{${data}, ${size}};`
            ],
            expression: name,
            passByPointer: true
        };
    }
    return undefined;
}

/** Generate native call and result-conversion code for a resolved WIT result type. */
function generateWitResult(apiPackage, apiInterface, type, functionName, argumentsList, resourceDrops) {
    const callArguments = [...argumentsList];
    const call = `${functionName}(${callArguments.join(', ')})`;
    if (type.kind === 'result') {
        const output = type.ok;
        const error = type.error;
        if (output.kind === 'resource') {
            resourceDrops.set(`${output.interfaceName}.${output.name}`, [output.interfaceName, output.name]);
        }
        const value =
            output.kind === 'resource'
                ? undefined
                : generateWitResultValue(apiPackage, apiInterface, output, 'result', 'resultValue');
        if (output.kind !== 'unit' && output.kind !== 'resource' && !value) return undefined;
        if (error.kind !== 'unit' && !isSupportedWitError(error)) return undefined;
        const setup = [
            ...(output.kind === 'unit' ? [] : [`${witCType(apiPackage, apiInterface, output)} result{};`]),
            ...(error.kind === 'unit' ? [] : [`${witCType(apiPackage, apiInterface, error)} error{};`])
        ];
        const outputArguments = output.kind === 'unit' ? callArguments : [...callArguments, '&result'];
        if (error.kind !== 'unit') outputArguments.push('&error');
        const callExpression = `const bool callSucceeded = ${functionName}(${outputArguments.join(', ')});`;
        const free = output.kind === 'resource' ? '' : witFreeCode(apiPackage, apiInterface, output, 'result');
        const errorReturn =
            error.kind === 'unit'
                ? `Object errorValue(rt); errorValue.setProperty(rt, "tag", "err"); return errorValue;`
                : generateWitErrorReturn(apiPackage, apiInterface, error, 'error');
        const successReturn =
            output.kind === 'resource'
                ? generateWitResourceValue(apiPackage, output, 'result')
                : `${value.setup.join(' ')} auto converted = ${value.expression}; ${free} return converted;`;
        return {
            setup,
            call: callExpression,
            cleanup: [],
            return: `if (!callSucceeded) { ${errorReturn} } ${successReturn}`
        };
    }
    if (type.kind === 'unit') return { setup: [], call: `${call};`, cleanup: [], return: 'return Value::undefined();' };
    if (type.kind === 'primitive' && type.name === 'string') {
        return {
            setup: ['plugin_string_t result{};'],
            call: `${functionName}(${[...callArguments, '&result'].join(', ')});`,
            cleanup: [],
            return: 'const auto text = wasiStringValue(result); plugin_string_free(&result); return jsString(rt, text);'
        };
    }
    if (type.kind === 'primitive')
        return {
            setup: [],
            call: `const auto result = ${call};`,
            cleanup: [],
            return: `return ${primitiveOutput(type, 'result', 'rt')};`
        };
    if (type.kind === 'enum') return generateWitEnumResult(apiPackage, type, call);
    if (type.kind === 'flags') {
        const value = generateWitResultValue(apiPackage, apiInterface, type, 'result', 'resultValue');
        if (!value) return undefined;
        return {
            setup: [],
            call: `const auto result = ${call};`,
            cleanup: [],
            return: `${value.setup.join(' ')} return ${value.expression};`
        };
    }
    if (type.kind === 'record' || type.kind === 'tuple' || type.kind === 'variant' || type.kind === 'list') {
        const value = generateWitResultValue(apiPackage, apiInterface, type, 'result', 'resultValue');
        if (!value) return undefined;
        const setup = [`${witCType(apiPackage, apiInterface, type)} result{};`];
        const free = witFreeCode(apiPackage, apiInterface, type, 'result');
        return {
            setup,
            call: `${functionName}(${[...callArguments, '&result'].join(', ')});`,
            cleanup: [],
            return: `${value.setup.join(' ')} auto converted = ${value.expression}; ${free} return converted;`
        };
    }
    if (type.kind === 'resource')
        return generateWitResourceResult(
            apiPackage,
            apiInterface,
            type,
            functionName,
            callArguments,
            resourceDrops,
            'resource'
        );
    if (type.kind === 'option') {
        const value = generateWitResultValue(apiPackage, apiInterface, type.item, 'result', 'resultValue');
        if (!value) return undefined;
        const setup = [`${witCType(apiPackage, apiInterface, type.item)} result{};`];
        const free = witFreeCode(apiPackage, apiInterface, type.item, 'result');
        return {
            setup,
            call: `const bool hasResult = ${functionName}(${[...callArguments, '&result'].join(', ')});`,
            cleanup: [],
            return: `if (!hasResult) return Value::null(); ${value.setup.join(' ')} auto converted = ${value.expression}; ${free} return converted;`
        };
    }
    return undefined;
}

/** Convert a failed WIT result enum into the error marker consumed by its facade. */
function generateWitErrorReturn(apiPackage, apiInterface, type, expression) {
    if (type.kind === 'enum') return generateWitEnumErrorReturn(apiPackage, type, expression);
    const value = generateWitResultValue(apiPackage, apiInterface, type, expression, 'wasiError');
    if (!value) return `throw JSError(rt, ${JSON.stringify(`WIT call ${type.name} failed`)});`;
    const free = witFreeCode(apiPackage, apiInterface, type, expression);
    return `${value.setup.join(' ')} auto errorPayload = ${value.expression}; ${free} Object errorValue(rt); errorValue.setProperty(rt, "__staticHermesWasiError", std::move(errorPayload)); return errorValue;`;
}

function generateWitEnumErrorReturn(apiPackage, type, expression) {
    const cases = type.values.map(
        (value) =>
            `case ${enumValue(apiPackage, type, value)}: { Object errorValue(rt); errorValue.setProperty(rt, "__staticHermesWasiError", jsString(rt, ${JSON.stringify(value)})); return errorValue; }`
    );
    return `switch (${expression}) { ${cases.join(' ')} default: throw JSError(rt, ${JSON.stringify(`Unknown ${type.name} value`)}); }`;
}

/** Convert a supported result payload to a JavaScript value before freeing its WIT storage. */
function generateWitResultValue(apiPackage, apiInterface, type, expression, name) {
    if (type.kind === 'unit') return { setup: [], expression: 'Value::undefined()' };
    if (type.kind === 'enum') {
        const cases = type.values.map(
            (value) =>
                `case ${enumValue(apiPackage, type, value)}: ${name} = jsString(rt, ${JSON.stringify(value)}); break;`
        );
        return {
            setup: [
                `String ${name} = jsString(rt, ${JSON.stringify(type.values[0])});`,
                `switch (${expression}) { ${cases.join(' ')} default: throw JSError(rt, ${JSON.stringify(`Unknown ${type.name} value`)}); }`
            ],
            expression: `std::move(${name})`
        };
    }
    if (type.kind === 'flags') {
        const setup = [`Object ${name}(rt);`];
        for (const flag of type.values) {
            setup.push(
                `${name}.setProperty(rt, ${JSON.stringify(jsName(flag))}, Value((${expression} & ${enumValue(apiPackage, type, flag)}) != 0));`
            );
        }
        return { setup, expression: `std::move(${name})` };
    }
    if (type.kind === 'primitive') return { setup: [], expression: primitiveOutput(type, expression, 'rt') };
    if (type.kind === 'resource') return generateWitResourceObject(apiPackage, type, expression, name);
    if (type.kind === 'list' && type.item.kind === 'primitive' && type.item.name === 'u8') {
        return {
            setup: [
                `Uint8Array ${name}(rt, ${expression}.len);`,
                `if (${expression}.len) { auto ${name}Buffer = ${name}.buffer(rt); std::memcpy(${name}Buffer.data(rt), ${expression}.ptr, ${expression}.len); }`
            ],
            expression: `std::move(${name})`
        };
    }
    if (type.kind === 'list') {
        const item = generateWitResultValue(
            apiPackage,
            apiInterface,
            type.item,
            `${expression}.ptr[index]`,
            `${name}Item`
        );
        if (!item) return undefined;
        const typedArray = typedArrayConstructor(type.item);
        if (typedArray) {
            return {
                setup: [
                    `Value ${name}Value = rt.global().getPropertyAsFunction(rt, ${JSON.stringify(typedArray)}).callAsConstructor(rt, Value(static_cast<double>(${expression}.len)));`,
                    `Object ${name} = ${name}Value.asObject(rt);`,
                    `for (std::size_t index = 0; index < ${expression}.len; ++index) { ${item.setup.join(' ')} ${name}.setProperty(rt, std::to_string(index).c_str(), ${item.expression}); }`
                ],
                expression: `std::move(${name})`
            };
        }
        return {
            setup: [
                `Array ${name}(rt, ${expression}.len);`,
                `for (std::size_t index = 0; index < ${expression}.len; ++index) { ${item.setup.join(' ')} ${name}.setValueAtIndex(rt, index, ${item.expression}); }`
            ],
            expression: `std::move(${name})`
        };
    }
    if (type.kind === 'option') {
        const item = generateWitResultValue(apiPackage, apiInterface, type.item, `${expression}.val`, `${name}Item`);
        if (!item) return undefined;
        return {
            setup: [
                `Value ${name} = Value::null();`,
                `if (${expression}.is_some) { ${item.setup.join(' ')} ${name} = Value(${item.expression}); }`
            ],
            expression: `std::move(${name})`
        };
    }
    if (type.kind === 'record') {
        const setup = [`Object ${name}(rt);`];
        for (const field of type.fields) {
            const fieldType = field.resolvedType ?? resolveWitTypeFromField(field, type, apiPackage);
            const fieldName = `${name}${pascalCase(field.name)}`;
            const value = generateWitResultValue(
                apiPackage,
                apiInterface,
                fieldType,
                `${expression}.${cFieldIdentifier(field.name)}`,
                fieldName
            );
            if (!value) return undefined;
            setup.push(
                ...value.setup,
                `${name}.setProperty(rt, ${JSON.stringify(jsName(field.name))}, ${value.expression});`
            );
        }
        return { setup, expression: `std::move(${name})` };
    }
    if (type.kind === 'tuple') {
        const setup = [`Array ${name}(rt, ${type.items.length});`];
        for (const [index, itemType] of type.items.entries()) {
            const item = generateWitResultValue(
                apiPackage,
                apiInterface,
                itemType,
                `${expression}.f${index}`,
                `${name}Item${index}`
            );
            if (!item) return undefined;
            setup.push(...item.setup, `${name}.setValueAtIndex(rt, ${index}, ${item.expression});`);
        }
        return { setup, expression: `std::move(${name})` };
    }
    if (type.kind === 'variant') {
        const setup = [`Object ${name}(rt);`, `switch (${expression}.tag) {`];
        for (const variant of type.cases) {
            const tag = enumValue(apiPackage, type, variant.name);
            if (!variant.type) {
                setup.push(
                    `case ${tag}: ${name}.setProperty(rt, "tag", ${JSON.stringify(jsVariantTag(variant.name))}); break;`
                );
                continue;
            }
            const variantType = variant.resolvedType ?? resolveWitTypeFromField(variant, type, apiPackage);
            const payloadName = `${name}${pascalCase(variant.name)}`;
            const value = generateWitResultValue(
                apiPackage,
                apiInterface,
                variantType,
                `${expression}.val.${cFieldIdentifier(variant.name)}`,
                payloadName
            );
            if (!value) return undefined;
            setup.push(
                `case ${tag}: { ${name}.setProperty(rt, "tag", ${JSON.stringify(jsVariantTag(variant.name))}); ${value.setup.join(' ')} ${name}.setProperty(rt, "val", ${value.expression}); break; }`
            );
        }
        setup.push(`default: throw JSError(rt, ${JSON.stringify(`Unknown ${type.name} variant`)});`, '}');
        return { setup, expression: `std::move(${name})` };
    }
    if (type.kind === 'result') {
        const ok = generateWitResultValue(apiPackage, apiInterface, type.ok, `${expression}.val.ok`, `${name}Ok`);
        const error = generateWitResultValue(
            apiPackage,
            apiInterface,
            type.error,
            `${expression}.val.err`,
            `${name}Error`
        );
        if (!ok || !error) return undefined;
        const okValue = [...ok.setup, `${name}.setProperty(rt, "val", ${ok.expression});`].join(' ');
        const errorValue =
            type.error.kind === 'unit'
                ? ''
                : [...error.setup, `${name}.setProperty(rt, "val", ${error.expression});`].join(' ');
        return {
            setup: [
                `Object ${name}(rt); if (${expression}.is_err) { ${name}.setProperty(rt, "tag", "err"); ${errorValue} } else { ${name}.setProperty(rt, "tag", "ok"); ${okValue} }`
            ],
            expression: `std::move(${name})`
        };
    }
    return undefined;
}

/** Generate a JavaScript host object for an owned resource nested in a WIT value. */
function generateWitResourceObject(apiPackage, type, expression, name) {
    const ownerPackage = apiPackage.packageName.startsWith('wasi:') ? (type.packageName ?? apiPackage.packageName) : '';
    const stateName = `${name}State`;
    return {
        setup: [
            `auto ${stateName} = std::make_shared<ResourceState>(ResourceState{ResourceKind::Wit, ${expression}.__handle, true, ${JSON.stringify(type.interfaceName)}, ${JSON.stringify(type.name)}, ${JSON.stringify(ownerPackage)}});`
        ],
        expression: `wrapResourceObject(rt, makeWitResourceObject(${stateName}))`
    };
}

/** Return the WIT-owned C value destructor for a generated result payload. */
function witFreeFunction(apiPackage, apiInterface, type) {
    if (type.kind === 'enum' || type.kind === 'flags') return undefined;
    if (type.kind === 'resource' || type.kind === 'borrow') return undefined;
    if (type.kind === 'record' && !type.fields.some((field) => witTypeNeedsFree(field.resolvedType))) return undefined;
    if (type.kind === 'primitive') return type.name === 'string' ? 'plugin_string_free' : undefined;
    if (type.kind === 'list' && type.item.kind === 'primitive' && type.item.name === 'u8') {
        if (!type.aliasName) return 'plugin_list_u8_free';
    }
    if (type.kind === 'list' && !type.aliasName) {
        const namespace = witTypeNamespace(apiPackage, apiInterface, type);
        return `${namespace}_${witTypeName(type)}_free`;
    }
    if (type.kind === 'option' && !type.aliasName && type.item.kind === 'primitive') {
        return `plugin_${witTypeName(type)}_free`;
    }
    if (type.kind === 'option' && !type.aliasName) {
        const namespace = witTypeNamespace(apiPackage, apiInterface, type);
        return `${namespace}_${witTypeName(type)}_free`;
    }
    if (type.kind === 'tuple' && (!witTypeNeedsFree(type) || !containsNamedWitType(type))) return undefined;
    if (!type.aliasName && !['list', 'option', 'result', 'record', 'tuple', 'variant'].includes(type.kind))
        return undefined;
    const namespace = cIdentifier(type.packageName ?? apiPackage.packageName);
    const interfaceName = cIdentifier(type.declaredInterface ?? type.interfaceName ?? apiInterface.name);
    return `${namespace}_${interfaceName}_${witTypeName(type)}_free`;
}

/** Generate cleanup statements for WIT-owned values, including values nested in tuples. */
function witFreeCode(apiPackage, apiInterface, type, expression) {
    const free = witFreeFunction(apiPackage, apiInterface, type);
    if (free) return `${free}(&${expression});`;
    if (type.kind === 'tuple') {
        return type.items
            .map((item, index) => witFreeCode(apiPackage, apiInterface, item, `${expression}.f${index}`))
            .filter(Boolean)
            .join(' ');
    }
    if (type.kind === 'record') {
        return type.fields
            .map((field) =>
                witFreeCode(
                    apiPackage,
                    apiInterface,
                    field.resolvedType,
                    `${expression}.${cFieldIdentifier(field.name)}`
                )
            )
            .filter(Boolean)
            .join(' ');
    }
    return '';
}

/** Check whether freeing a WIT value may release owned memory. */
function witTypeNeedsFree(type) {
    if (type.kind === 'primitive') return type.name === 'string';
    if (['list', 'option', 'result', 'variant'].includes(type.kind)) return true;
    if (type.kind === 'record') return type.fields.some((field) => witTypeNeedsFree(field.resolvedType));
    if (type.kind === 'tuple') return type.items.some(witTypeNeedsFree);
    return false;
}

/** Generate native-to-JavaScript conversion code for a WIT enum result. */
function generateWitEnumResult(apiPackage, type, call) {
    const cases = type.values.map(
        (value) => `case ${enumValue(apiPackage, type, value)}: return jsString(rt, ${JSON.stringify(value)});`
    );
    return {
        setup: [],
        call: `const auto result = ${call};`,
        cleanup: [],
        return: `switch (result) { ${cases.join(' ')} default: throw JSError(rt, ${JSON.stringify(`Unknown ${type.name} value`)}); }`
    };
}

/** Generate resource, optional-resource, or resource-list result conversion code. */
function generateWitResourceResult(
    apiPackage,
    apiInterface,
    type,
    functionName,
    argumentsList,
    resourceDrops,
    resultKind
) {
    const ownerInterface = type.interfaceName;
    const resource = type.name;
    resourceDrops.set(`${ownerInterface}.${resource}`, [ownerInterface, resource]);
    const ownType = witCType(apiPackage, apiInterface, type);
    /** Generate the native wrapper return statement for one owned resource. */
    const ownerPackage = apiPackage.packageName.startsWith('wasi:') ? (type.packageName ?? apiPackage.packageName) : '';
    const create = (source) =>
        `auto resource = std::make_shared<ResourceState>(ResourceState{ResourceKind::Wit, ${source}.__handle, true, ${JSON.stringify(ownerInterface)}, ${JSON.stringify(resource)}, ${JSON.stringify(ownerPackage)}}); return wrapResourceObject(rt, makeWitResourceObject(resource));`;
    if (resultKind === 'resource') {
        return {
            setup: [],
            call: `const auto result = ${functionName}(${argumentsList.join(', ')});`,
            cleanup: [],
            return: create('result')
        };
    }
    if (resultKind === 'option') {
        return {
            setup: [`${ownType} result{};`],
            call: `const bool hasResult = ${functionName}(${[...argumentsList, '&result'].join(', ')});`,
            cleanup: [],
            return: `if (!hasResult) return Value::null(); ${create('result')}`
        };
    }
    const listResourceType = {
        kind: 'list',
        item: type,
        packageName: type.packageName ?? apiPackage.packageName,
        interfaceName: type.declaredInterface ?? type.interfaceName ?? apiInterface.name
    };
    const listType = witCType(apiPackage, apiInterface, listResourceType);
    const freeList = `${witTypeNamespace(apiPackage, apiInterface, listResourceType)}_${witTypeName(listResourceType)}_free`;
    return {
        setup: [`${listType} result{};`],
        call: `${functionName}(${[...argumentsList, '&result'].join(', ')});`,
        cleanup: [],
        return: `Array value(rt, result.len); for (std::size_t index = 0; index < result.len; ++index) { auto resource = std::make_shared<ResourceState>(ResourceState{ResourceKind::Wit, result.ptr[index].__handle, true, ${JSON.stringify(ownerInterface)}, ${JSON.stringify(resource)}, ${JSON.stringify(ownerPackage)}}); value.setValueAtIndex(rt, index, wrapResourceObject(rt, makeWitResourceObject(resource))); } ${freeList}(&result); return value;`
    };
}

/** Create a JavaScript host object for an owned WIT resource handle. */
function generateWitResourceValue(apiPackage, type, expression) {
    const ownerPackage = apiPackage.packageName.startsWith('wasi:') ? (type.packageName ?? apiPackage.packageName) : '';
    return `auto resourceState = std::make_shared<ResourceState>(ResourceState{ResourceKind::Wit, ${expression}.__handle, true, ${JSON.stringify(type.interfaceName)}, ${JSON.stringify(type.name)}, ${JSON.stringify(ownerPackage)}}); return wrapResourceObject(rt, makeWitResourceObject(resourceState));`;
}

/** Return the generated C type corresponding to a resolved WIT type. */
function witCType(apiPackage, apiInterface, type) {
    if (type.kind === 'primitive') {
        const primitiveTypes = {
            bool: 'bool',
            char: 'uint32_t',
            u8: 'uint8_t',
            s8: 'int8_t',
            u16: 'uint16_t',
            s16: 'int16_t',
            u32: 'uint32_t',
            s32: 'int32_t',
            u64: 'uint64_t',
            s64: 'int64_t',
            f32: 'float',
            f64: 'double',
            string: 'plugin_string_t'
        };
        return primitiveTypes[type.name];
    }
    if (type.kind === 'resource') {
        const packageName = type.packageName ?? apiPackage.packageName;
        const interfaceName = type.interfaceName ?? apiInterface.name;
        const resourceName = type.aliasName ?? type.name;
        return `${cIdentifier(packageName)}_${cIdentifier(interfaceName)}_own_${cIdentifier(resourceName)}_t`;
    }
    if (type.kind === 'borrow' && type.item.kind === 'resource') {
        const packageName = type.item.packageName ?? apiPackage.packageName;
        const interfaceName = type.item.interfaceName ?? apiInterface.name;
        const resourceName = type.item.aliasName ?? type.item.name;
        return `${cIdentifier(packageName)}_${cIdentifier(interfaceName)}_borrow_${cIdentifier(resourceName)}_t`;
    }
    if (type.kind === 'tuple' && !type.aliasName) {
        const namespace = witTypeNamespace(apiPackage, apiInterface, type);
        return `${namespace}_${witTypeName(type)}_t`;
    }
    if (type.kind === 'list' && !type.aliasName) {
        if (type.item.kind === 'primitive' && type.item.name === 'u8') return 'plugin_list_u8_t';
        const namespace = witTypeNamespace(apiPackage, apiInterface, type);
        return `${namespace}_${witTypeName(type)}_t`;
    }
    if (type.kind === 'option' && !type.aliasName) {
        if (type.item.kind === 'primitive') return `plugin_${witTypeName(type)}_t`;
        const namespace = witTypeNamespace(apiPackage, apiInterface, type);
        return `${namespace}_${witTypeName(type)}_t`;
    }
    if (type.kind === 'result') {
        const name = `result_${witTypeName(type.ok)}_${witTypeName(type.error)}`;
        const namespace = witTypeNamespace(apiPackage, apiInterface, type);
        return `${namespace}_${name}_t`;
    }
    const name = type.aliasName ?? type.name;
    const packageName = type.packageName ?? apiPackage.packageName;
    const interfaceName = type.declaredInterface ?? type.interfaceName ?? apiInterface.name;
    return `${cIdentifier(packageName)}_${cIdentifier(interfaceName)}_${cIdentifier(name)}_t`;
}

/** Return the generated namespace for anonymous WIT types. */
function witTypeNamespace(apiPackage, apiInterface, type) {
    if (containsNamedWitType(type)) {
        const packageName = type.packageName ?? apiPackage.packageName;
        const interfaceName = type.declaredInterface ?? type.interfaceName ?? apiInterface.name;
        return `${cIdentifier(packageName)}_${cIdentifier(interfaceName)}`;
    }
    return 'plugin';
}

/** Check whether a structural WIT type contains a named WIT declaration. */
function containsNamedWitType(type) {
    if (type.aliasName || ['enum', 'flags', 'record', 'resource', 'variant'].includes(type.kind)) return true;
    if (['borrow', 'list', 'option'].includes(type.kind)) return containsNamedWitType(type.item);
    if (type.kind === 'tuple') return type.items.some(containsNamedWitType);
    if (type.kind === 'result') return containsNamedWitType(type.ok) || containsNamedWitType(type.error);
    return false;
}

/** Build the componentize-c type name used inside a generated result struct. */
function witTypeName(type) {
    if (type.kind === 'unit') return 'void';
    if (type.kind === 'resource') return `own_${cIdentifier(type.aliasName ?? type.name)}`;
    if (type.kind === 'borrow' && type.item.kind === 'resource') {
        return `borrow_${cIdentifier(type.item.aliasName ?? type.item.name)}`;
    }
    if (type.aliasName) return cIdentifier(type.aliasName);
    if (type.kind === 'primitive') return cIdentifier(type.name);
    if (type.kind === 'result') return `result_${witTypeName(type.ok)}_${witTypeName(type.error)}`;
    if (type.kind === 'list') return `list_${witTypeName(type.item)}`;
    if (type.kind === 'option') return `option_${witTypeName(type.item)}`;
    if (type.kind === 'tuple') return `tuple${type.items.length}_${type.items.map(witTypeName).join('_')}`;
    if (type.kind === 'borrow') return `borrow_${witTypeName(type.item)}`;
    if (type.name) return cIdentifier(type.name);
    return cIdentifier(type.kind);
}

/** Check whether a structural WIT type contains owned resource handles. */
function containsWitResource(type) {
    if (type.kind === 'resource') return true;
    if (type.kind === 'option' || type.kind === 'list' || type.kind === 'borrow') return containsWitResource(type.item);
    if (type.kind === 'tuple') return type.items.some(containsWitResource);
    if (type.kind === 'record') return type.fields.some((field) => containsWitResource(field.resolvedType));
    if (type.kind === 'variant')
        return type.cases.some((variant) => variant.resolvedType && containsWitResource(variant.resolvedType));
    if (type.kind === 'result') return containsWitResource(type.ok) || containsWitResource(type.error);
    return false;
}

/** Generate a C++ expression that converts a JavaScript input to a WIT scalar. */
function primitiveInput(type, expression, runtime) {
    if (type.kind === 'enum') return expression;
    if (type.kind !== 'primitive') return '0';
    if (type.name === 'bool') return `${expression}.getBool()`;
    if (type.name === 'char') return `wasiInputChar(${runtime}, ${expression})`;
    if (type.name === 'string') return `wasiInputString(${runtime}, ${expression})`;
    if (type.name === 'u64') return `${expression}.asBigInt(${runtime}).asUint64(${runtime})`;
    if (type.name === 's64') return `${expression}.asBigInt(${runtime}).asInt64(${runtime})`;
    return `static_cast<${witCScalarType(type.name)}>(${expression}.asNumber())`;
}

/** Generate a C++ expression that converts a WIT scalar to a JavaScript value. */
function primitiveOutput(type, expression, runtime) {
    if (type.kind === 'enum') return `jsString(${runtime}, ${expression})`;
    if (type.kind !== 'primitive') return 'Value::undefined()';
    if (type.name === 'bool') return `Value(${expression})`;
    if (type.name === 'char')
        return `jsString(${runtime}, wasiOutputChar(${runtime}, static_cast<uint32_t>(${expression})))`;
    if (type.name === 'string') return `jsString(${runtime}, wasiStringValue(${expression}))`;
    if (type.name === 'u64') return `BigInt::fromUint64(${runtime}, static_cast<uint64_t>(${expression}))`;
    if (type.name === 's64') return `BigInt::fromInt64(${runtime}, static_cast<int64_t>(${expression}))`;
    return `Value(static_cast<double>(${expression}))`;
}

/** Map a numeric WIT scalar name to its C type. */
function witCScalarType(name) {
    return (
        {
            char: 'uint32_t',
            u8: 'uint8_t',
            s8: 'int8_t',
            u16: 'uint16_t',
            s16: 'int16_t',
            u32: 'uint32_t',
            s32: 'int32_t',
            f32: 'float',
            f64: 'double'
        }[name] ?? 'double'
    );
}

/** Map primitive WIT list elements to the typed-array classes generated API bindings use. */
function typedArrayConstructor(type) {
    if (type.kind !== 'primitive') return undefined;
    return {
        u8: 'Uint8Array',
        s8: 'Int8Array',
        u16: 'Uint16Array',
        s16: 'Int16Array',
        u32: 'Uint32Array',
        s32: 'Int32Array',
        u64: 'BigUint64Array',
        s64: 'BigInt64Array',
        f32: 'Float32Array',
        f64: 'Float64Array'
    }[type.name];
}

/** Build the generated C enum constant for a WIT enum case. */
function enumValue(apiPackage, type, value) {
    return `${cIdentifier(type.packageName ?? apiPackage.packageName).toUpperCase()}_${cIdentifier(type.interfaceName).toUpperCase()}_${cIdentifier(type.name).toUpperCase()}_${cIdentifier(value).toUpperCase()}`;
}

/** Convert a WIT field name to a C identifier, avoiding reserved keywords. */
function cFieldIdentifier(name) {
    const identifier = cIdentifier(name).replace(/[A-Z]/g, (character) => character.toLowerCase());
    return C_RESERVED_FIELD_NAMES.has(identifier) ? `${identifier}_` : identifier;
}

const C_RESERVED_FIELD_NAMES = new Set(
    'alignas alignof and and_eq asm atomic_cancel atomic_commit atomic_noexcept auto bitand bitor bool break case catch char char8_t char16_t char32_t class compl concept const consteval constexpr constinit const_cast continue co_await co_return co_yield decltype default delete do double dynamic_cast else enum explicit export extern false float for friend goto if inline int long mutable namespace new noexcept not not_eq nullptr operator or or_eq private protected public register reinterpret_cast requires return short signed sizeof static static_assert static_cast struct switch synchronized template this thread_local throw true try typedef typeid typename union unsigned using virtual void volatile wchar_t while xor xor_eq'.split(
        /\s+/
    )
);

/** Generate native event payload conversion for WIT events and fields used by the plugin bundle. */
export function generateWitEventDispatch(apiPackage, bundleSource = '') {
    const eventInterface = apiPackage.interfaces.find((apiInterface) => apiInterface.name === 'event');
    const eventVariant = eventInterface?.variants.find((variant) => variant.name === 'event');
    if (!eventVariant) return '';

    const records = new Map(
        apiPackage.interfaces.flatMap((apiInterface) => apiInterface.records.map((record) => [record.name, record]))
    );
    const context = { apiPackage, bundleSource, eventInterface };
    const cases = [];

    for (const event of eventVariant.cases) {
        if (!bundleUsesString(bundleSource, event.name)) continue;
        const record = records.get(event.type);
        if (!record) throw new Error(`WIT event ${event.name} refers to missing record ${event.type}`);
        const fields = record.fields
            .filter((field) => bundleUsesProperty(bundleSource, jsName(field.name)))
            .map((field) =>
                generateEventField(field, `eventData.${cIdentifier(field.name)}`, jsName(field.name), 'data', context)
            );
        const eventName = cIdentifier(event.name);
        cases.push(`case PUMPKIN_PLUGIN_EVENT_EVENT_TYPE_${event.name.toUpperCase().replaceAll('-', '_')}: {
    auto &eventData = event->val.${eventName};
${fields.map((field) => indent(field, 4)).join('\n')}
    break;
  }`);
    }

    if (!cases.length) return '';
    return `switch (event->tag) {\n${cases.join('\n')}\n}`;
}

/** Map scalar WIT types to C++ expressions that create JavaScript values. */
const scalarEventConversions = new Map([
    ['bool', (value) => `Value(${value})`],
    ['char', (value) => `jsString(runtime, wasiOutputChar(runtime, static_cast<uint32_t>(${value})))`],
    ['u8', (value) => `Value(static_cast<double>(${value}))`],
    ['s8', (value) => `Value(static_cast<double>(${value}))`],
    ['u16', (value) => `Value(static_cast<double>(${value}))`],
    ['s16', (value) => `Value(static_cast<double>(${value}))`],
    ['u32', (value) => `Value(static_cast<double>(${value}))`],
    ['s32', (value) => `Value(static_cast<double>(${value}))`],
    ['u64', (value) => `BigInt::fromUint64(runtime, static_cast<uint64_t>(${value}))`],
    ['s64', (value) => `BigInt::fromInt64(runtime, static_cast<int64_t>(${value}))`],
    ['f32', (value) => `Value(static_cast<double>(${value}))`],
    ['f64', (value) => `Value(${value})`],
    ['string', (value) => `jsString(runtime, wasiStringValue(${value}))`]
]);

/** Map WIT event resource types to their native host object wrappers. */
const eventResourceAdapters = new Map([
    ['player:player', { kind: 'Player', host: 'PlayerObject' }],
    ['world:world', { kind: 'World', host: 'WorldObject' }],
    ['text:text-component', { kind: 'Text', host: 'TextObject' }]
]);

/** Generate native event field conversion code for resolved WIT value shapes. */
function generateEventField(field, source, path, target, context) {
    const value = generateRecursiveEventValue(
        resolveWitType(context.apiPackage, context.eventInterface, field.type),
        source,
        path,
        context
    );
    return value.setup
        .concat(`${target}.setProperty(runtime, ${JSON.stringify(propertyName(path))}, ${value.expression});`)
        .join('\n');
}

/** Recursively convert a WIT event value into a JavaScript value. */
function generateRecursiveEventValue(type, source, path, context) {
    const name = `eventValue${pascalCase(path)}`;
    if (type.kind === 'unit') return { setup: [], expression: 'Value::undefined()' };
    if (type.kind === 'primitive') {
        const conversion = scalarEventConversions.get(type.name);
        if (conversion) return { setup: [], expression: conversion(source) };
    }
    if (type.kind === 'enum') {
        const cases = type.values.map(
            (value) => `case ${enumValue(context.apiPackage, type, value)}: ${name} = ${JSON.stringify(value)}; break;`
        );
        return {
            setup: [
                `std::string ${name};`,
                `switch (${source}) { ${cases.join(' ')} default: throw JSError(runtime, ${JSON.stringify(`Unknown ${type.name} value`)}); }`
            ],
            expression: `jsString(runtime, ${name})`
        };
    }
    if (type.kind === 'flags') {
        const setup = [`Object ${name}(runtime);`];
        for (const flag of type.values) {
            setup.push(
                `${name}.setProperty(runtime, ${JSON.stringify(jsName(flag))}, Value((${source} & ${enumValue(context.apiPackage, type, flag)}) != 0));`
            );
        }
        return { setup, expression: `std::move(${name})` };
    }
    if (type.kind === 'resource') {
        const adapter = eventResourceAdapters.get(`${type.interfaceName}:${type.name}`);
        const state = `${name}State`;
        const resourceState = adapter
            ? `ResourceState{ResourceKind::${adapter.kind}, ${source}.__handle, true}`
            : 'ResourceState{ResourceKind::Wit, ' +
              source +
              '.__handle, true, ' +
              JSON.stringify(type.interfaceName) +
              ', ' +
              JSON.stringify(type.name) +
              '}';
        const hostObject = adapter ? `std::make_shared<${adapter.host}>(${state})` : `makeWitResourceObject(${state})`;
        return {
            setup: [
                `auto ${state} = std::make_shared<ResourceState>(${resourceState});`,
                `ownedResources->push_back(${state});`
            ],
            expression: `wrapResourceObject(runtime, ${hostObject})`
        };
    }
    if (type.kind === 'borrow' && type.item.kind === 'resource') {
        return generateRecursiveEventValue(type.item, source, path, context);
    }
    if (type.kind === 'option') {
        const item = generateRecursiveEventValue(type.item, `${source}.val`, `${path}.value`, context);
        return {
            setup: [
                `Value ${name} = Value::null();`,
                `if (${source}.is_some) {`,
                ...item.setup.map((line) => `  ${line}`),
                `  ${name} = Value(${item.expression});`,
                '}'
            ],
            expression: `std::move(${name})`
        };
    }
    if (type.kind === 'list' && type.item.kind === 'primitive' && type.item.name === 'u8') {
        return {
            setup: [
                `Uint8Array ${name}(runtime, ${source}.len);`,
                `if (${source}.len) { auto ${name}Buffer = ${name}.buffer(runtime); std::memcpy(${name}Buffer.data(runtime), ${source}.ptr, ${source}.len); }`
            ],
            expression: `std::move(${name})`
        };
    }
    if (type.kind === 'list') {
        const index = `${name}Index`;
        const item = generateRecursiveEventValue(type.item, `${source}.ptr[${index}]`, `${path}.item`, context);
        return {
            setup: [
                `Array ${name}(runtime, ${source}.len);`,
                `for (std::size_t ${index} = 0; ${index} < ${source}.len; ++${index}) {`,
                ...item.setup.map((line) => `  ${line}`),
                `  ${name}.setValueAtIndex(runtime, ${index}, ${item.expression});`,
                '}'
            ],
            expression: `std::move(${name})`
        };
    }
    if (type.kind === 'tuple') {
        const setup = [`Array ${name}(runtime, ${type.items.length});`];
        for (const [index, itemType] of type.items.entries()) {
            const item = generateRecursiveEventValue(itemType, `${source}.f${index}`, `${path}.item${index}`, context);
            setup.push(...item.setup, `${name}.setValueAtIndex(runtime, ${index}, ${item.expression});`);
        }
        return { setup, expression: `std::move(${name})` };
    }
    if (type.kind === 'record') {
        const setup = [`Object ${name}(runtime);`];
        for (const field of type.fields) {
            const childName = jsName(field.name);
            if (!bundleUsesNestedProperty(context.bundleSource, path, childName)) continue;
            const fieldValue = generateRecursiveEventValue(
                field.resolvedType,
                `${source}.${cIdentifier(field.name)}`,
                `${path}.${childName}`,
                context
            );
            setup.push(
                ...fieldValue.setup,
                `${name}.setProperty(runtime, ${JSON.stringify(childName)}, ${fieldValue.expression});`
            );
        }
        return { setup, expression: `std::move(${name})` };
    }
    if (type.kind === 'variant') {
        const setup = [`Object ${name}(runtime);`, `switch (${source}.tag) {`];
        for (const variant of type.cases) {
            const variantName = jsVariantTag(variant.name);
            const branch = [`${name}.setProperty(runtime, "tag", jsString(runtime, ${JSON.stringify(variantName)}));`];
            if (variant.resolvedType) {
                const payload = generateRecursiveEventValue(
                    variant.resolvedType,
                    `${source}.val.${cFieldIdentifier(variant.name)}`,
                    `${path}.val`,
                    context
                );
                branch.push(...payload.setup, `${name}.setProperty(runtime, "val", ${payload.expression});`);
            }
            setup.push(`case ${enumValue(context.apiPackage, type, variant.name)}: { ${branch.join(' ')} break; }`);
        }
        setup.push(`default: throw JSError(runtime, ${JSON.stringify(`Unknown ${type.name} variant`)});`, '}');
        return { setup, expression: `std::move(${name})` };
    }
    if (type.kind === 'result') {
        const ok = generateRecursiveEventValue(type.ok, `${source}.val.ok`, `${path}.val`, context);
        const error = generateRecursiveEventValue(type.error, `${source}.val.err`, `${path}.val`, context);
        const setup = [`Object ${name}(runtime);`, `if (${source}.is_err) {`];
        setup.push(
            `  ${name}.setProperty(runtime, "tag", "err");`,
            ...error.setup.map((line) => `  ${line}`),
            ...(type.error.kind === 'unit' ? [] : [`  ${name}.setProperty(runtime, "val", ${error.expression});`]),
            '} else {',
            `  ${name}.setProperty(runtime, "tag", "ok");`,
            ...ok.setup.map((line) => `  ${line}`),
            `  ${name}.setProperty(runtime, "val", ${ok.expression});`,
            '}'
        );
        return { setup, expression: `std::move(${name})` };
    }
    throw new Error(`Static Hermes cannot convert WIT event field type ${type.source ?? type.kind} (${path})`);
}

/** Return the final property name in a dotted JavaScript access path. */
function propertyName(path) {
    return path.split('.').at(-1);
}

/** Check whether the plugin bundle contains a quoted occurrence of a WIT name. */
function bundleUsesString(source, value) {
    return source.includes(JSON.stringify(value)) || source.includes(`'${value}'`);
}

/** Check whether the bundle accesses a property using dot or bracket notation. */
function bundleUsesProperty(source, property) {
    const escaped = escapeRegExp(property);
    return new RegExp(`(?:\\.|\\[\\s*["'])${escaped}(?:\\b|["']\\s*\\])`).test(source);
}

/** Check whether the bundle accesses a property nested under a dotted parent path. */
function bundleUsesNestedProperty(source, parent, property) {
    const escapedParent = parent.split('.').map(escapeRegExp).join('\\s*\\.\\s*');
    const escapedProperty = escapeRegExp(property);
    return (
        new RegExp(`\\.${escapedParent}\\s*\\.\\s*${escapedProperty}\\b`).test(source) ||
        bundleUsesProperty(source, property)
    );
}

/** Prefix every line with the requested number of spaces. */
function indent(value, spaces) {
    const prefix = ' '.repeat(spaces);
    return value
        .split('\n')
        .map((line) => `${prefix}${line}`)
        .join('\n');
}

/** Parse all WASI interface definitions below a WIT root, keyed by specifier. */
function readWasiInterfaceDefinitions(root) {
    const definitions = new Map();
    for (const witPath of findWitFiles(root)) {
        const source = stripComments(fs.readFileSync(witPath, 'utf8'));
        const packageMatch = /\bpackage\s+([^;]+);/.exec(source);
        const packageDeclaration = packageMatch?.[1].trim() ?? readPackageDeclaration(root, witPath);
        if (!packageDeclaration) continue;
        const [packageName, version] = packageDeclaration.split('@', 2);
        if (!packageName.startsWith('wasi:')) continue;

        for (const match of source.matchAll(/\binterface\s+%?([a-zA-Z][\w-]*)\s*\{/g)) {
            const name = match[1];
            const body = namedBlock(source, 'interface', name, witPath);
            const parsed = parseInterfaceBody(body, witPath);
            const specifier = wasiSpecifier(packageName, name, version);
            const dependencyTypes = parseWitDependencies(body, packageName, version);
            definitions.set(specifier, {
                name,
                packageName,
                version,
                specifier,
                functions: parsed.functions,
                resources: parsed.resources,
                records: parsed.records,
                variants: parsed.variants,
                enums: parsed.enums,
                flags: parsed.flags,
                types: parsed.types,
                dependencies: [...dependencyTypes.keys()],
                dependencyTypes: Object.fromEntries(dependencyTypes),
                dependencyAliases: parseWitDependencyAliases(body, packageName, version)
            });
        }
    }
    return definitions;
}

/** Find the nearest package declaration applying to a WIT file. */
function readPackageDeclaration(root, witPath) {
    let directory = path.dirname(witPath);
    while (directory === root || directory.startsWith(`${root}${path.sep}`)) {
        const files = fs
            .readdirSync(directory, { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.endsWith('.wit'))
            .map((entry) => path.join(directory, entry.name));
        for (const packagePath of files) {
            const source = stripComments(fs.readFileSync(packagePath, 'utf8'));
            const match = /\bpackage\s+([^;]+);/.exec(source);
            if (match) return match[1].trim();
        }
        if (directory === root) break;
        directory = path.dirname(directory);
    }
    return undefined;
}

/** Recursively list WIT interface files below a directory. */
function findWitFiles(directory) {
    const files = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) files.push(...findWitFiles(entryPath));
        else if (entry.isFile() && entry.name.endsWith('.wit') && entry.name !== 'plugin.wit') files.push(entryPath);
    }
    return files;
}

/** Parse `use` declarations into dependency specifiers and imported type names. */
function parseWitDependencies(interfaceBody, packageName, version) {
    const dependencies = new Map();
    for (const { specifier, items } of parseWitUses(interfaceBody, packageName, version)) {
        const types = items.map((item) =>
            item
                .split(/\s+as\s+/)[0]
                .trim()
                .replace(/^%/, '')
        );
        dependencies.set(specifier, [...new Set([...(dependencies.get(specifier) ?? []), ...types])]);
    }
    return dependencies;
}

/** Parse WIT `use` renames so referenced aliases resolve to their declared dependency types. */
function parseWitDependencyAliases(interfaceBody, packageName, version) {
    const aliases = {};
    for (const { specifier, items } of parseWitUses(interfaceBody, packageName, version)) {
        for (const item of items) {
            const imported = /^%?([\w-]+)(?:\s+as\s+%?([\w-]+))?$/.exec(item.trim());
            if (!imported?.[2]) continue;
            aliases[imported[2].replace(/^%/, '')] = {
                name: imported[1].replace(/^%/, ''),
                specifier
            };
        }
    }
    return aliases;
}

/** Read imported type names and their resolved WIT interface specifier. */
function* parseWitUses(interfaceBody, packageName, version) {
    const pattern = /\buse\s+([^\s{}]+)\s*\.\s*\{([^}]*)\}/g;
    for (const match of interfaceBody.matchAll(pattern)) {
        const reference = match[1];
        const at = reference.lastIndexOf('@');
        const qualifiedName = at < 0 ? reference : reference.slice(0, at);
        const dependencyVersion = at < 0 ? version : reference.slice(at + 1);
        const slash = qualifiedName.lastIndexOf('/');
        const dependencyPackage = slash < 0 ? packageName : qualifiedName.slice(0, slash);
        const dependencyName = slash < 0 ? qualifiedName : qualifiedName.slice(slash + 1);
        yield {
            specifier: wasiSpecifier(dependencyPackage, dependencyName, dependencyVersion),
            items: splitTopLevel(match[2], ',')
        };
    }
}

/** Build a WIT interface specifier from its package, name, and optional version. */
function wasiSpecifier(packageName, name, version) {
    return `${packageName}/${name}${version ? `@${version}` : ''}`;
}

/** Derive the global host adapter name for a WASI interface. */
function wasiHostName(apiInterface) {
    const namespace = apiInterface.packageName.slice(apiInterface.packageName.indexOf(':') + 1);
    return `__pumpkinWasi${pascalCase(namespace)}${pascalCase(apiInterface.name)}`;
}

/** Convert a separator-delimited identifier to PascalCase. */
function pascalCase(value) {
    return value
        .split(/[^a-zA-Z0-9]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join('');
}

/** Parse an interface body into its WIT declarations. */
function parseInterfaceBody(interfaceBody, witPath) {
    const resources = [];
    const resourceRanges = [];
    const pattern = /\bresource\s+%?([a-zA-Z][\w-]*)\s*(\{|;)/g;
    for (const match of interfaceBody.matchAll(pattern)) {
        const name = match[1];
        if (match[2] === ';') {
            resources.push({ name, functions: [] });
            resourceRanges.push([match.index, match.index + match[0].length]);
        } else {
            const open = match.index + match[0].lastIndexOf('{');
            const close = matchingBrace(interfaceBody, open, witPath);
            resources.push({ name, functions: parseFunctions(interfaceBody.slice(open + 1, close), witPath, true) });
            resourceRanges.push([match.index, close + 1]);
        }
    }
    let functionsBody = interfaceBody;
    for (const [start, end] of resourceRanges.reverse()) {
        functionsBody = `${functionsBody.slice(0, start)}${' '.repeat(end - start)}${functionsBody.slice(end)}`;
    }
    return {
        functions: parseFunctions(functionsBody, witPath),
        resources,
        records: parseRecords(interfaceBody, witPath),
        variants: parseVariants(interfaceBody, witPath),
        enums: parseEnums(interfaceBody, witPath),
        flags: parseFlags(interfaceBody, witPath),
        types: parseTypeAliases(interfaceBody)
    };
}

/** Parse WIT enum declarations from an interface body. */
function parseEnums(body, witPath) {
    return parseNamedCaseLists(body, 'enum', witPath);
}

/** Parse WIT flag declarations from an interface body. */
function parseFlags(body, witPath) {
    return parseNamedCaseLists(body, 'flags', witPath);
}

/** Parse enum or flag case names from an interface body. */
function parseNamedCaseLists(body, declaration, witPath) {
    const declarations = [];
    const pattern = new RegExp(`\\b${declaration}\\s+%?([a-zA-Z][\\w-]*)\\s*\\{`, 'g');
    for (const match of body.matchAll(pattern)) {
        const open = match.index + match[0].lastIndexOf('{');
        const close = matchingBrace(body, open, witPath);
        const values = splitTopLevel(body.slice(open + 1, close), ',')
            .map((value) => value.trim().replace(/^%/, ''))
            .filter(Boolean);
        declarations.push({ name: match[1], values });
    }
    return declarations;
}

/** Parse WIT type alias declarations from an interface body. */
function parseTypeAliases(body) {
    return [...body.matchAll(/\btype\s+%?([a-zA-Z][\w-]*)\s*=\s*([^;]+);/g)].map((match) => ({
        name: match[1],
        type: match[2].trim()
    }));
}

/** Parse WIT record declarations and their fields. */
function parseRecords(body, witPath) {
    const records = [];
    const pattern = /\brecord\s+%?([a-zA-Z][\w-]*)\s*\{/g;
    for (const match of body.matchAll(pattern)) {
        const open = match.index + match[0].lastIndexOf('{');
        const close = matchingBrace(body, open, witPath);
        const fields = splitTopLevel(body.slice(open + 1, close), ',').map((field) => {
            const colon = findTopLevel(field, ':');
            if (colon < 0) throw new Error(`unsupported WIT record field ${field.trim()} in ${witPath}`);
            return {
                name: field.slice(0, colon).trim().replace(/^%/, ''),
                type: field
                    .slice(colon + 1)
                    .trim()
                    .replace(/^%/, '')
            };
        });
        records.push({ name: match[1], fields });
    }
    return records;
}

/** Parse WIT variant declarations and their cases. */
function parseVariants(body, witPath) {
    const variants = [];
    const pattern = /\bvariant\s+%?([a-zA-Z][\w-]*)\s*\{/g;
    for (const match of body.matchAll(pattern)) {
        const open = match.index + match[0].lastIndexOf('{');
        const close = matchingBrace(body, open, witPath);
        const cases = splitTopLevel(body.slice(open + 1, close), ',').map((entry) => {
            const openParen = entry.indexOf('(');
            if (openParen < 0) return { name: entry.trim().replace(/^%/, ''), type: '' };
            const closeParen = matchingParen(entry, openParen, witPath);
            return {
                name: entry.slice(0, openParen).trim().replace(/^%/, ''),
                type: entry.slice(openParen + 1, closeParen).trim()
            };
        });
        variants.push({ name: match[1], cases });
    }
    return variants;
}

/** Parse WIT function declarations and, when requested, resource constructors. */
function parseFunctions(body, witPath, includeConstructors = false) {
    const functions = [];
    const pattern = includeConstructors
        ? /\bconstructor\s*\(|\b%?([a-zA-Z][\w-]*)\s*:\s*(static\s+)?func\s*\(/g
        : /\b%?([a-zA-Z][\w-]*)\s*:\s*func\s*\(/g;
    for (const match of body.matchAll(pattern)) {
        const isConstructor = match[0].startsWith('constructor');
        const open = match.index + match[0].lastIndexOf('(');
        const close = matchingParen(body, open, witPath);
        const parameters = parseParameters(body.slice(open + 1, close), witPath);
        const declarationEnd = body.indexOf(';', close);
        if (declarationEnd < 0) throw new Error(`unterminated WIT function declaration in ${witPath}`);
        const suffix = body.slice(close + 1, declarationEnd).trim();
        const result = /^->\s*([\s\S]+)$/.exec(suffix)?.[1]?.trim() ?? '';
        functions.push({
            name: isConstructor ? 'constructor' : match[1],
            isStatic: !isConstructor && match[2] === 'static ',
            features: [
                ...body
                    .slice(body.lastIndexOf(';', match.index - 1) + 1, match.index)
                    .matchAll(/@unstable\s*\(\s*feature\s*=\s*([\w-]+)/g)
            ].map((feature) => feature[1]),
            parameters,
            result
        });
    }
    return functions;
}

/** Parse the named parameters from a WIT function signature. */
function parseParameters(parameters, witPath) {
    if (!parameters.trim()) return [];
    return splitTopLevel(parameters, ',').map((parameter) => {
        const colon = findTopLevel(parameter, ':');
        if (colon < 0) throw new Error(`unsupported WIT parameter ${parameter.trim()} in ${witPath}`);
        return { name: parameter.slice(0, colon).trim().replace(/^%/, ''), type: parameter.slice(colon + 1).trim() };
    });
}

/** Split text at separators that are outside nested delimiters. */
function splitTopLevel(value, separator) {
    const result = [];
    let depth = 0;
    let start = 0;
    for (let index = 0; index < value.length; index++) {
        const character = value[index];
        if ('(<[{'.includes(character)) depth++;
        else if (')>]}'.includes(character)) depth--;
        else if (character === separator && depth === 0) {
            result.push(value.slice(start, index));
            start = index + 1;
        }
    }
    result.push(value.slice(start));
    return result.map((part) => part.trim()).filter(Boolean);
}

/** Find a separator outside nested delimiters, or return -1 when absent. */
function findTopLevel(value, separator) {
    let depth = 0;
    for (let index = 0; index < value.length; index++) {
        const character = value[index];
        if ('(<[{'.includes(character)) depth++;
        else if (')>]}'.includes(character)) depth--;
        else if (character === separator && depth === 0) return index;
    }
    return -1;
}

/** Extract the body of a named WIT world or interface block. */
function namedBlock(source, keyword, name, witPath) {
    const pattern = new RegExp(`\\b${keyword}\\s+%?${escapeRegExp(name)}\\s*\\{`);
    const match = pattern.exec(source);
    if (!match) throw new Error(`${witPath} does not declare ${keyword} ${name}`);
    const open = match.index + match[0].lastIndexOf('{');
    const close = matchingBrace(source, open, witPath);
    return source.slice(open + 1, close);
}

/** Find the matching closing brace for an opening brace. */
function matchingBrace(source, open, witPath) {
    return matchingDelimiter(source, open, '{', '}', witPath);
}

/** Find the matching closing parenthesis for an opening parenthesis. */
function matchingParen(source, open, witPath) {
    return matchingDelimiter(source, open, '(', ')', witPath);
}

/** Find the matching closing delimiter for the opening delimiter at an index. */
function matchingDelimiter(source, open, left, right, witPath) {
    let depth = 0;
    for (let index = open; index < source.length; index++) {
        if (source[index] === left) depth++;
        else if (source[index] === right && --depth === 0) return index;
    }
    throw new Error(`unclosed ${left} in ${witPath}`);
}

/** Remove line and block comments from WIT source before parsing. */
function stripComments(source) {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Convert a WIT identifier to a JavaScript camelCase name. */
function jsName(witName) {
    return witName.replace(/^%/, '').replace(/-([a-zA-Z0-9])/g, (_match, character) => character.toUpperCase());
}

/** Preserve WIT case names as JavaScript variant tags; only functions and fields use camelCase. */
function jsVariantTag(witName) {
    return witName.replace(/^%/, '');
}

/** Convert a WIT identifier to a C-compatible identifier. */
function cIdentifier(witName) {
    return witName
        .replace(/^%/, '')
        .replace(/[^a-zA-Z0-9_]/g, '_')
        .replace(/_+/g, '_')
        .toLowerCase();
}

/** Convert a WIT identifier to a JavaScript class name. */
function jsClassName(witName) {
    const name = jsName(witName);
    return name.charAt(0).toUpperCase() + name.slice(1);
}

/** Escape regular expression metacharacters in a literal value. */
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
