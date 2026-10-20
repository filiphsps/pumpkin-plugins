import type {
    WitApiInterface,
    WitApiPackage,
    WitFunction,
    WitOwnedType,
    WitResource,
    WitWasiInterface,
} from './types.ts';

// The generated JavaScript and C names must match across facades, dispatch and adapters, so every
// generator takes them from here.

const C_RESERVED_FIELD_NAMES = new Set(
    'alignas alignof and and_eq asm atomic_cancel atomic_commit atomic_noexcept auto bitand bitor bool break case catch char char8_t char16_t char32_t class compl concept const consteval constexpr constinit const_cast continue co_await co_return co_yield decltype default delete do double dynamic_cast else enum explicit export extern false float for friend goto if inline int long mutable namespace new noexcept not not_eq nullptr operator or or_eq private protected public register reinterpret_cast requires return short signed sizeof static static_assert static_cast struct switch synchronized template this thread_local throw true try typedef typeid typename union unsigned using virtual void volatile wchar_t while xor xor_eq'.split(
        /\s+/,
    ),
);

/** Convert a WIT identifier to the lowercase C identifier wit-bindgen uses. */
export function cIdentifier(witName: string): string {
    return witName
        .replace(/^%/, '')
        .replace(/[^a-zA-Z0-9_]/g, '_')
        .replace(/_+/g, '_')
        .toLowerCase();
}

/** Convert a WIT field name to its C struct member name, which gets a `_` suffix when it is a C++ keyword. */
export function cFieldIdentifier(witName: string): string {
    const identifier = cIdentifier(witName);
    return C_RESERVED_FIELD_NAMES.has(identifier) ? `${identifier}_` : identifier;
}

/** Convert a WIT identifier to the camelCase name used for JavaScript functions and fields. */
export function jsName(witName: string): string {
    return witName.replace(/^%/, '').replace(/-([a-zA-Z0-9])/g, (_match, character: string) => character.toUpperCase());
}

/** Convert a WIT resource name to its JavaScript class name. */
export function jsClassName(witName: string): string {
    const name = jsName(witName);
    return name.charAt(0).toUpperCase() + name.slice(1);
}

/** Return a WIT case name as its JavaScript variant tag, which keeps the kebab-case spelling. */
export function jsVariantTag(witName: string): string {
    return witName.replace(/^%/, '');
}

/** Convert a separator-delimited identifier to PascalCase. */
export function pascalCase(value: string): string {
    return value
        .split(/[^a-zA-Z0-9]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join('');
}

/** Build the wit-bindgen C constant for one enum, flags or variant case of a named WIT type. */
export function enumValue(apiPackage: WitApiPackage, type: WitOwnedType, value: string): string {
    return [type.packageName || apiPackage.packageName, type.interfaceName, type.name, value]
        .map((part) => cIdentifier(part).toUpperCase())
        .join('_');
}

/** Return the wit-bindgen C function name for a freestanding function or resource operation. */
export function witOperationCFunctionName(
    apiPackage: WitApiPackage,
    apiInterface: WitApiInterface,
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

/** Return the global name that holds the generated host object for a WASI interface. */
export function wasiHostName(apiInterface: WitWasiInterface): string {
    const namespace = apiInterface.packageName.slice(apiInterface.packageName.indexOf(':') + 1);
    return `__pumpkinWasi${pascalCase(namespace)}${pascalCase(apiInterface.name)}`;
}
