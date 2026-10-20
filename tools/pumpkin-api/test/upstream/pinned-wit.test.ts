import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { digestWitDirectory, ensurePumpkinWit, parsePumpkinWitPin } from '../../src/wit.mjs';

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const compatibilityDirectory = path.join(apiRoot, 'compatibility');
const witLockFile = path.join(apiRoot, 'wit.lock.json');
const matrixFiles = fs
    .readdirSync(compatibilityDirectory)
    .filter((file) => fs.statSync(path.join(compatibilityDirectory, file)).isFile() && file.endsWith('.json'))
    .sort();
const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

it('resolves the pinned Pumpkin WIT and verifies its active compatibility digests', () => {
    const lockSource = fs.readFileSync(witLockFile, 'utf8');
    const pin = parsePumpkinWitPin(lockSource, witLockFile);
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pumpkin-api-upstream-wit-'));
    temporaryDirectories.push(cacheRoot);
    const witRoot = ensurePumpkinWit({
        lockFile: witLockFile,
        cacheRoot,
    });

    expect(pin.repository).toBe('https://github.com/Pumpkin-MC/pumpkin-plugin-wit');
    expect(pin.branch.length).toBeGreaterThan(0);
    expect(pin.commit).toMatch(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
    expect(pin.subdirectory.length).toBeGreaterThan(0);

    const filenames = fs
        .readdirSync(witRoot)
        .filter((name) => name.endsWith('.wit'))
        .sort();
    expect(filenames.length).toBeGreaterThan(0);
    expect(filenames).toContain('plugin.wit');

    const lockDigest = createHash('sha256').update(lockSource).digest('hex');
    const cachedPin = JSON.parse(fs.readFileSync(path.join(path.dirname(witRoot), 'pin.json'), 'utf8'));
    expect(cachedPin).toMatchObject({ lockDigest, ...pin });

    for (const file of matrixFiles) {
        const matrix = JSON.parse(fs.readFileSync(path.join(compatibilityDirectory, file), 'utf8'));
        expect(matrix.sourceWit).toEqual(pin);
        expect(matrix.sourceWitSha256).toBe(digestWitDirectory(witRoot));
    }
});
