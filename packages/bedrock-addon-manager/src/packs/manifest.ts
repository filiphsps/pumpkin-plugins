import { strFromU8, unzipSync } from 'fflate';

/** What the plugin needs to know about a pack, read from its `manifest.json`. */
export interface PackManifest {
    /** Lowercase header UUID. */
    uuid: string;
    /** `major.minor.patch`. */
    version: string;
    name?: string;
    moduleTypes: string[];
    /** The pack is part of an add-on: it has behavior or script modules, or depends on another pack. */
    addonPack: boolean;
    /** The pack has a `script` or `client_data` module. */
    hasScripts: boolean;
    /** The manifest asks for the `raytraced` capability. */
    rtxEnabled: boolean;
}

/** A pack's manifest is missing or unusable. The message says why and is fit for the server log. */
export class ManifestError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCRIPT_MODULES = ['script', 'client_data'];
const ADDON_MODULES = ['data', ...SCRIPT_MODULES];

/** Only the manifest is inflated: packs are megabytes and the rest of the archive is irrelevant. */
export function readManifest(zip: Uint8Array): PackManifest {
    let files: Record<string, Uint8Array>;
    try {
        files = unzipSync(zip, { filter: (file) => isManifestPath(file.name) });
    } catch {
        throw new ManifestError('not a valid zip archive');
    }

    // `manifest.json` at the root, or the shallowest one when the archive wraps the pack in a folder.
    const names = Object.keys(files).sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
    if (names.length === 0) throw new ManifestError('no manifest.json found');

    let json: unknown;
    try {
        json = JSON.parse(stripJsonComments(strFromU8(files[names[0]])));
    } catch {
        throw new ManifestError(`${names[0]} is not valid JSON (encrypted packs are not supported)`);
    }
    return fromJson(json);
}

function isManifestPath(name: string): boolean {
    return name === 'manifest.json' || name.endsWith('/manifest.json');
}

function fromJson(json: unknown): PackManifest {
    const root = asObject(json);
    const header = asObject(root?.header);
    if (!header) throw new ManifestError('manifest.json has no header');

    const uuid = header.uuid;
    if (typeof uuid !== 'string' || !UUID.test(uuid)) throw new ManifestError('header.uuid is missing or not a UUID');

    const modules = Array.isArray(root?.modules) ? root.modules : [];
    const moduleTypes = modules.map((m) => asObject(m)?.type).filter((t): t is string => typeof t === 'string');
    const dependsOnPack = Array.isArray(root?.dependencies) && root.dependencies.some((d) => asObject(d)?.uuid);
    const capabilities = Array.isArray(root?.capabilities) ? root.capabilities : [];

    return {
        uuid: uuid.toLowerCase(),
        version: readVersion(header.version),
        name: typeof header.name === 'string' ? header.name : undefined,
        moduleTypes,
        addonPack: dependsOnPack || moduleTypes.some((t) => ADDON_MODULES.includes(t)),
        hasScripts: moduleTypes.some((t) => SCRIPT_MODULES.includes(t)),
        rtxEnabled: capabilities.includes('raytraced')
    };
}

function readVersion(version: unknown): string {
    if (
        Array.isArray(version) &&
        version.length >= 3 &&
        version.slice(0, 3).every((n) => Number.isInteger(n) && n >= 0)
    ) {
        return version.slice(0, 3).join('.');
    }
    // format_version 3 manifests may use a semver string.
    if (typeof version === 'string') {
        const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
        if (m) return `${m[1]}.${m[2]}.${m[3]}`;
    }
    throw new ManifestError('header.version must be [major, minor, patch]');
}

function asObject(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

/** Bedrock accepts `//` and `/* *\/` comments and a byte order mark in manifests. */
export function stripJsonComments(text: string): string {
    let out = '';
    let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    while (i < text.length) {
        const c = text[i];
        if (c === '"') {
            let j = i + 1;
            while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
            out += text.slice(i, j + 1);
            i = j + 1;
        } else if (c === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') i++;
        } else if (c === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i + 2);
            i = end === -1 ? text.length : end + 2;
        } else {
            out += c;
            i++;
        }
    }
    return out;
}
