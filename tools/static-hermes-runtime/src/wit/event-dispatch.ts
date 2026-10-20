import type { WitEventFieldSelection } from './analysis.ts';
import { cFieldIdentifier, cIdentifier, enumValue, jsName, jsVariantTag, pascalCase } from './names.ts';
import { generateWitExportValue } from './native-adapters.ts';
import type { ResolvedWitType, WitApiPackage, WitRecord, WitRecordField } from './types.ts';

interface EventGenerationContext {
    apiPackage: WitApiPackage;
}

interface GeneratedEventValue {
    expression: string;
    setup: string[];
}

type ScalarEventConversion = (value: string) => string;

/**
 * Generate native event payload conversion without pruning nested JavaScript record fields.
 *
 * @param apiPackage - Resolved Pumpkin API package containing event variants and payload records.
 * @param selections - Event cases and payload fields selected during WIT analysis.
 * @returns C++ event dispatch code, or an empty string when there are no selected events.
 * @throws {Error} If a selected event or payload record is missing from the WIT package.
 */
export function generateWitEventDispatch(
    apiPackage: WitApiPackage,
    selections: readonly WitEventFieldSelection[],
): string {
    const eventInterface = apiPackage.interfaces.find((apiInterface) => apiInterface.name === 'event');
    const eventVariant = eventInterface?.variants.find((variant) => variant.name === 'event');
    if (!eventVariant) return '';

    const records = new Map<string, WitRecord>(
        apiPackage.interfaces.flatMap((apiInterface) => apiInterface.records.map((record) => [record.name, record])),
    );
    const context: EventGenerationContext = { apiPackage };
    const cases = [];

    for (const selection of selections) {
        const event = eventVariant.cases.find((candidate) => candidate.name === selection.event);
        if (!event) throw new Error(`Selected WIT event is not declared: ${selection.event}`);
        const record = records.get(selection.record);
        if (!record) throw new Error(`WIT event ${event.name} refers to missing record ${selection.record}`);
        const selectedFields = new Set(selection.fields);
        const fields = record.fields
            .filter(({ name }) => selectedFields.has(name))
            .map((field) =>
                generateEventField(field, `eventData.${cIdentifier(field.name)}`, jsName(field.name), 'data', context),
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
const scalarEventConversions = new Map<string, ScalarEventConversion>([
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
    ['string', (value) => `jsString(runtime, wasiStringValue(${value}))`],
]);

/** Generate native event field conversion code for resolved WIT value shapes. */
function generateEventField(
    field: WitRecordField,
    source: string,
    path: string,
    target: string,
    context: EventGenerationContext,
): string {
    const type = requireResolvedEventType(field.resolvedType, `event field ${field.name}`);
    const value = generateRecursiveEventValue(type, source, path, context);
    return value.setup
        .concat(`${target}.setProperty(runtime, ${JSON.stringify(propertyName(path))}, ${value.expression});`)
        .join('\n');
}

/** Recursively convert a WIT event value into a JavaScript value. */
function generateRecursiveEventValue(
    type: ResolvedWitType,
    source: string,
    path: string,
    context: EventGenerationContext,
): GeneratedEventValue {
    const name = `eventValue${pascalCase(path)}`;
    switch (type.kind) {
        case 'unit':
            return { setup: [], expression: 'Value::undefined()' };
        case 'primitive': {
            const conversion = scalarEventConversions.get(type.name);
            return conversion ? { setup: [], expression: conversion(source) } : unsupportedEventType(type.name, path);
        }
        case 'enum': {
            const cases = type.values.map(
                (value) =>
                    `case ${enumValue(context.apiPackage, type, value)}: ${name} = ${JSON.stringify(value)}; break;`,
            );
            return {
                setup: [
                    `std::string ${name};`,
                    `switch (${source}) { ${cases.join(' ')} default: throw JSError(runtime, ${JSON.stringify(`Unknown ${type.name} value`)}); }`,
                ],
                expression: `jsString(runtime, ${name})`,
            };
        }
        case 'flags': {
            const setup = [`Object ${name}(runtime);`];
            for (const flag of type.values) {
                setup.push(
                    `${name}.setProperty(runtime, ${JSON.stringify(jsName(flag))}, Value((${source} & ${enumValue(context.apiPackage, type, flag)}) != 0));`,
                );
            }
            return { setup, expression: `std::move(${name})` };
        }
        case 'resource': {
            const state = `${name}State`;
            return {
                setup: [
                    `auto ${state} = std::make_shared<ResourceState>(ResourceState{${source}.__handle, true, ${JSON.stringify(type.interfaceName)}, ${JSON.stringify(type.name)}});`,
                    `ownedResources->push_back(${state});`,
                ],
                expression: `wrapResourceObject(runtime, makeWitResourceObject(${state}))`,
            };
        }
        case 'borrow':
            return type.item.kind === 'resource'
                ? generateRecursiveEventValue(type.item, source, path, context)
                : unsupportedEventType(`borrow<${type.item.kind}>`, path);
        case 'option': {
            const item = generateRecursiveEventValue(type.item, `${source}.val`, `${path}.value`, context);
            return {
                setup: [
                    `Value ${name} = Value::null();`,
                    `if (${source}.is_some) {`,
                    ...item.setup.map((line) => `  ${line}`),
                    `  ${name} = Value(${item.expression});`,
                    '}',
                ],
                expression: `std::move(${name})`,
            };
        }
        case 'list': {
            if (type.item.kind === 'primitive' && type.item.name === 'u8') {
                return {
                    setup: [
                        `Uint8Array ${name}(runtime, ${source}.len);`,
                        `if (${source}.len) { auto ${name}Buffer = ${name}.buffer(runtime); std::memcpy(${name}Buffer.data(runtime), ${source}.ptr, ${source}.len); }`,
                    ],
                    expression: `std::move(${name})`,
                };
            }
            const index = `${name}Index`;
            const item = generateRecursiveEventValue(type.item, `${source}.ptr[${index}]`, `${path}.item`, context);
            return {
                setup: [
                    `Array ${name}(runtime, ${source}.len);`,
                    `for (std::size_t ${index} = 0; ${index} < ${source}.len; ++${index}) {`,
                    ...item.setup.map((line) => `  ${line}`),
                    `  ${name}.setValueAtIndex(runtime, ${index}, ${item.expression});`,
                    '}',
                ],
                expression: `std::move(${name})`,
            };
        }
        case 'tuple': {
            const setup = [`Array ${name}(runtime, ${type.items.length});`];
            for (const [index, itemType] of type.items.entries()) {
                const item = generateRecursiveEventValue(
                    itemType,
                    `${source}.f${index}`,
                    `${path}.item${index}`,
                    context,
                );
                setup.push(...item.setup, `${name}.setValueAtIndex(runtime, ${index}, ${item.expression});`);
            }
            return { setup, expression: `std::move(${name})` };
        }
        case 'record': {
            const setup = [`Object ${name}(runtime);`];
            for (const field of type.fields) {
                const childName = jsName(field.name);
                const fieldType = requireResolvedEventType(field.resolvedType, `event field ${field.name}`);
                const fieldValue = generateRecursiveEventValue(
                    fieldType,
                    `${source}.${cIdentifier(field.name)}`,
                    `${path}.${childName}`,
                    context,
                );
                setup.push(
                    ...fieldValue.setup,
                    `${name}.setProperty(runtime, ${JSON.stringify(childName)}, ${fieldValue.expression});`,
                );
            }
            return { setup, expression: `std::move(${name})` };
        }
        case 'variant': {
            const setup = [`Object ${name}(runtime);`, `switch (${source}.tag) {`];
            for (const variant of type.cases) {
                const variantName = jsVariantTag(variant.name);
                const branch = [
                    `${name}.setProperty(runtime, "tag", jsString(runtime, ${JSON.stringify(variantName)}));`,
                ];
                if (variant.resolvedType) {
                    const payload = generateRecursiveEventValue(
                        variant.resolvedType,
                        `${source}.val.${cFieldIdentifier(variant.name)}`,
                        `${path}.val`,
                        context,
                    );
                    branch.push(...payload.setup, `${name}.setProperty(runtime, "val", ${payload.expression});`);
                }
                setup.push(`case ${enumValue(context.apiPackage, type, variant.name)}: { ${branch.join(' ')} break; }`);
            }
            setup.push(`default: throw JSError(runtime, ${JSON.stringify(`Unknown ${type.name} variant`)});`, '}');
            return { setup, expression: `std::move(${name})` };
        }
        case 'result': {
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
                '}',
            );
            return { setup, expression: `std::move(${name})` };
        }
        case 'unsupported':
            return unsupportedEventType(type.source, path);
        default:
            return assertNever(type);
    }
}

function unsupportedEventType(typeName: string, path: string): never {
    throw new Error(`Static Hermes cannot convert WIT event field type ${typeName} (${path})`);
}

function assertNever(type: never): never {
    throw new Error(`Unhandled resolved WIT event type: ${JSON.stringify(type)}`);
}

/** Require a resolved type before generating native code for an event field. */
function requireResolvedEventType(type: ResolvedWitType | undefined, location: string): ResolvedWitType {
    if (!type) throw new Error(`WIT ${location} has no resolved type`);
    return type;
}

/** Return the final property name in a dotted JavaScript access path. */
function propertyName(path: string): string {
    return path.split('.').at(-1) ?? path;
}

/** Prefix every line with the requested number of spaces. */
function indent(value: string, spaces: number): string {
    const prefix = ' '.repeat(spaces);
    return value
        .split('\n')
        .map((line) => `${prefix}${line}`)
        .join('\n');
}

/** Generate event return lowering, committing owned resources only after the payload converts. */
export function generateWitEventResultDispatch(
    apiPackage: WitApiPackage,
    selections: readonly WitEventFieldSelection[],
): string {
    const apiInterface = apiPackage.interfaces.find(({ name }) => name === 'event');
    if (!apiInterface || selections.length === 0) return '';
    const variant = apiInterface.variants.find(({ name }) => name === 'event');
    if (!variant) return '';
    const cases = variant.cases.filter(({ name }) => selections.some(({ event }) => event === name));
    const type: ResolvedWitType = {
        kind: 'variant',
        name: variant.name,
        interfaceName: apiInterface.name,
        packageName: apiPackage.packageName,
        interfaceSpecifier: apiInterface.specifier,
        interfaceDependencies: [],
        cases,
    };
    const result = generateWitExportValue(
        apiPackage,
        apiInterface,
        type,
        'value',
        'returnedEvent',
        'returnedResources',
    );
    return [
        'const auto returnedTag = utf8(rt, value.asObject(rt).getProperty(rt, "tag"));',
        'if (returnedTag != eventName(event->tag)) throw JSError(rt, "Event handlers cannot change the event type");',
        'std::vector<std::shared_ptr<ResourceState>> returnedResources;',
        ...result.setup,
        'for (const auto &resource : returnedResources) resource->transfer();',
        'plugin_event_free(event);',
        `*ret = ${result.expression};`,
        ...(result.cleanupGuards ?? []).map((guardName) => `${guardName}.release();`),
        'for (const auto &resource : *eventResources) resource->drop();',
    ].join('\n');
}
