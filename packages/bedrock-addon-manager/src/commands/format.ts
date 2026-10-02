import type { PackEntry } from '../packs/entries.ts';

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
    if (entries.length === 0)
        return [
            'No Bedrock packs are listed. Put .mcpack or .mcaddon files in the packs folder and run /baddon reload.'
        ];
    const lines = [`Bedrock packs (${entries.length}), in the order they are listed:`];
    entries.forEach((e, i) => {
        const flags = [e.addonPack && 'add-on pack', e.hasScripts && 'scripts', e.rtxEnabled && 'ray tracing'].filter(
            Boolean
        );
        lines.push(
            `${i + 1}. ${e.fileName}: ${e.uuid} v${e.version}, ${formatSize(e.size)}${flags.length > 0 ? `, ${flags.join(', ')}` : ''}`
        );
        lines.push(`   ${e.downloadUrl}`);
    });
    return lines;
}

/**
 * The line `/baddon reload` prints.
 * @param count - How many packs are listed after the reload.
 * @returns A confirmation.
 */
export function reloadLines(count: number): string[] {
    return [
        `Reloaded the config and rescanned the packs folder: ${count} pack${count === 1 ? '' : 's'} listed. Players who are already connected get them when they rejoin.`
    ];
}
