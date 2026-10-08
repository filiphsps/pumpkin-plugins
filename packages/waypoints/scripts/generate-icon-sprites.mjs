import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { strFromU8, unzipSync } from 'fflate';

// Only texture identifiers are emitted; no Minecraft artwork is copied.
const assets = unzipSync(readFileSync(process.argv[2]));
const sprites = {};
/** Resolves inherited item model textures from the supplied Minecraft client archive. */
function textures(model, seen = new Set()) {
    if (seen.has(model)) return {};
    seen.add(model);
    const bytes = assets[`assets/minecraft/models/${model}.json`];
    if (bytes === undefined) return {};
    const definition = JSON.parse(strFromU8(bytes));
    return {
        ...textures((definition.parent ?? '').replace(/^minecraft:/, ''), seen),
        ...definition.textures
    };
}
for (const file of Object.keys(assets).sort()) {
    if (!file.startsWith('assets/minecraft/items/') || !file.endsWith('.json')) continue;
    const item = file.slice('assets/minecraft/items/'.length, -5);
    if (assets[`assets/minecraft/textures/item/${item}.png`] !== undefined) continue;
    const modelTextures = textures(`item/${item}`);
    for (const key of ['layer0', 'particle', 'all', 'side', 'top']) {
        let sprite = modelTextures[key];
        const seen = new Set();
        while (sprite?.startsWith('#') && !seen.has(sprite)) {
            seen.add(sprite);
            sprite = modelTextures[sprite.slice(1)];
        }
        sprite = sprite?.replace(/^minecraft:/, '');
        if (sprite && assets[`assets/minecraft/textures/${sprite}.png`] !== undefined) {
            sprites[item] = sprite;
            break;
        }
    }
}
const output = fileURLToPath(new URL('../src/rendering/icon-sprites.ts', import.meta.url));
writeFileSync(
    output,
    '// Generated from Minecraft 26.3 by scripts/generate-icon-sprites.mjs.\n' +
        '/** Vanilla items whose representative sprite differs from item/<registry path>. */\n' +
        `export const BLOCK_ICON_SPRITES: Readonly<Record<string, string>> = ${JSON.stringify(sprites, null, 4)};\n`
);
execFileSync('pnpm', ['exec', 'biome', 'format', '--write', output]);
