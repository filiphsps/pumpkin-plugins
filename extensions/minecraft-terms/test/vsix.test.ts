import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const extensionRoot = path.resolve(import.meta.dirname, '..');
const sample = path.resolve(extensionRoot, '../../tools/cspell-dict-minecraft/samples/minecraft-terms.md');

describe('Minecraft Terms VSIX', () => {
    let workDir: string;
    let packaged: Record<string, Uint8Array>;

    beforeAll(() => {
        workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-terms-'));
        const vsix = path.join(workDir, 'minecraft-terms.vsix');
        execFileSync('pnpm', ['run', 'build'], { cwd: extensionRoot, stdio: 'pipe' });
        execFileSync('pnpm', ['run', 'package', '--', '--out', vsix], { cwd: extensionRoot, stdio: 'pipe' });
        packaged = unzipSync(fs.readFileSync(vsix));
    }, 120_000);

    afterAll(() => {
        if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
    });

    it('ships every dictionary its cspell config points at', () => {
        const config = JSON.parse(strFromU8(packaged['extension/cspell-ext.json']));
        for (const { path: dictionary } of config.dictionaryDefinitions) {
            expect(packaged, dictionary).toHaveProperty([path.posix.join('extension', dictionary)]);
        }
    });

    it('accepts Minecraft terms through the packaged cspell config', () => {
        const unpacked = path.join(workDir, 'unpacked');
        for (const [name, data] of Object.entries(packaged)) {
            if (!name.startsWith('extension/') || name.endsWith('/')) continue;
            const file = path.join(unpacked, name);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, data);
        }

        // cspell only checks files under its working directory, so lint a copy beside the unpacked VSIX.
        fs.copyFileSync(sample, path.join(unpacked, 'sample.md'));
        const cspell = path.join(extensionRoot, 'node_modules/.bin/cspell');
        // cspell exits non-zero when it finds an unknown word or no file to check.
        expect(() =>
            execFileSync(cspell, ['lint', '--no-progress', '--config', 'extension/cspell-ext.json', 'sample.md'], {
                cwd: unpacked,
                stdio: 'pipe',
            }),
        ).not.toThrow();
    });
});
