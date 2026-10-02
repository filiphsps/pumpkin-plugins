import type { Config } from '../config/schema.ts';
import type { PackManifest } from './manifest.ts';

/** A pack found in the packs folder, with the manifest read from it. */
export interface ScannedPack {
    /** The name the pack is served and configured under: its own file name, or one made from its `.mcaddon`. */
    fileName: string;
    /** Where the `.mcpack` is, relative to the data folder. */
    path: string;
    size: number;
    /** Milliseconds since the epoch. */
    modified: number;
    manifest: PackManifest;
}

/** One pack as it goes into `resource_pack.bedrock.packs`. */
export interface PackEntry {
    fileName: string;
    path: string;
    uuid: string;
    version: string;
    size: number;
    downloadUrl: string;
    order: number;
    addonPack: boolean;
    hasScripts: boolean;
    rtxEnabled: boolean;
    contentKey?: string;
    subPackName?: string;
    contentId?: string;
}

/** The result of listing packs: the entries to announce and anything worth warning about. */
export interface BuiltEntries {
    entries: PackEntry[];
    warnings: string[];
}

/**
 * The URL clients download packs from: `public_url`, else the address port forwarding made
 * reachable. Without either only players on this machine can use it.
 */
export function publicBaseUrl(config: Config, reachableUrl?: string): { url: string; isDefault: boolean } {
    if (config.web.public_url) return { url: config.web.public_url, isDefault: false };
    if (reachableUrl) return { url: reachableUrl, isDefault: false };
    return { url: `http://127.0.0.1:${config.web.port}`, isDefault: true };
}

/** The URL clients download a pack from. One function, so every place builds it the same way. */
export function packUrl(baseUrl: string, fileName: string): string {
    return `${baseUrl}/packs/${encodeURIComponent(fileName)}`;
}

/**
 * Applies the overrides, drops disabled packs and duplicates, and orders the rest by `order`
 * (lowest first, default 0) and then by file name.
 * @param reachableUrl - Where port forwarding made the web server reachable, used when `public_url` is empty.
 */
export function buildEntries(scanned: ScannedPack[], config: Config, reachableUrl?: string): BuiltEntries {
    const warnings: string[] = [];
    const base = publicBaseUrl(config, reachableUrl).url;
    const known = new Set(scanned.map((p) => p.fileName));
    for (const file of Object.keys(config.overrides)) {
        if (!known.has(file)) warnings.push(`overrides."${file}" matches no pack in the packs folder`);
    }

    const candidates = scanned
        .filter((pack) => config.overrides[pack.fileName]?.enabled !== false)
        .map((pack): PackEntry => {
            const o = config.overrides[pack.fileName] ?? {};
            return {
                fileName: pack.fileName,
                path: pack.path,
                uuid: pack.manifest.uuid,
                version: pack.manifest.version,
                size: pack.size,
                downloadUrl: o.download_url ?? packUrl(base, pack.fileName),
                order: o.order ?? 0,
                addonPack: o.addon_pack ?? pack.manifest.addonPack,
                hasScripts: o.has_scripts ?? pack.manifest.hasScripts,
                rtxEnabled: o.rtx_enabled ?? pack.manifest.rtxEnabled,
                contentKey: o.content_key,
                subPackName: o.sub_pack_name,
                contentId: o.content_id
            };
        })
        .sort((a, b) => a.order - b.order || compareNames(a.fileName, b.fileName));

    const seen = new Map<string, string>();
    const entries: PackEntry[] = [];
    for (const entry of candidates) {
        const first = seen.get(entry.uuid);
        if (first) {
            warnings.push(`${entry.fileName} has the same UUID as ${first}; skipping it`);
            continue;
        }
        seen.set(entry.uuid, entry.fileName);
        entries.push(entry);
    }
    return { entries, warnings };
}

function compareNames(a: string, b: string): number {
    return a.toLowerCase().localeCompare(b.toLowerCase()) || (a < b ? -1 : a > b ? 1 : 0);
}
