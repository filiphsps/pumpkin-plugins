/** Outcome of reading one raw TOML value. */
export type Parsed<T> = { ok: true; value: T } | { ok: false };

/** Type names the generated documentation uses. */
export type FieldType = 'boolean' | 'integer' | 'string';

/**
 * One setting: how to read it, write it and document it. `T` includes `undefined` for
 * optional settings, which have no default.
 */
export interface Field<T> {
    /** Type name shown in the generated documentation. */
    readonly type: FieldType;
    /** What the setting does. Becomes the comment above it in the file and a row in the docs. */
    readonly description: string;
    /** Value used when the setting is absent. `undefined` makes the setting optional. */
    readonly default: T;
    /** What a valid value looks like, used in warnings: `must be <expected>`. */
    readonly expected: string;
    /** A TOML literal shown in the commented example of an unset optional setting. */
    readonly example: string;
    /** Path to an older setting whose value should seed this setting when it is absent. */
    readonly migrateFrom?: readonly string[];
    /** Validates a raw TOML value. */
    parse(raw: unknown): Parsed<Exclude<T, undefined>>;
    /** Writes a value as a TOML literal. */
    format(value: Exclude<T, undefined>): string;
}

/** The settings of a section or table entry, by key. */
export type Fields = Record<string, Field<unknown>>;

/** Options shared by the config field builders. */
export interface BaseOptions<T> {
    /** What the setting does. */
    description: string;
    /** Value used when the setting is absent. Leave out to make the setting optional. */
    default?: T;
    /** Example value for the commented hint of an optional setting. */
    example?: T;
    /** Path to an older setting whose value should seed this setting when it is absent. */
    migrateFrom?: readonly string[];
}

/** Writes a string as a TOML basic string, which JSON string syntax is a valid subset of. */
export const tomlString = (value: string): string => JSON.stringify(value);

/** Builds a field from its pieces. Prefer `bool`, `int` and `str`. */
export function field<T>(spec: {
    type: FieldType;
    description: string;
    default: T | undefined;
    expected: string;
    example: T;
    migrateFrom?: readonly string[];
    parse: (raw: unknown) => Parsed<T>;
    format: (value: T) => string;
}): Field<T | undefined> {
    return { ...spec, example: spec.format(spec.example) } as Field<T | undefined>;
}

/** A true/false setting. */
export function bool(options: BaseOptions<boolean> & { default: boolean }): Field<boolean>;
export function bool(options: BaseOptions<boolean>): Field<boolean | undefined>;
/**
 * A true/false setting.
 * @param options - Description and, unless the setting is optional, its default.
 * @returns The field.
 */
export function bool(options: BaseOptions<boolean>): Field<boolean | undefined> {
    return field<boolean>({
        type: 'boolean',
        description: options.description,
        default: options.default,
        expected: 'true or false',
        example: options.example ?? options.default ?? false,
        migrateFrom: options.migrateFrom,
        parse: (raw) => (typeof raw === 'boolean' ? { ok: true, value: raw } : { ok: false }),
        format: String
    });
}

/** A whole-number setting, optionally limited to a range. */
export function int(options: BaseOptions<number> & { default: number; min?: number; max?: number }): Field<number>;
export function int(options: BaseOptions<number> & { min?: number; max?: number }): Field<number | undefined>;
/**
 * A whole-number setting, optionally limited to a range.
 * @param options - Description, optional bounds and, unless the setting is optional, its default.
 * @returns The field.
 */
export function int(options: BaseOptions<number> & { min?: number; max?: number }): Field<number | undefined> {
    const { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = options;
    let expected = 'a whole number';
    if (options.min !== undefined && options.max !== undefined) expected += ` from ${min} to ${max}`;
    else if (options.min !== undefined) expected += ` of at least ${min}`;
    else if (options.max !== undefined) expected += ` of at most ${max}`;

    return field<number>({
        type: 'integer',
        description: options.description,
        default: options.default,
        expected,
        example: options.example ?? options.default ?? min,
        migrateFrom: options.migrateFrom,
        parse: (raw) => {
            const n = typeof raw === 'bigint' ? Number(raw) : raw;
            return typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max
                ? { ok: true, value: n }
                : { ok: false };
        },
        format: String
    });
}

/** Extra rules for a string setting. */
export interface StringCheck {
    /** What a valid value looks like, used in warnings. */
    expected: string;
    /** Whether a value is acceptable. */
    test: (value: string) => boolean;
    /** Tidies an accepted value, for example by trimming a trailing slash. */
    normalize?: (value: string) => string;
}

/** A text setting, optionally restricted by a check. */
export function str(options: BaseOptions<string> & { default: string; check?: StringCheck }): Field<string>;
export function str(options: BaseOptions<string> & { check?: StringCheck }): Field<string | undefined>;
/**
 * A text setting, optionally restricted by a check.
 * @param options - Description, optional check and, unless the setting is optional, its default.
 * @returns The field.
 */
export function str(options: BaseOptions<string> & { check?: StringCheck }): Field<string | undefined> {
    const { check } = options;
    return field<string>({
        type: 'string',
        description: options.description,
        default: options.default,
        expected: check?.expected ?? 'a string',
        example: options.example ?? options.default ?? '',
        migrateFrom: options.migrateFrom,
        parse: (raw) => {
            if (typeof raw !== 'string' || (check && !check.test(raw))) return { ok: false };
            return { ok: true, value: check?.normalize ? check.normalize(raw) : raw };
        },
        format: tomlString
    });
}
