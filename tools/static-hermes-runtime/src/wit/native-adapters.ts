import {
    cFieldIdentifier,
    cIdentifier,
    enumValue,
    jsName,
    jsVariantTag,
    pascalCase,
    witOperationCFunctionName,
} from './names.ts';
import type {
    ResolvedWitType,
    WitApiAdapterPlan,
    WitApiInterface,
    WitApiPackage,
    WitFunction,
    WitParameter,
    WitWasiAdapterPlan,
} from './types.ts';

interface GeneratedWitInput {
    argument: string;
    beforeCall?: string[];
    cleanup: string[];
    setup: string[];
}

interface GeneratedWitInputValue {
    cleanupGuards?: string[];
    expression: string;
    passByPointer?: boolean;
    setup: string[];
}

interface GeneratedWitResult {
    call: string;
    cleanup: string[];
    return: string;
    setup: string[];
}

interface GeneratedWitResultValue {
    expression: string;
    setup: string[];
}

interface WitApiFunctionOptions {
    apiObjectName?: string;
    functionName?: string;
    propertyName?: string;
}

interface WitResourceMethodOptions {
    includePackageName?: boolean;
    preserveArgumentCheckLine?: boolean;
}

/** Annotate selected adapter types with the standalone cleanup functions declared by wit-bindgen. */
export function annotateWitCleanupAvailability(
    plans: readonly WitWasiAdapterPlan[],
    availableFreeFunctions: ReadonlySet<string>,
): WitWasiAdapterPlan[] {
    return plans.map((plan) => {
        const apiPackage: WitApiPackage = {
            packageName: plan.apiInterface.packageName,
            version: plan.apiInterface.version,
            interfaces: [plan.apiInterface],
        };
        return {
            ...plan,
            parameters: plan.parameters.map((parameter) => ({
                ...parameter,
                resolvedType: annotateWitTypeCleanupAvailability(
                    apiPackage,
                    plan.apiInterface,
                    parameter.resolvedType,
                    availableFreeFunctions,
                ),
            })),
            resultType: annotateWitTypeCleanupAvailability(
                apiPackage,
                plan.apiInterface,
                plan.resultType,
                availableFreeFunctions,
            ),
        };
    });
}

function annotateWitTypeCleanupAvailability(
    apiPackage: WitApiPackage,
    apiInterface: WitApiInterface,
    type: ResolvedWitType,
    availableFreeFunctions: ReadonlySet<string>,
): ResolvedWitType {
    let annotated: ResolvedWitType;
    if (type.kind === 'borrow' || type.kind === 'list' || type.kind === 'option') {
        annotated = {
            ...type,
            item: annotateWitTypeCleanupAvailability(apiPackage, apiInterface, type.item, availableFreeFunctions),
        };
    } else if (type.kind === 'tuple') {
        annotated = {
            ...type,
            items: type.items.map((item) =>
                annotateWitTypeCleanupAvailability(apiPackage, apiInterface, item, availableFreeFunctions),
            ),
        };
    } else if (type.kind === 'result') {
        annotated = {
            ...type,
            ok: annotateWitTypeCleanupAvailability(apiPackage, apiInterface, type.ok, availableFreeFunctions),
            error: annotateWitTypeCleanupAvailability(apiPackage, apiInterface, type.error, availableFreeFunctions),
        };
    } else if (type.kind === 'record') {
        annotated = {
            ...type,
            fields: type.fields.map((field) => ({
                ...field,
                ...(field.resolvedType
                    ? {
                          resolvedType: annotateWitTypeCleanupAvailability(
                              apiPackage,
                              apiInterface,
                              field.resolvedType,
                              availableFreeFunctions,
                          ),
                      }
                    : {}),
            })),
        };
    } else if (type.kind === 'variant') {
        annotated = {
            ...type,
            cases: type.cases.map((variant) => ({
                ...variant,
                ...(variant.resolvedType
                    ? {
                          resolvedType: annotateWitTypeCleanupAvailability(
                              apiPackage,
                              apiInterface,
                              variant.resolvedType,
                              availableFreeFunctions,
                          ),
                      }
                    : {}),
            })),
        };
    } else {
        annotated = type;
    }

    const freeFunction = witFreeFunctionCandidate(apiPackage, apiInterface, annotated);
    if (!freeFunction || !['borrow', 'list', 'option', 'record', 'result', 'tuple', 'variant'].includes(annotated.kind))
        return annotated;
    return { ...annotated, hasGeneratedFreeFunction: availableFreeFunctions.has(freeFunction) } as ResolvedWitType;
}

/** Emit the host-function branch for one resolved WASI resource method plan. */
export function generateWitResourceMethodForResolvedPlan(
    apiPackage: WitApiPackage,
    plan: WitApiAdapterPlan | WitWasiAdapterPlan,
    { includePackageName = true, preserveArgumentCheckLine = false }: WitResourceMethodOptions = {},
): string | undefined {
    const { apiInterface, operation, parameters, resultType, resource } = plan;
    if (!resource || plan.kind !== 'resource-method') {
        throw new Error(`WASI resource method plan is incomplete: ${plan.operationId}`);
    }
    const namespace = cIdentifier(apiPackage.packageName);
    const functionName = witOperationCFunctionName(apiPackage, apiInterface, operation, resource);
    const borrowType = `${namespace}_${cIdentifier(apiInterface.name)}_borrow_${cIdentifier(resource.name)}_t`;
    const inputs = [];
    const beforeCall = [];
    const callArguments = [`${borrowType}{state->handle}`];
    for (const [index, parameter] of parameters.entries()) {
        const input = generateWitInput(apiPackage, apiInterface, parameter, index);
        if (!input) return undefined;
        inputs.push(...input.setup);
        beforeCall.push(...(input.beforeCall ?? []));
        callArguments.push(input.argument);
    }
    const result = generateWitResult(apiPackage, apiInterface, resultType, functionName, callArguments);
    if (!result) return undefined;

    const methodName = jsName(operation.name);
    const argumentCheck = parameters.length
        ? `if (count < ${parameters.length}) throw JSError(rt, ${JSON.stringify(`${resource.name}.${methodName} expects ${parameters.length} argument${parameters.length === 1 ? '' : 's'}`)});`
        : '';
    const body = [...inputs, ...result.setup, ...beforeCall, result.call, ...result.cleanup, result.return].filter(
        Boolean,
    );
    const packageCheck = includePackageName ? `packageName == ${JSON.stringify(apiPackage.packageName)} && ` : '';
    const bodySource = preserveArgumentCheckLine
        ? `      ${argumentCheck}\n      ${body.join('\n      ')}`
        : `      ${[argumentCheck, ...body].filter(Boolean).join('\n      ')}`;
    return `  if (${packageCheck}interfaceName == ${JSON.stringify(apiInterface.name)} && resourceName == ${JSON.stringify(resource.name)} && methodName == ${JSON.stringify(methodName)}) {
    return hostFunction(runtime, ${JSON.stringify(methodName)}, ${parameters.length}, [state = std::move(state)](Runtime &rt, const Value &, const Value *args, std::size_t count) -> Value {
${bodySource}
    });
  }`;
}

/** Generate a WIT free-function adapter inside its interface API object. */
function generateWitApiFunction(
    apiPackage: WitApiPackage,
    apiInterface: WitApiInterface,
    operation: WitFunction,
    parameters: Array<WitParameter & { resolvedType: ResolvedWitType }>,
    resultType: ResolvedWitType,
    {
        functionName,
        apiObjectName = `generated${pascalCase(apiInterface.name)}Api`,
        propertyName = jsName(operation.name),
    }: WitApiFunctionOptions = {},
): string | undefined {
    const nativeFunctionName = functionName ?? witOperationCFunctionName(apiPackage, apiInterface, operation);
    const inputs = [];
    const beforeCall = [];
    const callArguments = [];
    for (const [index, parameter] of parameters.entries()) {
        const input = generateWitInput(apiPackage, apiInterface, parameter, index);
        if (!input) return undefined;
        inputs.push(...input.setup);
        beforeCall.push(...(input.beforeCall ?? []));
        callArguments.push(input.argument);
    }

    const result = generateWitResult(apiPackage, apiInterface, resultType, nativeFunctionName, callArguments);
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
        ...result.cleanup,
        result.return,
    ].filter(Boolean);
    return `    ${apiObjectName}.setProperty(
        runtime, ${JSON.stringify(propertyName)},
        hostFunction(runtime, ${JSON.stringify(propertyName)}, ${parameters.length},
            [](Runtime &rt, const Value &, const Value *args, std::size_t count) -> Value {
                ${body.join('\n                ')}
            }));`;
}

/** Emit one freestanding, constructor, or static operation from a resolved adapter plan. */
export function generateWitApiFunctionForResolvedOperation({
    apiPackage,
    apiInterface,
    operation,
    parameters,
    resultType,
    options,
}: {
    apiPackage: WitApiPackage;
    apiInterface: WitApiInterface;
    operation: WitFunction;
    parameters: Array<WitParameter & { resolvedType: ResolvedWitType }>;
    resultType: ResolvedWitType;
    options?: WitApiFunctionOptions;
}): string | undefined {
    return generateWitApiFunction(apiPackage, apiInterface, operation, parameters, resultType, options);
}

/** Generate native argument setup, call input, and cleanup for one WIT parameter. */
function generateWitInput(
    apiPackage: WitApiPackage,
    apiInterface: WitApiInterface,
    parameter: WitParameter & { resolvedType: ResolvedWitType },
    index: number,
): GeneratedWitInput | undefined {
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
            false,
        );
        if (!item) return undefined;
        const itemType = witCType(apiPackage, apiInterface, type.item);
        const setup = [
            `${itemType} ${name}Storage{};`,
            ...witCleanupGuard(apiPackage, apiInterface, type.item, `${name}Storage`, `${name}StorageCleanup`),
            `${itemType} *${name} = nullptr;`,
            `if (!args[${index}].isNull() && !args[${index}].isUndefined()) {`,
            ...item.setup.map((line) => `  ${line}`),
            `  ${name}Storage = ${item.expression};`,
            ...releaseInputGuards(item).map((line) => `  ${line}`),
            `  ${name} = &${name}Storage;`,
            '}',
        ];
        return {
            setup: [...(ownership ? [`std::vector<std::shared_ptr<ResourceState>> ${ownership};`] : []), ...setup],
            beforeCall: ownership ? [`for (const auto &resource : ${ownership}) resource->transfer();`] : [],
            argument: name,
            cleanup: [],
        };
    }
    const value = generateWitInputValue(apiPackage, apiInterface, type, `args[${index}]`, name, ownership, false);
    if (!value) return undefined;

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
        cleanup: [],
    };
}

/** Recursively convert a JavaScript value into a WIT C API value. */
function generateWitInputValue(
    apiPackage: WitApiPackage,
    apiInterface: WitApiInterface,
    type: ResolvedWitType,
    input: string,
    name: string,
    ownership: string | undefined,
    copyByteLists: boolean,
): GeneratedWitInputValue | undefined {
    if (type.kind === 'unsupported') return undefined;
    if (type.kind === 'unit') return { setup: [], expression: 'Value::undefined()' };
    if (type.kind === 'primitive') {
        if (type.name === 'string') {
            return {
                setup: [
                    `plugin_string_t ${name} = wasiInputString(rt, ${input});`,
                    ...witCleanupGuard(apiPackage, apiInterface, type, name, `${name}Cleanup`),
                ],
                expression: name,
                passByPointer: true,
                cleanupGuards: [`${name}Cleanup`],
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
                `if (${enumName} == ${JSON.stringify(value)}) ${name} = static_cast<${cType}>(${enumValue(apiPackage, type, value)});`,
            );
        }
        setup.push(
            `if (${type.values.map((value) => `${enumName} != ${JSON.stringify(value)}`).join(' && ')}) throw JSError(rt, ${JSON.stringify(`Unknown ${type.name} value`)});`,
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
                `if (!${value}.isUndefined() && !${value}.isNull() && ${value}.getBool()) ${name} |= static_cast<${cType}>(${enumValue(apiPackage, type, flag)});`,
            );
        }
        return { setup, expression: name };
    }
    if (type.kind === 'resource' || (type.kind === 'borrow' && type.item.kind === 'resource')) {
        const resource = type.kind === 'borrow' ? type.item : type;
        if (resource.kind !== 'resource') return undefined;
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
                      ...(ownership ? [`${ownership}.push_back(${state});`] : []),
                  ]
                : []),
            `${witCType(apiPackage, apiInterface, type)} ${name}{${state}->handle};`,
        ];
        return { setup, expression: name };
    }
    if (type.kind === 'record') {
        const object = `${name}Object`;
        const cleanupGuard = witCleanupGuard(apiPackage, apiInterface, type, name, `${name}Cleanup`);
        const setup = [
            `const auto ${object} = ${input}.asObject(rt);`,
            `${witCType(apiPackage, apiInterface, type)} ${name}{};`,
            ...cleanupGuard,
        ];
        for (const field of type.fields) {
            const fieldType = requireResolvedFieldType(field);
            const fieldName = `${name}${pascalCase(field.name)}`;
            const value = generateWitInputValue(
                apiPackage,
                apiInterface,
                fieldType,
                `${object}.getProperty(rt, ${JSON.stringify(jsName(field.name))})`,
                fieldName,
                ownership,
                true,
            );
            if (!value) return undefined;
            setup.push(
                ...value.setup,
                `${name}.${cFieldIdentifier(field.name)} = ${value.expression};`,
                ...releaseInputGuards(value),
            );
        }
        return {
            setup,
            expression: name,
            passByPointer: true,
            cleanupGuards: cleanupGuard.length ? [`${name}Cleanup`] : [],
        };
    }
    if (type.kind === 'tuple') {
        const array = `${name}Array`;
        const cleanupGuard = witCleanupGuard(apiPackage, apiInterface, type, name, `${name}Cleanup`);
        const setup = [
            `const auto ${array} = ${input}.asObject(rt).asArray(rt);`,
            `${witCType(apiPackage, apiInterface, type)} ${name}{};`,
            ...cleanupGuard,
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
                true,
            );
            if (!item) return undefined;
            setup.push(...item.setup, `${name}.f${index} = ${item.expression};`, ...releaseInputGuards(item));
        }
        return {
            setup,
            expression: name,
            passByPointer: true,
            cleanupGuards: cleanupGuard.length ? [`${name}Cleanup`] : [],
        };
    }
    if (type.kind === 'variant') {
        const object = `${name}Object`;
        const tag = `${name}Tag`;
        const cleanupGuard = witCleanupGuard(apiPackage, apiInterface, type, name, `${name}Cleanup`);
        const setup = [
            `const auto ${object} = ${input}.asObject(rt);`,
            `const auto ${tag} = utf8(rt, ${object}.getProperty(rt, "tag"));`,
            `${witCType(apiPackage, apiInterface, type)} ${name}{};`,
            ...cleanupGuard,
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
                    true,
                );
                if (!payload) return undefined;
                branch.push(
                    ...payload.setup,
                    `${name}.val.${cFieldIdentifier(variant.name)} = ${payload.expression};`,
                    ...releaseInputGuards(payload),
                );
            }
            alternatives.push(`if (${tag} == ${tagValue}) { ${branch.join(' ')} }`);
        }
        setup.push(
            `${alternatives.join(' else ')} else { throw JSError(rt, ${JSON.stringify(`Unknown ${type.name} variant`)}); }`,
        );
        return {
            setup,
            expression: name,
            passByPointer: true,
            cleanupGuards: cleanupGuard.length ? [`${name}Cleanup`] : [],
        };
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
            true,
        );
        if (!value) return undefined;
        const cType = witCType(apiPackage, apiInterface, type);
        const cleanupGuard = witCleanupGuard(apiPackage, apiInterface, type, name, `${name}Cleanup`);
        return {
            setup: [
                `${cType} ${name}{};`,
                ...cleanupGuard,
                `if (!${input}.isNull() && !${input}.isUndefined()) {`,
                ...value.setup.map((line) => `  ${line}`),
                `  ${name}.is_some = true;`,
                `  ${name}.val = ${value.expression};`,
                ...releaseInputGuards(value).map((line) => `  ${line}`),
                '}',
            ],
            expression: name,
            passByPointer: true,
            cleanupGuards: cleanupGuard.length ? [`${name}Cleanup`] : [],
        };
    }
    if (type.kind === 'result') {
        const object = `${name}Object`;
        const tag = `${name}Tag`;
        const cType = witCType(apiPackage, apiInterface, type);
        const setup = [
            `const auto ${object} = ${input}.asObject(rt);`,
            `const auto ${tag} = utf8(rt, ${object}.getProperty(rt, "tag"));`,
            `${cType} ${name}{};`,
            ...witCleanupGuard(apiPackage, apiInterface, type, name, `${name}Cleanup`),
        ];
        const resultBranches: Array<{ tagName: 'ok' | 'err'; itemType: ResolvedWitType; branch: 'ok' | 'err' }> = [
            ['ok', type.ok, 'ok'],
            ['err', type.error, 'err'],
        ].map(([tagName, itemType, branch]) => ({
            tagName: tagName as 'ok' | 'err',
            itemType: itemType as ResolvedWitType,
            branch: branch as 'ok' | 'err',
        }));
        for (const { tagName, itemType, branch } of resultBranches) {
            const value = generateWitInputValue(
                apiPackage,
                apiInterface,
                itemType,
                `${object}.getProperty(rt, "val")`,
                `${name}${pascalCase(tagName)}`,
                ownership,
                true,
            );
            if (!value) return undefined;
            setup.push(
                `${branch === 'ok' ? 'if' : 'else if'} (${tag} == ${JSON.stringify(tagName)}) {`,
                ...value.setup.map((line) => `  ${line}`),
                `  ${name}.is_err = ${branch === 'err' ? 'true' : 'false'};`,
                ...(itemType.kind === 'unit' ? [] : [`  ${name}.val.${branch} = ${value.expression};`]),
                ...releaseInputGuards(value).map((line) => `  ${line}`),
                '}',
            );
        }
        setup.push(`else { throw JSError(rt, ${JSON.stringify('WIT result tag must be "ok" or "err"')}); }`);
        const cleanupGuard = witCleanupGuard(apiPackage, apiInterface, type, name, `${name}Cleanup`);
        return {
            setup,
            expression: name,
            passByPointer: true,
            cleanupGuards: cleanupGuard.length ? [`${name}Cleanup`] : [],
        };
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
                        `${cType} ${name}{${buffer}.data(rt) + ${typed}.byteOffset(rt), ${typed}.byteLength(rt)};`,
                    ],
                    expression: name,
                    passByPointer: true,
                };
            }
            const data = `${name}Data`;
            const size = `${name}Size`;
            const cleanupGuard = witCleanupGuard(apiPackage, apiInterface, type, name, `${name}Cleanup`);
            return {
                setup: [
                    `auto ${typed} = ${input}.asObject(rt).asUint8Array(rt);`,
                    `auto ${buffer} = ${typed}.buffer(rt);`,
                    `const std::size_t ${size} = ${typed}.byteLength(rt);`,
                    `auto *${data} = static_cast<uint8_t *>(${size} ? std::malloc(${size}) : nullptr);`,
                    `if (${size} && !${data}) throw JSError(rt, "WIT byte-list allocation failed");`,
                    `if (${size}) std::memcpy(${data}, ${buffer}.data(rt) + ${typed}.byteOffset(rt), ${size});`,
                    `${cType} ${name}{${data}, ${size}};`,
                    ...cleanupGuard,
                ],
                expression: name,
                passByPointer: true,
                cleanupGuards: cleanupGuard.length ? [`${name}Cleanup`] : [],
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
            true,
        );
        if (!item) return undefined;
        const cleanupGuard = witCleanupGuard(apiPackage, apiInterface, type, name, `${name}Cleanup`);
        return {
            setup: [
                `const auto ${array} = ${input}.asObject(rt);`,
                `if (!${array}.isArray(rt) && !${array}.isTypedArray(rt)) throw JSError(rt, "Expected a WIT list as an array or typed array");`,
                `const std::size_t ${size} = static_cast<std::size_t>(${array}.getProperty(rt, "length").asNumber());`,
                `auto *${data} = static_cast<${itemType} *>(${size} ? std::calloc(${size}, sizeof(${itemType})) : nullptr);`,
                `if (${size} && !${data}) throw JSError(rt, "WIT list allocation failed");`,
                `${cType} ${name}{${data}, ${size}};`,
                ...cleanupGuard,
                `for (std::size_t ${index} = 0; ${index} < ${size}; ++${index}) {`,
                ...item.setup.map((line) => `  ${line}`),
                `  ${data}[${index}] = ${item.expression};`,
                ...releaseInputGuards(item).map((line) => `  ${line}`),
                '}',
            ],
            expression: name,
            passByPointer: true,
            cleanupGuards: cleanupGuard.length ? [`${name}Cleanup`] : [],
        };
    }
    return undefined;
}

/** Generate native call and result-conversion code for a resolved WIT result type. */
function generateWitResult(
    apiPackage: WitApiPackage,
    apiInterface: WitApiInterface,
    type: ResolvedWitType,
    functionName: string,
    argumentsList: string[],
): GeneratedWitResult | undefined {
    if (type.kind === 'unsupported') return undefined;
    const callArguments = [...argumentsList];
    const call = `${functionName}(${callArguments.join(', ')})`;
    if (type.kind === 'result') {
        const output = type.ok;
        const error = type.error;
        const value =
            output.kind === 'resource'
                ? undefined
                : generateWitResultValue(apiPackage, apiInterface, output, 'result', 'resultValue');
        if (output.kind !== 'resource' && !value) return undefined;
        if (error.kind !== 'unit' && !isSupportedWitError(error)) return undefined;
        const setup = [
            ...(output.kind === 'unit' ? [] : [`${witCType(apiPackage, apiInterface, output)} result{};`]),
            ...(output.kind === 'unit'
                ? []
                : witCleanupGuard(apiPackage, apiInterface, output, 'result', 'resultCleanup')),
            ...(error.kind === 'unit'
                ? []
                : [
                      `${witCType(apiPackage, apiInterface, error)} error{};`,
                      ...witCleanupGuard(apiPackage, apiInterface, error, 'error', 'errorCleanup'),
                  ]),
        ];
        const outputArguments = output.kind === 'unit' ? callArguments : [...callArguments, '&result'];
        if (error.kind !== 'unit') outputArguments.push('&error');
        const callExpression = `const bool callSucceeded = ${functionName}(${outputArguments.join(', ')});`;
        const errorReturn =
            error.kind === 'unit'
                ? `Object errorValue(rt); errorValue.setProperty(rt, "__staticHermesWitError", Value::null()); return errorValue;`
                : generateWitErrorReturn(apiPackage, apiInterface, error, 'error');
        const successReturn =
            output.kind === 'resource'
                ? generateWitResourceValue(apiPackage, output, 'result')
                : `${value?.setup.join(' ')} auto converted = ${value?.expression}; return converted;`;
        return {
            setup,
            call: callExpression,
            cleanup: [],
            return: `if (!callSucceeded) { ${errorReturn} } ${successReturn}`,
        };
    }
    if (type.kind === 'unit') return { setup: [], call: `${call};`, cleanup: [], return: 'return Value::undefined();' };
    if (type.kind === 'primitive' && type.name === 'string') {
        return {
            setup: [
                'plugin_string_t result{};',
                ...witCleanupGuard(apiPackage, apiInterface, type, 'result', 'resultCleanup'),
            ],
            call: `${functionName}(${[...callArguments, '&result'].join(', ')});`,
            cleanup: [],
            return: 'const auto text = wasiStringValue(result); return jsString(rt, text);',
        };
    }
    if (type.kind === 'primitive')
        return {
            setup: [],
            call: `const auto result = ${call};`,
            cleanup: [],
            return: `return ${primitiveOutput(type, 'result', 'rt')};`,
        };
    if (type.kind === 'enum') return generateWitEnumResult(apiPackage, type, call);
    if (type.kind === 'flags') {
        const value = generateWitResultValue(apiPackage, apiInterface, type, 'result', 'resultValue');
        if (!value) return undefined;
        return {
            setup: [],
            call: `const auto result = ${call};`,
            cleanup: [],
            return: `${value.setup.join(' ')} return ${value.expression};`,
        };
    }
    if (type.kind === 'record' || type.kind === 'tuple' || type.kind === 'variant' || type.kind === 'list') {
        const value = generateWitResultValue(apiPackage, apiInterface, type, 'result', 'resultValue');
        if (!value) return undefined;
        const setup = [`${witCType(apiPackage, apiInterface, type)} result{};`];
        setup.push(...witCleanupGuard(apiPackage, apiInterface, type, 'result', 'resultCleanup'));
        return {
            setup,
            call: `${functionName}(${[...callArguments, '&result'].join(', ')});`,
            cleanup: [],
            return: `${value.setup.join(' ')} auto converted = ${value.expression}; return converted;`,
        };
    }
    if (type.kind === 'resource') return generateWitResourceResult(apiPackage, type, functionName, callArguments);
    if (type.kind === 'option') {
        const value = generateWitResultValue(apiPackage, apiInterface, type.item, 'result', 'resultValue');
        if (!value) return undefined;
        const setup = [
            `${witCType(apiPackage, apiInterface, type.item)} result{};`,
            ...witCleanupGuard(apiPackage, apiInterface, type.item, 'result', 'resultCleanup'),
        ];
        return {
            setup,
            call: `const bool hasResult = ${functionName}(${[...callArguments, '&result'].join(', ')});`,
            cleanup: [],
            return: `if (!hasResult) return Value::null(); ${value.setup.join(' ')} auto converted = ${value.expression}; return converted;`,
        };
    }
    return undefined;
}

/** Convert a failed WIT result payload into the error marker consumed by its facade. */
function generateWitErrorReturn(
    apiPackage: WitApiPackage,
    apiInterface: WitApiInterface,
    type: ResolvedWitType,
    expression: string,
): string {
    if (type.kind === 'enum') return generateWitEnumErrorReturn(apiPackage, type, expression);
    const value = generateWitResultValue(apiPackage, apiInterface, type, expression, 'wasiError');
    if (!value) return `throw JSError(rt, ${JSON.stringify(`WIT call ${resolvedTypeName(type)} failed`)});`;
    return `${value.setup.join(' ')} auto errorPayload = ${value.expression}; Object errorValue(rt); errorValue.setProperty(rt, "__staticHermesWitError", std::move(errorPayload)); return errorValue;`;
}

function generateWitEnumErrorReturn(
    apiPackage: WitApiPackage,
    type: Extract<ResolvedWitType, { kind: 'enum' | 'flags' }>,
    expression: string,
): string {
    const cases = type.values.map(
        (value) =>
            `case ${enumValue(apiPackage, type, value)}: { Object errorValue(rt); errorValue.setProperty(rt, "__staticHermesWitError", jsString(rt, ${JSON.stringify(value)})); return errorValue; }`,
    );
    return `switch (${expression}) { ${cases.join(' ')} default: throw JSError(rt, ${JSON.stringify(`Unknown ${type.name} value`)}); }`;
}

function isSupportedWitError(type: ResolvedWitType): boolean {
    if (
        type.kind === 'unit' ||
        type.kind === 'primitive' ||
        type.kind === 'enum' ||
        type.kind === 'flags' ||
        type.kind === 'resource'
    ) {
        return true;
    }
    if (type.kind === 'record') {
        return type.fields.every((field) => field.resolvedType && isSupportedWitError(field.resolvedType));
    }
    if (type.kind === 'variant') {
        return type.cases.every((variant) => !variant.resolvedType || isSupportedWitError(variant.resolvedType));
    }
    if (type.kind === 'list' || type.kind === 'option') return isSupportedWitError(type.item);
    if (type.kind === 'tuple') return type.items.every(isSupportedWitError);
    if (type.kind === 'result') return isSupportedWitError(type.ok) && isSupportedWitError(type.error);
    return false;
}

/** Convert a supported result payload to a JavaScript value before freeing its WIT storage. */
function generateWitResultValue(
    apiPackage: WitApiPackage,
    apiInterface: WitApiInterface,
    type: ResolvedWitType,
    expression: string,
    name: string,
): GeneratedWitResultValue | undefined {
    if (type.kind === 'unsupported') return undefined;
    if (type.kind === 'unit') return { setup: [], expression: 'Value::undefined()' };
    if (type.kind === 'enum') {
        const cases = type.values.map(
            (value) =>
                `case ${enumValue(apiPackage, type, value)}: ${name} = jsString(rt, ${JSON.stringify(value)}); break;`,
        );
        return {
            setup: [
                `String ${name} = jsString(rt, ${JSON.stringify(type.values[0])});`,
                `switch (${expression}) { ${cases.join(' ')} default: throw JSError(rt, ${JSON.stringify(`Unknown ${type.name} value`)}); }`,
            ],
            expression: `std::move(${name})`,
        };
    }
    if (type.kind === 'flags') {
        const setup = [`Object ${name}(rt);`];
        for (const flag of type.values) {
            setup.push(
                `${name}.setProperty(rt, ${JSON.stringify(jsName(flag))}, Value((${expression} & ${enumValue(apiPackage, type, flag)}) != 0));`,
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
                `if (${expression}.len) { auto ${name}Buffer = ${name}.buffer(rt); std::memcpy(${name}Buffer.data(rt), ${expression}.ptr, ${expression}.len); }`,
            ],
            expression: `std::move(${name})`,
        };
    }
    if (type.kind === 'list') {
        const item = generateWitResultValue(
            apiPackage,
            apiInterface,
            type.item,
            `${expression}.ptr[index]`,
            `${name}Item`,
        );
        if (!item) return undefined;
        const typedArray = typedArrayConstructor(type.item);
        if (typedArray) {
            return {
                setup: [
                    `Value ${name}Value = rt.global().getPropertyAsFunction(rt, ${JSON.stringify(typedArray)}).callAsConstructor(rt, Value(static_cast<double>(${expression}.len)));`,
                    `Object ${name} = ${name}Value.asObject(rt);`,
                    `for (std::size_t index = 0; index < ${expression}.len; ++index) { ${item.setup.join(' ')} ${name}.setProperty(rt, std::to_string(index).c_str(), ${item.expression}); }`,
                ],
                expression: `std::move(${name})`,
            };
        }
        return {
            setup: [
                `Array ${name}(rt, ${expression}.len);`,
                `for (std::size_t index = 0; index < ${expression}.len; ++index) { ${item.setup.join(' ')} ${name}.setValueAtIndex(rt, index, ${item.expression}); }`,
            ],
            expression: `std::move(${name})`,
        };
    }
    if (type.kind === 'option') {
        const item = generateWitResultValue(apiPackage, apiInterface, type.item, `${expression}.val`, `${name}Item`);
        if (!item) return undefined;
        return {
            setup: [
                `Value ${name} = Value::null();`,
                `if (${expression}.is_some) { ${item.setup.join(' ')} ${name} = Value(${item.expression}); }`,
            ],
            expression: `std::move(${name})`,
        };
    }
    if (type.kind === 'record') {
        const setup = [`Object ${name}(rt);`];
        for (const field of type.fields) {
            const fieldType = requireResolvedFieldType(field);
            const fieldName = `${name}${pascalCase(field.name)}`;
            const value = generateWitResultValue(
                apiPackage,
                apiInterface,
                fieldType,
                `${expression}.${cFieldIdentifier(field.name)}`,
                fieldName,
            );
            if (!value) return undefined;
            setup.push(
                ...value.setup,
                `${name}.setProperty(rt, ${JSON.stringify(jsName(field.name))}, ${value.expression});`,
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
                `${name}Item${index}`,
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
                    `case ${tag}: ${name}.setProperty(rt, "tag", ${JSON.stringify(jsVariantTag(variant.name))}); break;`,
                );
                continue;
            }
            const variantType = requireResolvedFieldType(variant);
            const payloadName = `${name}${pascalCase(variant.name)}`;
            const value = generateWitResultValue(
                apiPackage,
                apiInterface,
                variantType,
                `${expression}.val.${cFieldIdentifier(variant.name)}`,
                payloadName,
            );
            if (!value) return undefined;
            setup.push(
                `case ${tag}: { ${name}.setProperty(rt, "tag", ${JSON.stringify(jsVariantTag(variant.name))}); ${value.setup.join(' ')} ${name}.setProperty(rt, "val", ${value.expression}); break; }`,
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
            `${name}Error`,
        );
        if (!ok || !error) return undefined;
        const okValue = [...ok.setup, `${name}.setProperty(rt, "val", ${ok.expression});`].join(' ');
        const errorValue =
            type.error.kind === 'unit'
                ? ''
                : [...error.setup, `${name}.setProperty(rt, "val", ${error.expression});`].join(' ');
        return {
            setup: [
                `Object ${name}(rt); if (${expression}.is_err) { ${name}.setProperty(rt, "tag", "err"); ${errorValue} } else { ${name}.setProperty(rt, "tag", "ok"); ${okValue} }`,
            ],
            expression: `std::move(${name})`,
        };
    }
    return undefined;
}

/** Generate a JavaScript host object for an owned resource nested in a WIT value. */
function generateWitResourceObject(
    apiPackage: WitApiPackage,
    type: Extract<ResolvedWitType, { kind: 'resource' }>,
    expression: string,
    name: string,
): GeneratedWitResultValue {
    const ownerPackage = apiPackage.packageName.startsWith('wasi:') ? (type.packageName ?? apiPackage.packageName) : '';
    const stateName = `${name}State`;
    return {
        setup: [
            `auto ${stateName} = std::make_shared<ResourceState>(ResourceState{${expression}.__handle, true, ${JSON.stringify(type.interfaceName)}, ${JSON.stringify(type.name)}, ${JSON.stringify(ownerPackage)}});`,
        ],
        expression: `wrapResourceObject(rt, makeWitResourceObject(${stateName}))`,
    };
}

/** Return the WIT-owned C value destructor for a generated result payload. */
function witFreeFunction(
    apiPackage: WitApiPackage,
    apiInterface: WitApiInterface,
    type: ResolvedWitType,
): string | undefined {
    if ('hasGeneratedFreeFunction' in type && type.hasGeneratedFreeFunction === false) return undefined;
    return witFreeFunctionCandidate(apiPackage, apiInterface, type);
}

function witFreeFunctionCandidate(
    apiPackage: WitApiPackage,
    apiInterface: WitApiInterface,
    type: ResolvedWitType,
): string | undefined {
    if (type.kind === 'enum' || type.kind === 'flags') return undefined;
    if (type.kind === 'resource' || type.kind === 'borrow') return undefined;
    if (
        type.kind === 'record' &&
        !type.fields.some((field) => field.resolvedType && witTypeNeedsFree(field.resolvedType))
    )
        return undefined;
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
    if (
        !('aliasName' in type && type.aliasName) &&
        !['list', 'option', 'result', 'record', 'tuple', 'variant'].includes(type.kind)
    )
        return undefined;
    const owner = witTypeOwner(type, apiPackage, apiInterface);
    const namespace = cIdentifier(owner.packageName);
    const interfaceName = cIdentifier(owner.interfaceName ?? owner.declaredInterface ?? apiInterface.name);
    return `${namespace}_${interfaceName}_${witTypeName(type)}_free`;
}

/** Generate cleanup statements for WIT-owned values, including values nested in tuples. */
function witFreeCode(
    apiPackage: WitApiPackage,
    apiInterface: WitApiInterface,
    type: ResolvedWitType,
    expression: string,
): string {
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
                    requireResolvedFieldType(field),
                    `${expression}.${cFieldIdentifier(field.name)}`,
                ),
            )
            .filter(Boolean)
            .join(' ');
    }
    if (type.kind === 'variant') {
        const cases = type.cases.map((variant) => {
            const cleanup = variant.resolvedType
                ? witFreeCode(
                      apiPackage,
                      apiInterface,
                      requireResolvedFieldType(variant),
                      `${expression}.val.${cFieldIdentifier(variant.name)}`,
                  )
                : '';
            return `case ${enumValue(apiPackage, type, variant.name)}: ${cleanup} break;`;
        });
        return `switch (${expression}.tag) { ${cases.join(' ')} default: break; }`;
    }
    return '';
}

/** Emit a local C++ scope guard for one generated WIT value with owned storage. */
function witCleanupGuard(
    apiPackage: WitApiPackage,
    apiInterface: WitApiInterface,
    type: ResolvedWitType,
    expression: string,
    guardName: string,
): string[] {
    const cleanup = witFreeCode(apiPackage, apiInterface, type, expression);
    return cleanup ? [`WitScopeGuard ${guardName}([&] { ${cleanup} });`] : [];
}

/** Release child guards after their owned values have moved into a guarded WIT aggregate. */
function releaseInputGuards(value: GeneratedWitInputValue): string[] {
    return (value.cleanupGuards ?? []).map((guardName) => `${guardName}.release();`);
}

/** Check whether freeing a WIT value may release owned memory. */
function witTypeNeedsFree(type: ResolvedWitType): boolean {
    if (type.kind === 'primitive') return type.name === 'string';
    if (['list', 'option', 'result', 'variant'].includes(type.kind)) return true;
    if (type.kind === 'record')
        return type.fields.some((field) => field.resolvedType && witTypeNeedsFree(field.resolvedType));
    if (type.kind === 'tuple') return type.items.some(witTypeNeedsFree);
    return false;
}

/** Generate native-to-JavaScript conversion code for a WIT enum result. */
function generateWitEnumResult(
    apiPackage: WitApiPackage,
    type: Extract<ResolvedWitType, { kind: 'enum' | 'flags' }>,
    call: string,
): GeneratedWitResult {
    const cases = type.values.map(
        (value) => `case ${enumValue(apiPackage, type, value)}: return jsString(rt, ${JSON.stringify(value)});`,
    );
    return {
        setup: [],
        call: `const auto result = ${call};`,
        cleanup: [],
        return: `switch (result) { ${cases.join(' ')} default: throw JSError(rt, ${JSON.stringify(`Unknown ${type.name} value`)}); }`,
    };
}

/** Generate the call and conversion for an operation that returns an owned resource. */
function generateWitResourceResult(
    apiPackage: WitApiPackage,
    type: Extract<ResolvedWitType, { kind: 'resource' }>,
    functionName: string,
    argumentsList: string[],
): GeneratedWitResult {
    const ownerPackage = apiPackage.packageName.startsWith('wasi:') ? (type.packageName ?? apiPackage.packageName) : '';
    return {
        setup: [],
        call: `const auto result = ${functionName}(${argumentsList.join(', ')});`,
        cleanup: [],
        return: `auto resource = std::make_shared<ResourceState>(ResourceState{result.__handle, true, ${JSON.stringify(type.interfaceName)}, ${JSON.stringify(type.name)}, ${JSON.stringify(ownerPackage)}}); return wrapResourceObject(rt, makeWitResourceObject(resource));`,
    };
}

/** Create a JavaScript host object for an owned WIT resource handle. */
function generateWitResourceValue(
    apiPackage: WitApiPackage,
    type: Extract<ResolvedWitType, { kind: 'resource' }>,
    expression: string,
): string {
    const ownerPackage = apiPackage.packageName.startsWith('wasi:') ? (type.packageName ?? apiPackage.packageName) : '';
    return `auto resourceState = std::make_shared<ResourceState>(ResourceState{${expression}.__handle, true, ${JSON.stringify(type.interfaceName)}, ${JSON.stringify(type.name)}, ${JSON.stringify(ownerPackage)}}); return wrapResourceObject(rt, makeWitResourceObject(resourceState));`;
}

/** Return the generated C type corresponding to a resolved WIT type. */
function witCType(apiPackage: WitApiPackage, apiInterface: WitApiInterface, type: ResolvedWitType): string {
    if (type.kind === 'unsupported') throw new Error(`Unsupported WIT type in C adapter: ${type.source}`);
    if (type.kind === 'primitive') {
        const primitiveTypes: Record<string, string> = {
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
            string: 'plugin_string_t',
        };
        return primitiveTypes[type.name];
    }
    if (type.kind === 'resource') {
        const packageName = type.packageName ?? apiPackage.packageName;
        const interfaceName = type.interfaceName ?? apiInterface.name;
        const resourceName =
            type.interfaceSpecifier === apiInterface.specifier ? (type.aliasName ?? type.name) : type.name;
        return `${cIdentifier(packageName)}_${cIdentifier(interfaceName)}_own_${cIdentifier(resourceName)}_t`;
    }
    if (type.kind === 'borrow' && type.item.kind === 'resource') {
        const packageName = type.item.packageName ?? apiPackage.packageName;
        const interfaceName = type.item.interfaceName ?? apiInterface.name;
        const resourceName =
            type.item.interfaceSpecifier === apiInterface.specifier
                ? (type.item.aliasName ?? type.item.name)
                : type.item.name;
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
    const metadata = witTypeOwner(type, apiPackage, apiInterface);
    const name =
        metadata.interfaceSpecifier === apiInterface.specifier
            ? (metadata.aliasName ?? metadata.name ?? witTypeName(type))
            : (metadata.name ?? witTypeName(type));
    const packageName = metadata.packageName;
    const interfaceName = metadata.interfaceName ?? metadata.declaredInterface ?? apiInterface.name;
    return `${cIdentifier(packageName)}_${cIdentifier(interfaceName)}_${cIdentifier(name)}_t`;
}

/** Return the generated namespace for anonymous WIT types. */
function witTypeNamespace(apiPackage: WitApiPackage, apiInterface: WitApiInterface, type: ResolvedWitType): string {
    if (containsNamedWitType(type)) {
        const metadata = witTypeOwner(type, apiPackage, apiInterface);
        return `${cIdentifier(metadata.packageName)}_${cIdentifier(metadata.interfaceName ?? metadata.declaredInterface ?? apiInterface.name)}`;
    }
    return 'plugin';
}

/** Check whether a structural WIT type contains a named WIT declaration. */
function containsNamedWitType(type: ResolvedWitType): boolean {
    if (
        ('aliasName' in type && type.aliasName) ||
        ['enum', 'flags', 'record', 'resource', 'variant'].includes(type.kind)
    )
        return true;
    if (type.kind === 'borrow' || type.kind === 'list' || type.kind === 'option')
        return containsNamedWitType(type.item);
    if (type.kind === 'tuple') return type.items.some(containsNamedWitType);
    if (type.kind === 'result') return containsNamedWitType(type.ok) || containsNamedWitType(type.error);
    return false;
}

/** Build the componentize-c type name used inside a generated result struct. */
function witTypeName(type: ResolvedWitType): string {
    if (type.kind === 'unit') return 'void';
    if (type.kind === 'resource') return `own_${cIdentifier(type.aliasName ?? type.name)}`;
    if (type.kind === 'borrow' && type.item.kind === 'resource') {
        return `borrow_${cIdentifier(type.item.aliasName ?? type.item.name)}`;
    }
    if ('aliasName' in type && type.aliasName) return cIdentifier(type.aliasName);
    if (type.kind === 'primitive') return cIdentifier(type.name);
    if (type.kind === 'result') return `result_${witTypeName(type.ok)}_${witTypeName(type.error)}`;
    if (type.kind === 'list') return `list_${witTypeName(type.item)}`;
    if (type.kind === 'option') return `option_${witTypeName(type.item)}`;
    if (type.kind === 'tuple') return `tuple${type.items.length}_${type.items.map(witTypeName).join('_')}`;
    if (type.kind === 'borrow') return `borrow_${witTypeName(type.item)}`;
    if ('name' in type) return cIdentifier(type.name);
    if (type.kind === 'unsupported') throw new Error(`Unsupported WIT type: ${type.source}`);
    return cIdentifier(type.kind);
}

/** Check whether a structural WIT type contains owned resource handles. */
function containsWitResource(type: ResolvedWitType): boolean {
    if (type.kind === 'resource') return true;
    if (type.kind === 'option' || type.kind === 'list' || type.kind === 'borrow') return containsWitResource(type.item);
    if (type.kind === 'tuple') return type.items.some(containsWitResource);
    if (type.kind === 'record')
        return type.fields.some((field) => field.resolvedType && containsWitResource(field.resolvedType));
    if (type.kind === 'variant')
        return type.cases.some((variant) => variant.resolvedType && containsWitResource(variant.resolvedType));
    if (type.kind === 'result') return containsWitResource(type.ok) || containsWitResource(type.error);
    return false;
}

/** Generate a C++ expression that converts a JavaScript input to a WIT scalar. */
function primitiveInput(type: ResolvedWitType, expression: string, runtime: string): string {
    if (type.kind === 'enum') return expression;
    if (type.kind !== 'primitive') return '0';
    if (type.name === 'bool') return `${expression}.getBool()`;
    if (type.name === 'char') return `wasiInputChar(${runtime}, ${expression})`;
    if (type.name === 'string') return `wasiInputString(${runtime}, ${expression})`;
    if (type.name === 'u64') return `${expression}.asBigInt(${runtime}).asUint64(${runtime})`;
    if (type.name === 's64') return `${expression}.asBigInt(${runtime}).asInt64(${runtime})`;
    if (['u8', 's8', 'u16', 's16', 'u32', 's32'].includes(type.name)) {
        return `wasiInputInteger<${witCScalarType(type.name)}>(${runtime}, ${expression}, ${JSON.stringify(type.name)})`;
    }
    return `static_cast<${witCScalarType(type.name)}>(${expression}.asNumber())`;
}

/** Generate a C++ expression that converts a WIT scalar to a JavaScript value. */
function primitiveOutput(type: ResolvedWitType, expression: string, runtime: string): string {
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
function witCScalarType(name: string): string {
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
            f64: 'double',
        }[name] ?? 'double'
    );
}

/** Map primitive WIT list elements to the typed-array classes generated API bindings use. */
function typedArrayConstructor(type: ResolvedWitType): string | undefined {
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
        f64: 'Float64Array',
    }[type.name];
}

function requireResolvedFieldType(field: WitParameter): ResolvedWitType {
    if (!field.resolvedType) throw new Error(`WIT resolver did not resolve field ${field.name}`);
    return field.resolvedType;
}

function resolvedTypeName(type: ResolvedWitType): string {
    return 'name' in type ? type.name : type.kind;
}

function witTypeOwner(
    type: ResolvedWitType,
    apiPackage: WitApiPackage,
    _apiInterface: WitApiInterface,
): {
    aliasName?: string;
    name?: string;
    packageName: string;
    interfaceName?: string;
    declaredInterface?: string;
    interfaceSpecifier?: string;
} {
    return {
        aliasName: 'aliasName' in type ? type.aliasName : undefined,
        name: 'name' in type ? type.name : undefined,
        packageName: 'packageName' in type ? (type.packageName ?? apiPackage.packageName) : apiPackage.packageName,
        interfaceName: 'interfaceName' in type ? type.interfaceName : undefined,
        declaredInterface: 'declaredInterface' in type ? type.declaredInterface : undefined,
        interfaceSpecifier: 'interfaceSpecifier' in type ? type.interfaceSpecifier : undefined,
    };
}

/** Emit an owned export result and return guards to release after transferring its WIT allocations. */
export function generateWitExportValue(
    apiPackage: WitApiPackage,
    apiInterface: WitApiInterface,
    type: ResolvedWitType,
    input: string,
    name: string,
    ownership: string,
): { setup: string[]; expression: string; cleanupGuards?: string[] } {
    const result = generateWitInputValue(apiPackage, apiInterface, type, input, name, ownership, true);
    if (!result) throw new Error(`Cannot convert WIT export result ${name}`);
    return result;
}
