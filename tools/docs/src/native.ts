import { readFileSync } from 'node:fs';
import { parse } from 'smol-toml';

/** Cargo metadata used by native documentation and release validation. */
export interface NativeManifest {
    description: string;
    library: string;
    license: string;
    name: string;
    version: string;
}

/** Read a standalone native cdylib's canonical version without invoking Cargo or compiling Rust. */
export function readNativeManifest(file: string): NativeManifest {
    const cargo = parse(readFileSync(file, 'utf8'));
    const pkg = cargo.package as Record<string, unknown> | undefined;
    const lib = cargo.lib as Record<string, unknown> | undefined;
    const required = (key: string): string => {
        const value = pkg?.[key];
        if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value)) {
            throw new Error(`${file} requires an explicit package.${key}`);
        }
        return value;
    };
    const name = required('name');
    const version = required('version');
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error(`${file} has an invalid native package name`);
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
        throw new Error(`${file} has an invalid native version`);
    }
    if (!Array.isArray(lib?.['crate-type']) || !lib['crate-type'].includes('cdylib')) {
        throw new Error(`${file} must declare lib.crate-type = ["cdylib"]`);
    }
    const library = lib.name ?? name.replaceAll('-', '_');
    if (typeof library !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(library)) {
        throw new Error(`${file} has an invalid library name`);
    }
    return { name, version, library, description: required('description'), license: required('license') };
}
