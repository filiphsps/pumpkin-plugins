import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { compareVersions, packAndInspect } from './tool-packages.mjs';

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

describe('compareVersions', () => {
    it('compares releases, prereleases, and build metadata by semver precedence', () => {
        assert.ok(compareVersions('1.2.3', '1.2.2') > 0);
        assert.ok(compareVersions('v1.2.3-rc.2', '1.2.3-rc.10') < 0);
        assert.ok(compareVersions('1.2.3-rc.1', '1.2.3') < 0);
        assert.equal(compareVersions('1.2.3+build.1', 'v1.2.3+build.2'), 0);
    });

    it('rejects values that are not semantic versions', () => {
        assert.throws(() => compareVersions('1.2', '1.2.3'), /Invalid semantic version/);
    });
});

describe('packAndInspect', () => {
    it('reads the packed manifest and entries from the tarball it created', () => {
        const root = temporaryDirectory();
        const packageDirectory = path.join(root, 'demo');
        const destination = path.join(root, 'packed');
        fs.mkdirSync(destination);
        writeJson(path.join(packageDirectory, 'package.json'), {
            name: '@example/demo',
            version: '1.2.3',
            files: ['src'],
        });
        fs.mkdirSync(path.join(packageDirectory, 'src'));
        fs.writeFileSync(path.join(packageDirectory, 'src', 'index.js'), 'export {};\n');
        fs.writeFileSync(path.join(destination, 'example-demo-extra-9.9.9.tgz'), 'decoy');

        const packed = packAndInspect(packageDirectory, destination);

        assert.equal(packed.packageJson.name, '@example/demo');
        assert.ok(packed.entries.includes('package/src/index.js'));
        assert.equal(packed.embeddedPackageJsons.length, 0);
        assert.equal(path.dirname(packed.tarballPath), destination);
        assert.ok(fs.existsSync(path.join(destination, 'example-demo-extra-9.9.9.tgz')));
    });
});
