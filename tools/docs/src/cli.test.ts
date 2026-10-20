import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const BIN = path.resolve(import.meta.dirname, '../bin/pumpkin-plugins-docs.mjs');
let dir: string;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-test-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const put = (rel: string, content: string) => {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
};
const read = (rel: string) => fs.readFileSync(path.join(dir, rel), 'utf8');
const run = (cwd: string, ...args: string[]) => spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });

const plugin = (name: string, description: string, extra = '') =>
    `export const info = { name: ${JSON.stringify(name)}, description: ${JSON.stringify(description)}${extra} };\n`;

const README = `# Demo

<!-- docs:begin summary -->
<!-- docs:end summary -->

## Installation

Hand-written words.

<!-- docs:begin commands -->
<!-- docs:end commands -->
`;

describe('plugin README', { timeout: 15000 }, () => {
    beforeEach(() => {
        put('p/package.json', '{"name":"@x/p","version":"1.0.0","type":"module"}');
        put('p/README.md', README);
        put(
            'p/src/info.ts',
            plugin('Demo', 'Does demo things.', ', commands: [{ usage: "/demo list", description: "List" }]'),
        );
    });

    it('fills the blocks, keeps hand-written prose on rerun, and picks up code changes', () => {
        const p = path.join(dir, 'p');
        const generated = run(p);
        expect(generated.status).toBe(0);
        const firstReadme = read('p/README.md');
        expect(firstReadme).toContain('| `/demo list` | List | none |');

        put('p/README.md', firstReadme.replace('Hand-written words.', 'My own words.'));
        const unchanged = run(p);
        expect(unchanged.status).toBe(0);
        const preservedReadme = read('p/README.md');
        expect(preservedReadme).toBe(firstReadme.replace('Hand-written words.', 'My own words.'));

        put(
            'p/src/info.ts',
            plugin(
                'Demo',
                'Does demo things.',
                ', commands: [{ usage: "/demo list", description: "List" }, { usage: "/demo reload", description: "Reload" }]',
            ),
        );
        const updated = run(p);
        expect(updated.status).toBe(0);
        const updatedReadme = read('p/README.md');
        expect(updatedReadme).toContain('`/demo reload`');
        expect(updatedReadme).toContain('My own words.');
    });

    it('fills the blocks a plugin declares itself, where the README has markers for them', () => {
        const p = path.join(dir, 'p');
        put('p/README.md', `${README}\n<!-- docs:begin routers -->\n<!-- docs:end routers -->\n`);
        put('p/src/info.ts', plugin('Demo', 'Does demo things.', ', blocks: { routers: "| Telekom |", unused: "x" }'));
        expect(run(p).status).toBe(0);
        const generatedReadme = read('p/README.md');
        expect(generatedReadme).toContain('<!-- docs:begin routers -->\n<!-- Generated');
        expect(generatedReadme).toContain('| Telekom |');
        expect(generatedReadme).not.toContain('unused');
    });

    it('tells readers how to get the plugin while it is paused and after it is released', () => {
        const p = path.join(dir, 'p');
        put(
            'p/package.json',
            '{"name":"@x/p","version":"1.0.0","type":"module","pumpkinPlugin":{"output":"build/demo.wasm"}}',
        );
        put('p/README.md', `${README}\n<!-- docs:begin installation -->\n<!-- docs:end installation -->\n`);
        put('release-please-paused.json', '{"p":"Players can not see its output yet."}');

        expect(run(p).status).toBe(0);
        const paused = read('p/README.md');
        expect(paused).toContain("hasn't been released");
        expect(paused).toContain('Players can not see its output yet.');
        expect(paused).toContain('`pnpm build --filter @x/p`');
        expect(paused).not.toContain('GitHub release');

        put('release-please-paused.json', '{}');
        expect(run(p, '--check').status).toBe(1);
        expect(run(p).status).toBe(0);
        const released = read('p/README.md');
        expect(released).toContain("Download `demo.wasm` from the plugin's GitHub release");
        expect(released).not.toContain("hasn't been released");
    });

    it('accepts the explicit plugin command', () => {
        const result = run(path.join(dir, 'p'), 'plugin');

        expect(result.status).toBe(0);
        expect(read('p/README.md')).toContain('| `/demo list` | List | none |');
    });

    it('--check fails on a stale README and never writes', () => {
        const p = path.join(dir, 'p');
        const beforeStaleCheck = read('p/README.md');
        const stale = run(p, '--check');
        expect(stale.status).toBe(1);
        expect(read('p/README.md')).toBe(beforeStaleCheck);

        expect(run(p).status).toBe(0);
        const generatedReadme = read('p/README.md');
        const unchanged = run(p, '--check');
        expect(unchanged.status).toBe(0);
        expect(read('p/README.md')).toBe(generatedReadme);
        put('p/src/info.ts', plugin('Demo', 'Changed.'));
        const beforeStaleAfterChange = read('p/README.md');
        const staleAfterChange = run(p, '--check');
        expect(staleAfterChange.status).toBe(1);
        expect(read('p/README.md')).toBe(beforeStaleAfterChange);
    });

    it('asks for a README instead of inventing one', () => {
        fs.rmSync(path.join(dir, 'p/README.md'));
        const r = run(path.join(dir, 'p'));
        expect(r.status).toBe(1);
        expect(fs.existsSync(path.join(dir, 'p/README.md'))).toBe(false);
    });

    it('leaves the README unchanged when the info module is missing', () => {
        fs.rmSync(path.join(dir, 'p/src/info.ts'));
        const before = read('p/README.md');
        const r = run(path.join(dir, 'p'));
        expect(r.status).toBe(1);
        expect(read('p/README.md')).toBe(before);
    });
});

describe('root README', { timeout: 15000 }, () => {
    const readme =
        '# Repo\n\n<!-- docs:begin docs-site -->\n<!-- docs:end docs-site -->\n\n<!-- docs:begin packages -->\n<!-- docs:end packages -->\n\nAfter.\n';
    beforeEach(() => {
        put('pnpm-workspace.yaml', 'packages: []\n');
        put('package.json', '{"repository":"https://github.com/example/repo"}');
        put('README.md', readme);
        put('LICENSE', 'Root MIT license');
        put(
            'packages/alpha/package.json',
            '{"name":"@x/alpha","description":"ignored, info wins","license":"MIT","type":"module"}',
        );
        put('packages/alpha/src/info.ts', plugin('Alpha', 'Alpha plugin.'));
        put('packages/beta/package.json', '{"name":"@x/beta","description":"Beta from package.json","license":"MIT"}');
        put('tools/build/package.json', '{"name":"@x/build","description":"Builds","license":"MIT"}');
        put(
            'extensions/minecraft-terms/package.json',
            '{"name":"code-spell-checker-minecraft","displayName":"Minecraft Terms","description":"Minecraft vocabulary for Code Spell Checker.","license":"MIT"}',
        );
        put(
            'extensions/minecraft-terms/README.md',
            '# Minecraft Terms\n\n<!-- docs:begin reference -->\n<!-- docs:end reference -->\n',
        );
        put('extensions/minecraft-terms/src/extension.ts', 'export function activate() {}\n');
    });

    it('has one linked row per package folder and follows additions', () => {
        const generated = run(dir, 'root');
        expect(generated.status).toBe(0);
        const first = read('README.md');
        expect(first).toContain('| [Alpha](packages/alpha) | Alpha plugin. | MIT |');
        expect(first).toContain('| [@x/beta](packages/beta) | Beta from package.json | MIT |');
        expect(first).toContain('| [@x/build](tools/build) | Builds | MIT |');
        expect(first).toContain(
            '| [Minecraft Terms](extensions/minecraft-terms) | Minecraft vocabulary for Code Spell Checker. | MIT |',
        );
        expect(read('extensions/minecraft-terms/README.md')).toContain('/api/extensions/minecraft-terms/');
        expect(first).toContain('After.');
        expect(first.match(/^\| \[/gm)).toHaveLength(4);

        put('packages/gamma/package.json', '{"name":"@x/gamma","description":"Gamma"}');
        const beforeStaleCheck = read('README.md');
        const stale = run(dir, 'root', '--check');
        expect(stale.status).toBe(1);
        expect(read('README.md')).toBe(beforeStaleCheck);
        const expanded = run(dir, 'root');
        expect(expanded.status).toBe(0);
        const expandedReadme = read('README.md');
        expect(expandedReadme.match(/^\| \[/gm)).toHaveLength(5);
        expect(expandedReadme).toContain('[@x/gamma](packages/gamma)');

        fs.rmSync(path.join(dir, 'packages/beta'), { recursive: true });
        expect(run(dir, 'root').status).toBe(0);
        const removedReadme = read('README.md');
        expect(removedReadme).not.toContain('beta');
        const unchanged = run(dir, 'root', '--check');
        expect(unchanged.status).toBe(0);
        expect(read('README.md')).toBe(removedReadme);
    });

    it('marks paused plugins as unreleased', () => {
        put('release-please-paused.json', '{"packages/alpha":"Not verified on a client yet."}');
        expect(run(dir, 'root').status).toBe(0);
        const generated = read('README.md');
        expect(generated).toContain('| [Alpha](packages/alpha) (unreleased) | Alpha plugin. | MIT |');
        expect(generated).toContain('| [@x/beta](packages/beta) | Beta from package.json | MIT |');
    });

    it('lists action metadata and detects changes without writing in check mode', () => {
        put(
            'actions/sign/action.yml',
            'name: Sign plugin\ndescription: Add the plugin release signature\nruns:\n  using: node24\n',
        );
        put('actions/sign/README.md', '# Sign plugin\n');
        put('actions/not-an-action/README.md', '# Not an action\n');

        const updatedRoot = run(dir, 'root');
        expect(updatedRoot.status).toBe(0);
        const generatedReadme = read('README.md');
        expect(generatedReadme).toContain('**Actions**');
        expect(generatedReadme).toContain('| [Sign plugin](actions/sign) | Add the plugin release signature |');
        expect(generatedReadme.indexOf('**Actions**')).toBeLessThan(generatedReadme.indexOf('**Plugins**'));
        expect(generatedReadme).not.toContain('not-an-action');
        const unchanged = run(dir, 'root', '--check');
        expect(unchanged.status).toBe(0);
        expect(read('README.md')).toBe(generatedReadme);

        put(
            'actions/sign/action.yml',
            'name: Sign plugin\ndescription: Verify the plugin release signature\nruns:\n  using: node24\n',
        );
        const stale = run(dir, 'root', '--check');
        expect(stale.status).toBe(1);
        expect(read('README.md')).toBe(generatedReadme);
        expect(run(dir, 'root').status).toBe(0);
        const updatedReadme = read('README.md');
        expect(updatedReadme).toContain('| [Sign plugin](actions/sign) | Verify the plugin release signature |');
    });

    it('parses quoted and folded action metadata and preserves the README on invalid metadata', () => {
        put('actions/quoted/action.yaml', "name: \"A: B\"\ndescription: 'Action with a ''quote'''\n");
        put('actions/folded/action.yml', 'name: Folded\ndescription: >-\n  Action with\n  folded words\n');
        expect(run(dir, 'root').status).toBe(0);
        const generatedReadme = read('README.md');
        expect(generatedReadme).toContain("| [A: B](actions/quoted) | Action with a 'quote' |");
        expect(generatedReadme).toContain('| [Folded](actions/folded) | Action with folded words |');

        put('actions/broken/action.yml', 'name: Broken\nruns:\n  using: node24\n');
        const beforeFailure = read('README.md');
        const result = run(dir, 'root');
        expect(result.status).toBe(1);
        expect(read('README.md')).toBe(beforeFailure);
    });

    it.each(['LICENSE', 'LICENSE.md', 'license.txt'])(
        'links local %s files in both tables and detects their removal',
        (file) => {
            put('packages/alpha/package.json', '{"name":"@x/alpha","license":"LGPL-3.0-only"}');
            put(`packages/alpha/${file}`, 'Plugin license');
            put(`tools/build/${file}`, 'Tool license');
            expect(run(dir, 'root').status).toBe(0);
            const generated = read('README.md');
            expect(generated).toContain(
                `| [Alpha](packages/alpha) | Alpha plugin. | [LGPL-3.0-only](packages/alpha/${file}) |`,
            );
            expect(generated).toContain(`| [@x/build](tools/build) | Builds | [MIT](tools/build/${file}) |`);
            expect(generated).toContain('| [@x/beta](packages/beta) | Beta from package.json | MIT |');
            expect(run(dir, 'root', '--check').status).toBe(0);

            fs.rmSync(path.join(dir, 'packages/alpha', file));
            fs.rmSync(path.join(dir, 'tools/build', file));
            expect(run(dir, 'root', '--check').status).toBe(1);
            expect(read('README.md')).toBe(generated);
            expect(run(dir, 'root').status).toBe(0);
            expect(read('README.md')).toContain('| [Alpha](packages/alpha) | Alpha plugin. | LGPL-3.0-only |');
            expect(read('README.md')).toContain('| [@x/build](tools/build) | Builds | MIT |');
        },
    );

    it('ignores a directory named LICENSE and detects license metadata changes', () => {
        put('packages/alpha/LICENSE/note.txt', 'Not a license file');
        expect(run(dir, 'root').status).toBe(0);
        const generated = read('README.md');
        expect(generated).toContain('| [Alpha](packages/alpha) | Alpha plugin. | MIT |');
        put('packages/alpha/package.json', '{"name":"@x/alpha","license":"Apache-2.0"}');
        expect(run(dir, 'root', '--check').status).toBe(1);
        expect(read('README.md')).toBe(generated);
        expect(run(dir, 'root').status).toBe(0);
        expect(read('README.md')).toContain('| [Alpha](packages/alpha) | Alpha plugin. | Apache-2.0 |');
    });

    it('requires the marker and the repo root', () => {
        const readmeWithoutMarkers = '# no markers\n';
        put('README.md', readmeWithoutMarkers);
        expect(run(dir, 'root').status).toBe(1);
        expect(read('README.md')).toBe(readmeWithoutMarkers);
        fs.rmSync(path.join(dir, 'pnpm-workspace.yaml'));
        expect(run(dir, 'root').status).toBe(1);
        expect(read('README.md')).toBe(readmeWithoutMarkers);
    });
});

describe('custom document CLI', { timeout: 15000 }, () => {
    it('loads a typed document module, checks drift, and rejects unsupported arguments', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-custom-cli-'));
        try {
            const readme = '# Custom\n<!-- docs:begin facts -->\nold\n<!-- docs:end facts -->\n';
            fs.writeFileSync(path.join(root, 'README.md'), readme);
            fs.writeFileSync(
                path.join(root, 'docs.ts'),
                'export const documents = [{ file: "README.md", blocks: { facts: "Fresh" }, note: "" }];',
            );
            const stale = run(root, 'generate', 'docs.ts', '--check');
            expect(stale.status).toBe(1);
            expect(fs.readFileSync(path.join(root, 'README.md'), 'utf8')).toBe(readme);
            const generated = run(root, 'generate', 'docs.ts');
            expect(generated.status).toBe(0);
            const generatedReadme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
            expect(generatedReadme).toContain('Fresh');
            const unchanged = run(root, 'generate', 'docs.ts', '--check');
            expect(unchanged.status).toBe(0);
            expect(fs.readFileSync(path.join(root, 'README.md'), 'utf8')).toBe(generatedReadme);
            const unsupported = run(root, 'generate', 'docs.ts', '--unknown');
            expect(unsupported.status).toBe(1);
            expect(fs.readFileSync(path.join(root, 'README.md'), 'utf8')).toBe(generatedReadme);

            const unknownCommand = run(root, 'unknown');
            expect(unknownCommand.status).toBe(1);
            expect(fs.readFileSync(path.join(root, 'README.md'), 'utf8')).toBe(generatedReadme);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('docs index CLI', { timeout: 15000 }, () => {
    beforeEach(() => {
        put('docs/README.md', '# Docs\n\n<!-- docs:begin site-index -->\n<!-- docs:end site-index -->\n');
        put('docs/index.md', '# Home\n');
        put('docs/setup.md', '---\nnavigation:\n    category: Basics\n---\n\n# Setup\n\nInstall the tools.\n');
        put('docs/api/generated.md', '# Generated API page\n');
        put('docs/topics/index.md', '---\ntitle: Topic overview\ndescription: All topics\n---\n\n# Ignored\n');
        put('docs/topics/alpha.md', '# Alpha topic\n\nAlpha prose.\n');
        put('docs/odds-and-ends/beta.md', '# Beta notes\n');
        put('packages/demo/package.json', '{"name":"@x/demo"}');
        put('packages/demo/docs/usage.md', '---\nnavigation:\n    catalog: true\n---\n\n# Demo usage\n');
        put('packages/demo/docs/internal.md', '# Demo internals\n');
    });

    it('lists guides by category and nests docs folders and catalogued component pages', () => {
        expect(run(dir, 'docs-index', '--check').status).toBe(1);
        expect(run(dir, 'docs-index').status).toBe(0);
        const index = read('docs/README.md');

        expect(index).toContain('### Basics\n\n- [Setup](setup.md) — Install the tools.');
        expect(index).toContain('- [Topic overview](topics/index.md) — All topics\n  - [Alpha topic](topics/alpha.md)');
        expect(index).toContain('- **Odds And Ends**\n  - [Beta notes](odds-and-ends/beta.md)');
        expect(index).toContain('[Demo usage](../packages/demo/docs/usage.md)');
        expect(index).not.toContain('Demo internals');
        expect(index).not.toContain('Generated API page');
        expect(index).not.toContain('[Home]');
        expect(run(dir, 'docs-index', '--check').status).toBe(0);
    });

    it('leaves agent instructions out of the public docs index', () => {
        put('docs/agents/triage.md', '# Triage labels\n');
        expect(run(dir, 'docs-index').status).toBe(0);
        expect(read('docs/README.md')).not.toContain('Triage labels');
    });
});
