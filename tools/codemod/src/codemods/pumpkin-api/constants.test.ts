import fs from 'node:fs/promises';
import semver from 'semver';
import { describe, expect, it } from 'vitest';
import { API_VERSION_RANGE, BUILD_VERSION_RANGE } from './constants.js';

async function workspaceVersion(tool: string): Promise<string> {
    const manifest = JSON.parse(
        await fs.readFile(new URL(`../../../../${tool}/package.json`, import.meta.url), 'utf8'),
    );
    return manifest.version;
}

describe('added dependency ranges', () => {
    it.each([
        ['pumpkin-api', API_VERSION_RANGE],
        ['build', BUILD_VERSION_RANGE],
    ])('cover the current %s release', async (tool, range) => {
        expect(semver.satisfies(await workspaceVersion(tool), range)).toBe(true);
    });
});
