import { strToU8, zipSync } from 'fflate';

/** Header UUID of a real add-on resource pack, so tests look like real data. */
export const SAMPLE_UUID = '627409cd-5207-46f1-b1e8-0d4492616419';

export interface ManifestOptions {
    uuid?: string;
    version?: number[] | string;
    name?: string;
    modules?: string[];
    dependencies?: string[];
    capabilities?: string[];
}

export function manifestJson(options: ManifestOptions = {}): Record<string, unknown> {
    return {
        format_version: 2,
        header: {
            name: options.name ?? 'Test Pack',
            description: 'A pack for tests',
            uuid: options.uuid ?? SAMPLE_UUID,
            version: options.version ?? [1, 0, 1],
            min_engine_version: [1, 13, 0]
        },
        modules: (options.modules ?? ['resources']).map((type, i) => ({
            type,
            uuid: `00000000-0000-4000-8000-00000000000${i}`,
            version: [1, 0, 0]
        })),
        ...(options.dependencies && {
            dependencies: options.dependencies.map((uuid) => ({ uuid, version: [1, 0, 0] }))
        }),
        ...(options.capabilities && { capabilities: options.capabilities })
    };
}

/** Deterministic, incompressible bytes, so archive sizes and ranges are predictable. */
export function noise(length: number, seed = 1): Uint8Array {
    const out = new Uint8Array(length);
    let x = seed;
    for (let i = 0; i < length; i++) {
        x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
        out[i] = x >>> 24;
    }
    return out;
}

/** Builds a `.mcpack` (a zip). `manifest` may be an object or raw text, `folder` wraps the pack in a directory. */
export function makeMcpack(
    manifest: Record<string, unknown> | string = manifestJson(),
    options: { files?: Record<string, Uint8Array | string>; folder?: string } = {}
): Uint8Array {
    const prefix = options.folder ? `${options.folder}/` : '';
    const entries: Record<string, Uint8Array> = {
        [`${prefix}manifest.json`]: strToU8(typeof manifest === 'string' ? manifest : JSON.stringify(manifest))
    };
    for (const [name, content] of Object.entries(options.files ?? {})) {
        entries[`${prefix}${name}`] = typeof content === 'string' ? strToU8(content) : content;
    }
    return zipSync(entries, { level: 0 });
}
