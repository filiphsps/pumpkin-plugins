import { jsClassName, jsName, jsVariantTag, wasiHostName } from './names.ts';
import {
    type ResolvedWitType,
    resourcesIn,
    type WitApiInterface,
    type WitResource,
    type WitWasiInterface,
} from './types.ts';

type InterfaceResource = WitResource & { interfaceName: string };

/**
 * Generate the JavaScript facade for one resolved WASI interface.
 *
 * @param apiInterface - Resolved WASI interface whose imports should be exposed to the bundle.
 * @returns JavaScript module source backed by the generated WASI host adapter.
 */
export function generateWasiEsmFacade(apiInterface: WitWasiInterface): string {
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
    const errorCode = value.__staticHermesWitError;
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
            const isDrop = key === "drop";
            return (...args) => {
                if (!isDrop) __assertWasiResourceUsable(target);
                const unwrappedArgs = args.map(__unwrapWasi);
                if (!isDrop) __assertWasiResourceUsable(target);
                return __wrapWasi(Reflect.apply(member, target, unwrappedArgs));
            };
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
/**
 * Generate the JavaScript facade for one resolved Pumpkin interface.
 *
 * @param apiInterface - Resolved Pumpkin interface imported by the plugin bundle.
 * @param allInterfaces - Resolved interface closure used to include referenced resource wrappers.
 * @returns JavaScript module source backed by the generated Pumpkin host adapter.
 */
export function generateEsmFacade(
    apiInterface: WitApiInterface,
    allInterfaces: readonly WitApiInterface[] = [apiInterface],
): string {
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
const __unwrapPumpkinError = (value) => {
    if (value === null || typeof value !== "object") return value;
    const errorCode = value.__staticHermesWitError;
    if (errorCode === undefined) return value;
    const label = typeof errorCode === "string" ? errorCode : errorCode && typeof errorCode.tag === "string" ? errorCode.tag : "unknown";
    const error = new Error("Pumpkin API error: " + label);
    error.payload = errorCode;
    throw error;
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

    // Collect the resources this module can return: its own, those of the interfaces it uses, and any
    // reached through those results, keyed by declaring interface so equal names stay distinct.
    const resourceTypes = new Map<string, InterfaceResource>();
    const addResource = (interfaceName: string, resource: WitResource): void => {
        const key = `${interfaceName}.${resource.name}`;
        if (!resourceTypes.has(key)) resourceTypes.set(key, { ...resource, interfaceName });
    };
    for (const resource of apiInterface.resources) addResource(apiInterface.name, resource);
    for (const dependencyName of apiInterface.dependencies ?? []) {
        const dependency = allInterfaces.find((candidate) => candidate.name === dependencyName);
        for (const resource of dependency?.resources ?? []) addResource(dependencyName, resource);
    }
    const addReachableResources = (type: ResolvedWitType | undefined): void => {
        for (const { interfaceName, name } of resourcesIn(type)) {
            const resource = allInterfaces
                .find((candidate) => candidate.name === interfaceName)
                ?.resources.find((candidate) => candidate.name === name);
            if (resource) addResource(interfaceName, resource);
        }
    };
    for (const operation of apiInterface.functions) addReachableResources(operation.resolvedResult);
    // The loop also visits resources added while it runs.
    for (const resource of resourceTypes.values()) {
        for (const operation of resource.functions) addReachableResources(operation.resolvedResult);
    }
    const resourceNameCounts = new Map<string, number>();
    for (const { name } of resourceTypes.values()) {
        resourceNameCounts.set(name, (resourceNameCounts.get(name) ?? 0) + 1);
    }
    function resourceClassName(resource: InterfaceResource): string {
        return resource.interfaceName === apiInterface.name || resourceNameCounts.get(resource.name) === 1
            ? jsClassName(resource.name)
            : `${jsClassName(resource.interfaceName)}${jsClassName(resource.name)}`;
    }
    /** Generate a JavaScript function that wraps every resource in a converted value, if it holds any. */
    function resourceWrapper(type: ResolvedWitType): string | undefined {
        const wrap = (item: ResolvedWitType, value: string): string | undefined => {
            const wrapper = resourceWrapper(item);
            return wrapper && `(${wrapper})(${value})`;
        };
        switch (type.kind) {
            case 'resource': {
                const resource = resourceTypes.get(`${type.interfaceName}.${type.name}`);
                return resource && `(value) => __wrap(${resourceClassName(resource)}, value)`;
            }
            case 'borrow':
                return resourceWrapper(type.item);
            case 'option': {
                const item = wrap(type.item, 'value');
                return item && `(value) => (value == null ? value : ${item})`;
            }
            case 'list': {
                const item = resourceWrapper(type.item);
                return item && `(value) => value.map(${item})`;
            }
            case 'tuple': {
                const items = type.items.map((item, index) => wrap(item, `value[${index}]`));
                if (items.every((item) => item === undefined)) return undefined;
                return `(value) => [${items.map((item, index) => item ?? `value[${index}]`).join(', ')}]`;
            }
            case 'record': {
                const fields = type.fields.flatMap(({ name, resolvedType }) => {
                    const field = resolvedType && wrap(resolvedType, `value.${jsName(name)}`);
                    return field ? [`${JSON.stringify(jsName(name))}: ${field}`] : [];
                });
                return fields.length ? `(value) => ({ ...value, ${fields.join(', ')} })` : undefined;
            }
            case 'variant': {
                const cases = type.cases.flatMap(({ name, resolvedType }) => {
                    const payload = resolvedType && wrap(resolvedType, 'value.val');
                    return payload
                        ? [`value.tag === ${JSON.stringify(jsVariantTag(name))} ? { tag: value.tag, val: ${payload} }`]
                        : [];
                });
                return cases.length ? `(value) => (${cases.join(' : ')} : value)` : undefined;
            }
            case 'result': {
                const ok = wrap(type.ok, 'value.val');
                const error = wrap(type.error, 'value.val');
                if (!ok && !error) return undefined;
                return `(value) => ({ tag: value.tag, val: value.tag === "ok" ? ${ok ?? 'value.val'} : ${error ?? 'value.val'} })`;
            }
            default:
                return undefined;
        }
    }
    /** Generate an expression that wraps the resources in an operation result. */
    function wrapResourceResult(type: ResolvedWitType | undefined): string {
        // A failed top-level result throws in __unwrapPumpkinError, so a returned value is the ok payload.
        const resultType = type?.kind === 'result' ? type.ok : type;
        const wrapper = resultType && resourceWrapper(resultType);
        return wrapper ? `(${wrapper})(value)` : 'value';
    }
    const functions = apiInterface.functions
        .map((operation) => {
            const name = jsName(operation.name);
            const result = wrapResourceResult(operation.resolvedResult);
            return /* JavaScript */ `export function ${name}(...args) {
    const value = __unwrapPumpkinError(__api(${JSON.stringify(operation.name)})[${JSON.stringify(name)}](...args.map(__unwrap)));
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
                (operation) => !operation.isStatic && operation.name !== 'constructor',
            );
            const staticFunctions = localResource ? resource.functions.filter((operation) => operation.isStatic) : [];
            const constructorMethod = !localResource
                ? ''
                : constructorOperation
                  ? /* JavaScript */ `    constructor(...args) {
        const native = __unwrapPumpkinError(__resourceApi(${JSON.stringify(jsName(resource.name))})["constructor"](...args.map(__unwrap)));
        Object.defineProperty(this, "__staticHermesResource", { value: native });
        Object.defineProperty(this, "__staticHermesDisposed", { value: false, writable: true });
    }`
                  : /* JavaScript */ `    constructor() { throw new Error(${JSON.stringify(`${className} cannot be constructed directly`)}); }`;
            const staticMethods = staticFunctions.map((operation) => {
                const name = jsName(operation.name);
                const result = wrapResourceResult(operation.resolvedResult);
                return /* JavaScript */ `    static ${name}(...args) {
        const value = __unwrapPumpkinError(__resourceApi(${JSON.stringify(jsName(resource.name))})[${JSON.stringify(name)}](...args.map(__unwrap)));
        return ${result};
    }`;
            });
            const instanceMethods = instanceFunctions.map((operation) => {
                const name = jsName(operation.name);
                const result = wrapResourceResult(operation.resolvedResult);
                return /* JavaScript */ `    ${name}(...args) {
        __assertHostCallsAllowed();
        const native = __assertResourceUsable(this.__staticHermesResource, this);
        const method = native && native[${JSON.stringify(name)}];
        if (typeof method !== "function") throw new Error(${JSON.stringify(`Static Hermes host resource does not implement ${resource.name}.${operation.name}`)});
        const value = __unwrapPumpkinError(method.apply(native, args.map(__unwrap)));
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
