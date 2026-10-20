import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { packAndInspect, sourcePrerequisitePaths } from './tool-packages.mjs';

const temporaryDirectories = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-packages-test-'));
    temporaryDirectories.push(directory);
    return directory;
}

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 4)}\n`);
}

describe('packAndInspect', () => {
    it('packs a package and reads its entries, embedded manifests and SRI from the tarball', () => {
        const root = temporaryDirectory();
        const packageDirectory = path.join(root, 'demo');
        const destination = path.join(root, 'packed');
        fs.mkdirSync(destination);
        writeJson(path.join(packageDirectory, 'package.json'), {
            name: '@example/demo',
            version: '1.2.3',
            files: ['src', 'templates'],
        });
        fs.mkdirSync(path.join(packageDirectory, 'src'));
        fs.writeFileSync(path.join(packageDirectory, 'src', 'index.js'), 'export {};\n');
        fs.writeFileSync(path.join(packageDirectory, 'notes.txt'), 'not packed\n');
        writeJson(path.join(packageDirectory, 'templates', 'starter', 'package.json'), {
            name: 'starter',
            dependencies: { '@example/demo': '^1.2.3' },
        });
        // A second tarball whose name starts with the same prefix must not be picked up.
        fs.writeFileSync(path.join(destination, 'example-demo-extra-9.9.9.tgz'), 'decoy');

        const packed = packAndInspect(packageDirectory, destination);

        assert.equal(path.dirname(packed.tarballPath), destination);
        assert.match(path.basename(packed.tarballPath), /^example-demo-1\.2\.3\.tgz$/);
        assert.ok(packed.entries.includes('package/src/index.js'));
        assert.ok(!packed.entries.includes('package/notes.txt'));
        assert.equal(packed.packageJson.name, '@example/demo');
        assert.deepEqual(packed.embeddedPackageJsons, [
            { name: 'starter', dependencies: { '@example/demo': '^1.2.3' } },
        ]);
        const digest = createHash('sha512').update(fs.readFileSync(packed.tarballPath)).digest('base64');
        assert.equal(packed.integrity, `sha512-${digest}`);
    });

    it('packs a package whose prepack script prints build output to stdout', () => {
        const root = temporaryDirectory();
        const packageDirectory = path.join(root, 'demo');
        const destination = path.join(root, 'packed');
        fs.mkdirSync(destination);
        // A prepack that runs turbo prints its run summary on pnpm pack's stdout.
        writeJson(path.join(packageDirectory, 'package.json'), {
            name: '@example/demo',
            version: '1.2.3',
            scripts: { prepack: `node -e "console.log('Packages in scope: @example/demo')"` },
        });

        const packed = packAndInspect(packageDirectory, destination);

        assert.equal(packed.tarballPath, path.join(destination, 'example-demo-1.2.3.tgz'));
        assert.deepEqual(fs.readdirSync(destination), ['example-demo-1.2.3.tgz']);
    });
});

describe('sourcePrerequisitePaths', () => {
    it('follows npm files globs where ** matches zero directories', () => {
        const root = temporaryDirectory();
        writeJson(path.join(root, 'tools/starter/package.json'), {
            name: '@example/starter',
            files: ['templates/**/package.json', '!templates/ignored/**'],
        });
        writeJson(path.join(root, 'tools/starter/templates/package.json'), {
            dependencies: { '@example/build': '^1.0.0' },
        });
        writeJson(path.join(root, 'tools/starter/templates/ignored/package.json'), {
            dependencies: { '@example/docs': '^1.0.0' },
        });
        const pathsByName = new Map([
            ['@example/build', 'tools/build'],
            ['@example/docs', 'tools/docs'],
        ]);

        assert.deepEqual(sourcePrerequisitePaths(root, 'tools/starter', pathsByName), new Set(['tools/build']));
    });
});
