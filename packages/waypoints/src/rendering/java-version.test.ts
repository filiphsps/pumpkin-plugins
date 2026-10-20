import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, inject, it } from 'vitest';
import { JAVA_DISPLAY_VERSION } from './java-version.ts';

it('targets the newest Java version in the pinned Pumpkin WIT', () => {
    const playerWit = fs.readFileSync(path.join(inject('pumpkinWitDir'), 'player.wit'), 'utf8');
    const body = /enum java-minecraft-version \{([^}]*)\}/.exec(playerWit)?.[1];
    if (body === undefined) throw new Error('player.wit has no java-minecraft-version enum');
    const versions = body
        .split(',')
        .map((variant) => variant.replace(/\/\/.*$/gm, '').trim())
        .filter((variant) => variant !== '' && variant !== 'unknown');

    expect(versions.at(-1)).toBe(JAVA_DISPLAY_VERSION);
});
