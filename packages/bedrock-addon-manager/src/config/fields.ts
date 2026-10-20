import { type Field, str } from '@pumpkin-plugins/config';
import { parseIpv4 } from '@pumpkin-plugins/port-mapping/ipv4';

const DNS_LABEL = String.raw`[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?`;
const HTTP_BASE_URL = new RegExp(
    String.raw`^https?:\/\/(?:${DNS_LABEL}(?:\.${DNS_LABEL})*\.?|\[[\da-f:.]+\])(?::([1-9]\d{0,4}))?(?:\/[^\\\s?#]*)?$`,
    'i',
);

/** Options shared by the string-based fields below. */
interface FieldOptions {
    /** What the setting does. */
    description: string;
    /** Example shown for the commented hint of an optional setting. */
    example?: string;
}

/**
 * An IPv4 address setting.
 * @param options - Description and default.
 * @returns The field.
 */
export function ipv4Address(options: FieldOptions & { default: string }): Field<string> {
    return str({
        ...options,
        check: {
            expected: 'an IPv4 address like "0.0.0.0"',
            test: (v) => parseIpv4(v) !== undefined,
            normalize: (v) => v.trim(),
        },
    });
}

/**
 * An `http://` or `https://` URL setting. Trailing slashes are removed.
 * @param options - Description, optional default and whether an empty value is allowed.
 * @returns The field.
 */
export function httpUrl(options: FieldOptions & { default: string; allowEmpty?: boolean }): Field<string>;
export function httpUrl(options: FieldOptions & { allowEmpty?: boolean }): Field<string | undefined>;
export function httpUrl(options: FieldOptions & { default?: string; allowEmpty?: boolean }): Field<string | undefined> {
    const { allowEmpty, ...rest } = options;
    return str({
        ...rest,
        example: rest.example ?? rest.default ?? 'https://example.com',
        check: {
            expected: 'an http:// or https:// URL',
            test: (v) => (v === '' ? allowEmpty === true : /^https?:\/\/[^\s/]+/.test(v)),
            normalize: (v) => v.replace(/\/+$/, ''),
        },
    });
}

/**
 * An `http://` or `https://` base URL setting. Query strings and fragments are not allowed.
 * @param options - Description, optional default and whether an empty value is allowed.
 * @returns The field.
 */
export function httpBaseUrl(options: FieldOptions & { default: string; allowEmpty?: boolean }): Field<string>;
export function httpBaseUrl(options: FieldOptions & { allowEmpty?: boolean }): Field<string | undefined>;
export function httpBaseUrl(
    options: FieldOptions & { default?: string; allowEmpty?: boolean },
): Field<string | undefined> {
    const { allowEmpty, ...rest } = options;
    return str({
        ...rest,
        example: rest.example ?? rest.default ?? 'https://example.com',
        check: {
            expected: 'an http:// or https:// base URL without a query or fragment',
            test: (value) => (value === '' ? allowEmpty === true : isHttpBaseUrl(value)),
            normalize: (value) => value.replace(/\/+$/, ''),
        },
    });
}

function isHttpBaseUrl(value: string): boolean {
    const match = HTTP_BASE_URL.exec(value);
    return match !== null && (match[1] === undefined || Number(match[1]) <= 65535);
}

/**
 * A folder setting: a relative path that stays inside the plugin's data folder.
 * @param options - Description and default.
 * @returns The field.
 */
export function relativeFolder(options: FieldOptions & { default: string }): Field<string> {
    return str({
        ...options,
        check: {
            expected: 'a relative folder inside the data folder',
            test: (v) => v !== '' && !v.startsWith('/') && !v.includes('\\') && !v.split('/').includes('..'),
            normalize: (v) => v.replace(/\/+$/, ''),
        },
    });
}
