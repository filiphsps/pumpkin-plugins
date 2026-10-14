import type { WitApiInterface, WitResource, WitWasiInterface } from './types.ts';

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

    const resourceTypes = new Map<string, InterfaceResource>(
        apiInterface.resources.map((resource) => [resource.name, { ...resource, interfaceName: apiInterface.name }]),
    );
    for (const dependencyName of apiInterface.dependencies ?? []) {
        const dependency = allInterfaces.find((candidate) => candidate.name === dependencyName);
        if (!dependency) continue;
        for (const resource of dependency.resources) {
            if (!resourceTypes.has(resource.name)) {
                resourceTypes.set(resource.name, { ...resource, interfaceName: dependency.name });
            }
        }
    }
    function resourceClassName(resource: InterfaceResource): string {
        return resource.interfaceName === apiInterface.name
            ? jsClassName(resource.name)
            : `${jsClassName(resource.interfaceName)}${jsClassName(resource.name)}`;
    }
    /** Generate a value expression that wraps resources owned by this or a dependency interface. */
    function wrapResource(resource: InterfaceResource, value: string): string {
        return `__wrap(${resourceClassName(resource)}, ${value})`;
    }
    /** Generate a wrapper expression for resource-valued method results. */
    function wrapResourceResult(type: string | undefined): string {
        if (typeof type !== 'string') return 'value';
        const directResource = resourceTypes.get(type.trim().replace(/^%/, ''));
        if (directResource) return wrapResource(directResource, 'value');

        const optionalResource = /^option<\s*([^<>]+?)\s*>$/.exec(type);
        const listResource = /^list<\s*([^<>]+?)\s*>$/.exec(type);
        const resourceName = optionalResource?.[1] ?? listResource?.[1];
        const resource = resourceName ? resourceTypes.get(resourceName.trim().replace(/^%/, '')) : undefined;
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
                (operation) => !operation.isStatic && operation.name !== 'constructor',
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

function wasiHostName(apiInterface: WitWasiInterface): string {
    const namespace = apiInterface.packageName.slice(apiInterface.packageName.indexOf(':') + 1);
    return `__pumpkinWasi${pascalCase(namespace)}${pascalCase(apiInterface.name)}`;
}

function pascalCase(value: string): string {
    return value
        .split(/[^a-zA-Z0-9]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join('');
}

function jsName(witName: string): string {
    return witName.replace(/^%/, '').replace(/-([a-zA-Z0-9])/g, (_match, character: string) => character.toUpperCase());
}

function jsClassName(witName: string): string {
    const name = jsName(witName);
    return name.charAt(0).toUpperCase() + name.slice(1);
}
