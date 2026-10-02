import { type Field, str } from '@pumpkin-plugins/config';
import { parseIpv4 } from '../web/ipv4.ts';

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
        check: { expected: 'an IPv4 address like "0.0.0.0"', test: (v) => parseIpv4(v) !== undefined }
    });
}

/**
 * An `http://` or `https://` URL setting. Trailing slashes are removed.
 * @param options - Description, default and whether an empty value is allowed.
 * @returns The field.
 */
export function httpUrl(options: FieldOptions & { default: string; allowEmpty?: boolean }): Field<string>;
export function httpUrl(options: FieldOptions & { allowEmpty?: boolean }): Field<string | undefined>;
/**
 * An `http://` or `https://` URL setting. Trailing slashes are removed.
 * @param options - Description, optional default and whether an empty value is allowed.
 * @returns The field.
 */
export function httpUrl(options: FieldOptions & { default?: string; allowEmpty?: boolean }): Field<string | undefined> {
    const { allowEmpty, ...rest } = options;
    return str({
        ...rest,
        check: {
            expected: 'an http:// or https:// URL',
            test: (v) => (v === '' ? allowEmpty === true : /^https?:\/\/[^\s/]+/.test(v)),
            normalize: (v) => v.replace(/\/+$/, '')
        }
    });
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
            normalize: (v) => v.replace(/\/+$/, '')
        }
    });
}
