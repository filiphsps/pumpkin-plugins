import { unzipSync, zipSync } from 'fflate';
import { ManifestError, type PackManifest, readManifest } from './manifest.ts';

/** A resource pack found inside an add-on bundle, repackaged so it can be served as a `.mcpack`. */
export interface ExtractedPack {
    /** The pack's folder name in the bundle, or the nested `.mcpack`'s name without its extension. */
    name: string;
    /** The pack as a `.mcpack` archive. */
    bytes: Uint8Array;
    /** The manifest read from the pack. */
    manifest: PackManifest;
}

/** What an add-on bundle holds. */
export interface AddonContents {
    /** The resource packs, in the order they appear in the bundle. */
    packs: ExtractedPack[];
    /** One message per pack that was left out, and why. Behavior packs are the usual reason. */
    skipped: string[];
}

const baseName = (path: string) => path.split('/').pop() ?? path;
const stripExtension = (name: string) => name.replace(/\.mcpack$/i, '');

/** Folder holding each `manifest.json`, with the shallowest ones only so a pack inside a pack is not counted twice. */
function packFolders(paths: string[]): string[] {
    const folders = paths
        .filter((p) => p === 'manifest.json' || p.endsWith('/manifest.json'))
        .map((p) => p.slice(0, -'manifest.json'.length));
    return folders.filter((f) => !folders.some((other) => other !== f && f.startsWith(other)));
}

/**
 * Finds the resource packs in a `.mcaddon` bundle. Bundles come in two layouts, folders with a
 * manifest each or nested `.mcpack` archives, and often hold a behavior pack beside the resource
 * pack. Behavior packs can't be offered to Bedrock clients, so they are skipped.
 * @param zip - The bytes of the bundle.
 * @returns The resource packs, repackaged as `.mcpack` archives, and the packs that were skipped.
 * @throws {ManifestError} When the bundle isn't a zip archive.
 */
export function readAddon(zip: Uint8Array): AddonContents {
    let files: Record<string, Uint8Array>;
    try {
        files = unzipSync(zip);
    } catch {
        throw new ManifestError('not a valid zip archive');
    }
    const paths = Object.keys(files).filter((p) => !p.endsWith('/'));

    const candidates: { name: string; bytes: Uint8Array }[] = [];
    for (const path of paths.filter((p) => /\.mcpack$/i.test(p))) {
        candidates.push({ name: stripExtension(baseName(path)), bytes: files[path] });
    }
    for (const folder of packFolders(paths.filter((p) => !/\.mcpack$/i.test(p)))) {
        const inside: Record<string, Uint8Array> = {};
        for (const path of paths) if (path.startsWith(folder)) inside[path.slice(folder.length)] = files[path];
        // Stored, not compressed: resource packs are mostly PNG and OGG, which are compressed already.
        candidates.push({ name: baseName(folder.replace(/\/$/, '')) || 'pack', bytes: zipSync(inside, { level: 0 }) });
    }

    const packs: ExtractedPack[] = [];
    const skipped: string[] = [];
    for (const { name, bytes } of candidates) {
        try {
            const manifest = readManifest(bytes);
            if (manifest.moduleTypes.includes('resources')) packs.push({ name, bytes, manifest });
            else skipped.push(`${name} (${manifest.moduleTypes.join(', ') || 'no modules'}, not a resource pack)`);
        } catch (err) {
            skipped.push(`${name}: ${err instanceof ManifestError ? err.message : String(err)}`);
        }
    }
    return { packs, skipped };
}
