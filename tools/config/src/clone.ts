import { TomlDate } from 'smol-toml';

/**
 * Copies supported config values without using `structuredClone`, which isn't available in every
 * plugin runtime. Plain tables and dense ordinary arrays are copied recursively, dates are copied
 * by value, and root `undefined` is retained as the optional-default sentinel.
 * @param value - A config default to copy, or `undefined` for an optional field.
 * @returns An independent value with the same TOML data.
 * @throws When the value contains an invalid date, unsupported data, a cycle, or an unsupported object type.
 */
export function cloneConfigValue<T>(value: T): T {
    if (value === undefined) return value;
    return cloneValue(value, []) as T;
}

function cloneValue(value: unknown, ancestors: object[]): unknown {
    if (value === undefined || value === null || typeof value === 'function' || typeof value === 'symbol') {
        throw new TypeError('Configuration values must contain only TOML data');
    }
    if (typeof value !== 'object') return value;
    if (value instanceof TomlDate) {
        if (Object.getPrototypeOf(value) !== TomlDate.prototype || Reflect.ownKeys(value).length > 0) {
            throw new TypeError('Configuration values may only contain plain tables, arrays, and dates');
        }
        if (!value.isValid() || !Number.isFinite(value.getTime())) {
            throw new TypeError('Configuration values must contain only valid TOML dates');
        }
        return new TomlDate(value.toISOString());
    }
    if (value instanceof Date) {
        if (Object.getPrototypeOf(value) !== Date.prototype || Reflect.ownKeys(value).length > 0) {
            throw new TypeError('Configuration values may only contain plain tables, arrays, and dates');
        }
        if (!Number.isFinite(value.getTime())) {
            throw new TypeError('Configuration values must contain only valid TOML dates');
        }
        return new Date(value.getTime());
    }
    if (ancestors.includes(value)) throw new TypeError('Configuration values must not contain cycles');

    const isArray = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (
        (isArray && (prototype !== Array.prototype || hasUnsupportedArrayShape(value))) ||
        (!isArray && prototype !== Object.prototype && prototype !== null)
    ) {
        throw new TypeError('Configuration values may only contain plain tables, arrays, and dates');
    }

    ancestors.push(value);
    const clone = isArray ? cloneArray(value, ancestors) : cloneTable(value, ancestors);
    ancestors.pop();
    return clone;
}

function cloneTable(value: object, ancestors: object[]): Record<string, unknown> {
    const clone: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string') throw new TypeError('Configuration tables may only have string keys');

        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !('value' in descriptor)) {
            throw new TypeError('Configuration tables may only contain enumerable data properties');
        }

        Object.defineProperty(clone, key, {
            configurable: true,
            enumerable: true,
            value: cloneValue(descriptor.value, ancestors),
            writable: true,
        });
    }
    return clone;
}

function hasUnsupportedArrayShape(value: unknown[]): boolean {
    let indexCount = 0;
    for (const key of Reflect.ownKeys(value)) {
        if (key === 'length') continue;
        if (!isArrayIndex(key, value.length)) return true;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !('value' in descriptor)) return true;
        indexCount++;
    }
    return indexCount !== value.length;
}

function isArrayIndex(key: PropertyKey, length: number): boolean {
    if (typeof key !== 'string') return false;
    const index = Number(key);
    return Number.isInteger(index) && index >= 0 && index < length && String(index) === key;
}

function cloneArray(value: unknown[], ancestors: object[]): unknown[] {
    const clone: unknown[] = new Array(value.length);
    for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (!descriptor?.enumerable || !('value' in descriptor)) {
            throw new TypeError('Configuration arrays may only contain enumerable data values');
        }
        clone[index] = cloneValue(descriptor.value, ancestors);
    }
    return clone;
}
