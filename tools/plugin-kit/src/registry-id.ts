/** Adds Minecraft's default namespace to a bare registry ID. */
export function canonicalRegistryId(id: string): string {
    return id.includes(':') ? id : `minecraft:${id}`;
}
