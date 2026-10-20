import type { PackEntry } from '../packs/entries.ts';

const NO_PACKS =
    'No Bedrock packs are listed. Put .mcpack or .mcaddon files in the packs folder and run /baddon reload.';

/** A TOML basic string. JSON string escapes are valid TOML escapes. */
const tomlString = (value: string) => JSON.stringify(value);

/**
 * Formats a byte count for people.
 * @param bytes - A size in bytes.
 * @returns For example `512 B`, `4.9 MiB`.
 */
export function formatSize(bytes: number): string {
    const units = ['B', 'KiB', 'MiB', 'GiB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

/**
 * The lines `/baddon list` prints.
 * @param entries - The packs currently listed.
 * @returns One string per chat line.
 */
export function listLines(entries: readonly PackEntry[]): string[] {
    if (entries.length === 0) return [NO_PACKS];
    const lines = [`Bedrock packs (${entries.length}), in the order they are listed:`];
    entries.forEach((e, i) => {
        const flags = [e.addonPack && 'add-on pack', e.hasScripts && 'scripts', e.rtxEnabled && 'ray tracing'].filter(
            Boolean,
        );
        lines.push(
            `${i + 1}. ${e.fileName}: ${e.uuid} v${e.version}, ${formatSize(e.size)}${flags.length > 0 ? `, ${flags.join(', ')}` : ''}`,
        );
        lines.push(`   ${e.downloadUrl}`);
    });
    return lines;
}

/**
 * The lines `/baddon export` prints: a `[resource_pack.bedrock]` block for `pumpkin.toml`, with one
 * `[[resource_pack.bedrock.packs]]` table per pack in list order. Pumpkin reads it on start and
 * offers those packs to Bedrock players when they join.
 * @param entries - The packs currently listed.
 * @param force - `packs.force`: players must accept the packs to join.
 * @returns One string per line of TOML, or a note when there are no packs.
 */
export function exportLines(entries: readonly PackEntry[], force: boolean): string[] {
    if (entries.length === 0) return [NO_PACKS];
    const lines = ['[resource_pack.bedrock]', 'enabled = true', `force = ${force}`];
    for (const e of entries) {
        lines.push(
            '',
            '[[resource_pack.bedrock.packs]]',
            `uuid = ${tomlString(e.uuid)}`,
            `version = ${tomlString(e.version)}`,
            `size = ${e.size}`,
            `download_url = ${tomlString(e.downloadUrl)}`,
            `has_scripts = ${e.hasScripts}`,
            `addon_pack = ${e.addonPack}`,
            `rtx_enabled = ${e.rtxEnabled}`,
        );
        if (e.subPackName !== undefined) lines.push(`sub_pack_name = ${tomlString(e.subPackName)}`);
        if (e.contentKey !== undefined) lines.push(`content_key = ${tomlString(e.contentKey)}`);
        if (e.contentId !== undefined) lines.push(`content_id = ${tomlString(e.contentId)}`);
    }
    return lines;
}

/**
 * The line `/baddon reload` prints.
 * @param count - How many packs are listed after the reload.
 * @returns A confirmation.
 */
export function reloadLines(count: number): string[] {
    return [`Reloaded the config and rescanned the packs folder: ${count} pack${count === 1 ? '' : 's'} listed.`];
}
