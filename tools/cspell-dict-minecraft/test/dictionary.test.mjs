import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const words = new Set(
    readFileSync(join(packageRoot, 'minecraft.txt'), 'utf8')
        .split(/\r?\n/)
        .map((word) => word.trim().toLowerCase())
        .filter((word) => word && !word.startsWith('#')),
);

describe('Minecraft dictionary', () => {
    it('contains standard Minecraft terms', () => {
        for (const word of ['creeper', 'enderman', 'netherite', 'overworld', 'redstone', 'shulker']) {
            assert.ok(words.has(word), `${word} should be accepted`);
        }
    });

    it('does not include PumpkinMC-specific vocabulary', () => {
        for (const word of ['pumpkinmc', 'pumpkinapi', 'pumpkinserver']) {
            assert.ok(!words.has(word), `${word} should stay outside the Minecraft dictionary`);
        }
    });
});
