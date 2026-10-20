import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';

const { default: defineGenerators } = await import('../turbo/generators/config.ts');

const workspaceRoot = path.resolve(import.meta.dirname, '..');
const temporaryRoots = [];
// The pnpm stub below is a POSIX shell script.
const skipOnWindows = process.platform === 'win32' && 'the pnpm stub is a shell script';

after(() => {
    for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true });
});

/**
 * Runs a generator against a scratch root that holds copies of the root files it reads. pnpm is
 * replaced by a stub that records its arguments, so nothing is installed or formatted. `prepare`
 * can change the scratch root before the generator runs.
 */
function generate(generatorName, args, prepare) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'generator-'));
    temporaryRoots.push(root);
    fs.symlinkSync(path.join(workspaceRoot, 'scripts'), path.join(root, 'scripts'));
    for (const file of [
        'package.json',
        'LICENSE',
        'turbo.json',
        'pnpm-workspace.yaml',
        'release-please-config.json',
        '.release-please-manifest.json',
    ]) {
        fs.copyFileSync(path.join(workspaceRoot, file), path.join(root, file));
    }
    const bin = path.join(root, '.stub-bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'pnpm'), '#!/bin/sh\necho "$*" >> "$(dirname "$0")/calls"\n', { mode: 0o755 });
    prepare?.(root);

    execFileSync(
        process.execPath,
        [
            path.join(workspaceRoot, 'node_modules/@turbo/gen/dist/cli.js'),
            'run',
            generatorName,
            '--config',
            path.join(workspaceRoot, 'turbo/generators/config.ts'),
            '--root',
            root,
            '--args',
            ...args,
        ],
        {
            cwd: root,
            stdio: 'pipe',
            env: {
                ...process.env,
                PATH: `${bin}${path.delimiter}${process.env.PATH}`,
                // Lets the repository scripts the generator runs work on the scratch root.
                PUMPKIN_PLUGINS_ROOT: root,
            },
        },
    );
    return root;
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function getPluginDescriptionValidator() {
    const generators = new Map();
    defineGenerators({
        setHelper() {},
        setGenerator(name, definition) {
            generators.set(name, definition);
        },
    });

    const descriptionPrompt = generators.get('plugin').prompts.find(({ name }) => name === 'description');
    return descriptionPrompt.validate;
}

test('plugin generator rejects multiline descriptions and accepts a one-line description', () => {
    const validate = getPluginDescriptionValidator();

    assert.equal(validate('First line\nSecond line'), 'Enter a one-line description');
    assert.equal(validate('First line\rSecond line'), 'Enter a one-line description');
    assert.equal(validate('A valid plugin description'), true);
});

test('plugin generator accepts a description of exactly 70 characters and rejects a longer one', () => {
    const validate = getPluginDescriptionValidator();

    assert.equal(validate('x'.repeat(70)), true);
    assert.match(validate('x'.repeat(71)), /at most 70 characters/);
});

test('a generated plugin defines the parse-ts build every plugin needs', { skip: skipOnWindows }, () => {
    const root = generate('plugin', ['my-plugin', 'MyPlugin', 'Does a thing']);
    const manifest = readJson(path.join(root, 'packages/my-plugin/package.json'));

    // scripts/build.test.mjs asserts the same script for every plugin in packages/.
    assert.equal(manifest.scripts['build:parse-ts'], 'pumpkin-plugins-build --parse-ts');
});

test('a generated plugin gets the turbo.json that restores its generated types', { skip: skipOnWindows }, () => {
    const root = generate('plugin', ['my-plugin', 'MyPlugin', 'Does a thing']);
    const turbo = readJson(path.join(root, 'packages/my-plugin/turbo.json'));

    assert.ok(turbo.tasks.typecheck.outputs.length > 0);
});

test('the starter command is named after the plugin, not the built-in /plugin', { skip: skipOnWindows }, () => {
    const root = generate('plugin', ['my-plugin', 'MyPlugin', 'Does a thing']);
    const spec = fs.readFileSync(path.join(root, 'packages/my-plugin/src/commands/spec.ts'), 'utf8');
    const itest = fs.readFileSync(path.join(root, 'packages/my-plugin/test/plugin.itest.ts'), 'utf8');

    assert.match(spec, /["']my-plugin["']\s*:\s*\{/);
    assert.match(spec, /:command\.my-plugin`/);
    assert.doesNotMatch(spec, /\bplugin\s*:\s*\{/);
    assert.match(itest, /server\.command\(["']my-plugin["']\)/);
});

test('a generated extension supports the @types/vscode version in the catalog', { skip: skipOnWindows }, () => {
    const root = generate('extension', ['my-extension', 'My Extension', 'Does a thing'], (scratch) => {
        const workspaceFile = path.join(scratch, 'pnpm-workspace.yaml');
        const workspace = fs.readFileSync(workspaceFile, 'utf8');
        fs.writeFileSync(workspaceFile, workspace.replace(/("@types\/vscode":) .*/, '$1 1.999.0'));
    });
    const manifest = readJson(path.join(root, 'extensions/my-extension/package.json'));

    // vsce refuses to package when @types/vscode is newer than engines.vscode.
    assert.equal(manifest.engines.vscode, '^1.999.0');
});

test('a generated extension README keeps the display name and description as typed', { skip: skipOnWindows }, () => {
    const root = generate('extension', ['my-extension', 'Terms & Tools', 'Looks up <terms> & tools']);
    const readme = fs.readFileSync(path.join(root, 'extensions/my-extension/README.md'), 'utf8');

    // scripts/check-docs.mjs requires the README to mention the package.json displayName.
    assert.match(readme, /^# Terms & Tools$/m);
    assert.match(readme, /^Looks up <terms> & tools$/m);
});

/** Moves the scratch root to another owner and repository, so derived metadata can be told apart. */
function moveToAnotherOwner(root) {
    const manifestFile = path.join(root, 'package.json');
    const manifest = readJson(manifestFile);
    Object.assign(manifest, {
        homepage: 'https://github.com/example/fork',
        bugs: { url: 'https://github.com/example/fork/issues' },
        repository: { type: 'git', url: 'git+https://github.com/example/fork.git' },
        funding: [{ type: 'github', url: 'https://github.com/sponsors/example' }],
        author: 'Example Person <person@example.com> (https://example.com)',
        contributors: ['Example Person <person@example.com> (https://example.com)'],
    });
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    const license = fs.readFileSync(path.join(root, 'LICENSE'), 'utf8');
    fs.writeFileSync(
        path.join(root, 'LICENSE'),
        license.replace(/^Copyright .*$/m, 'Copyright (c) 2026 Example Person'),
    );
}

test('generated plugins and extensions take owner metadata from the root package', { skip: skipOnWindows }, () => {
    const pluginRoot = generate('plugin', ['my-plugin', 'MyPlugin', 'Does a thing'], moveToAnotherOwner);
    const extensionRoot = generate('extension', ['my-extension', 'My Extension', 'Does a thing'], moveToAnotherOwner);

    for (const [root, dir] of [
        [pluginRoot, 'packages/my-plugin'],
        [extensionRoot, 'extensions/my-extension'],
    ]) {
        const manifest = readJson(path.join(root, dir, 'package.json'));
        assert.equal(manifest.homepage, `https://github.com/example/fork/tree/master/${dir}#readme`);
        assert.deepEqual(manifest.bugs, { url: 'https://github.com/example/fork/issues' });
        assert.deepEqual(manifest.repository, {
            type: 'git',
            url: 'git+https://github.com/example/fork.git',
            directory: dir,
        });
        assert.equal(manifest.license, 'MIT');
        assert.equal(manifest.author, 'Example Person <person@example.com> (https://example.com)');
        assert.deepEqual(manifest.contributors, ['Example Person <person@example.com> (https://example.com)']);
        assert.deepEqual(manifest.funding, [{ type: 'github', url: 'https://github.com/sponsors/example' }]);
    }
    const extensionLicense = fs.readFileSync(path.join(extensionRoot, 'extensions/my-extension/LICENSE'), 'utf8');
    assert.match(extensionLicense, /^Copyright \(c\) 2026 Example Person$/m);
});

test('a generated action names the root package author', { skip: skipOnWindows }, () => {
    const root = generate('action', ['my-action', 'My Action', 'Does a thing'], moveToAnotherOwner);
    const action = fs.readFileSync(path.join(root, 'actions/my-action/action.yml'), 'utf8');

    assert.match(action, /^author: "?Example Person"?$/m);
});

test('each generator registers its component for releases in sorted order', { skip: skipOnWindows }, () => {
    for (const [generatorName, args, dir, entry] of [
        ['plugin', ['my-plugin', 'MyPlugin', 'Does a thing'], 'packages/my-plugin', {}],
        ['action', ['my-action', 'My Action', 'Does a thing'], 'actions/my-action', { 'release-type': 'simple' }],
        ['extension', ['my-extension', 'My Extension', 'Does a thing'], 'extensions/my-extension', {}],
    ]) {
        const root = generate(generatorName, args);
        const config = readJson(path.join(root, 'release-please-config.json'));
        const manifest = readJson(path.join(root, '.release-please-manifest.json'));
        const component = dir.split('/')[1];

        assert.deepEqual(config.packages[dir], { component, ...entry, 'release-as': '0.0.1' });
        assert.equal(manifest[dir], '0.0.0');
        for (const keys of [Object.keys(config.packages), Object.keys(manifest)]) {
            assert.deepEqual(keys, keys.toSorted(), `${generatorName} keeps release entries sorted`);
        }
    }
});
