import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, it } from 'vitest';

const apiRoot = path.resolve(import.meta.dirname, '..');
const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

it('writes guest types for the pinned WIT and keeps an empty cache override out of the working directory', () => {
    const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pumpkin-api-gen-types-'));
    temporaryDirectories.push(workingDirectory);
    const outputDirectory = path.join(workingDirectory, 'types');

    execFileSync(process.execPath, [path.join(apiRoot, 'scripts/gen-types.mjs'), outputDirectory], {
        cwd: workingDirectory,
        env: { ...process.env, PUMPKIN_PLUGINS_CACHE_DIR: '' },
        stdio: 'pipe',
    });

    expect(fs.readFileSync(path.join(outputDirectory, 'index.d.ts'), 'utf8')).toMatch(/pumpkin:plugin\/event@/);
    expect(fs.readdirSync(workingDirectory)).toEqual(['types']);
}, 60_000);
