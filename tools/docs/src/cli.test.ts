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

describe('plugin README', () => {
    beforeEach(() => {
        put('p/package.json', '{"name":"@x/p","version":"1.0.0"}');
        put('p/README.md', README);
        put(
            'p/src/info.ts',
            plugin('Demo', 'Does demo things.', ', commands: [{ usage: "/demo list", description: "List" }]')
        );
    });

    it('fills the blocks, keeps hand-written prose on rerun, and picks up code changes', () => {
        const p = path.join(dir, 'p');
        expect(run(p).stdout).toContain('README.md: updated');
        expect(read('p/README.md')).toContain('| `/demo list` | List | none |');

        put('p/README.md', read('p/README.md').replace('Hand-written words.', 'My own words.'));
        expect(run(p).stdout).toContain('unchanged');
        expect(read('p/README.md')).toContain('My own words.');

        put(
            'p/src/info.ts',
            plugin(
                'Demo',
                'Does demo things.',
                ', commands: [{ usage: "/demo list", description: "List" }, { usage: "/demo reload", description: "Reload" }]'
            )
        );
        expect(run(p).stdout).toContain('updated');
        expect(read('p/README.md')).toContain('`/demo reload`');
        expect(read('p/README.md')).toContain('My own words.');
    });

    it('fills the blocks a plugin declares itself, where the README has markers for them', () => {
        const p = path.join(dir, 'p');
        put('p/README.md', `${README}\n<!-- docs:begin routers -->\n<!-- docs:end routers -->\n`);
        put('p/src/info.ts', plugin('Demo', 'Does demo things.', ', blocks: { routers: "| Telekom |", unused: "x" }'));
        expect(run(p).stdout).toContain('updated');
        expect(read('p/README.md')).toContain('<!-- docs:begin routers -->\n<!-- Generated');
        expect(read('p/README.md')).toContain('| Telekom |');
        expect(read('p/README.md')).not.toContain('unused');
    });

    it('--check fails on a stale README and never writes', () => {
        const p = path.join(dir, 'p');
        const stale = run(p, '--check');
        expect(stale.status).toBe(1);
        expect(stale.stderr).toContain('out of date');
        expect(read('p/README.md')).toBe(README);

        run(p);
        expect(run(p, '--check').status).toBe(0);
        put('p/src/info.ts', plugin('Demo', 'Changed.'));
        expect(run(p, '--check').status).toBe(1);
    });

    it('asks for a README instead of inventing one', () => {
        fs.rmSync(path.join(dir, 'p/README.md'));
        const r = run(path.join(dir, 'p'));
        expect(r.status).toBe(1);
        expect(r.stderr).toContain('README.md not found');
        expect(fs.existsSync(path.join(dir, 'p/README.md'))).toBe(false);
    });

    it('explains a missing info module', () => {
        fs.rmSync(path.join(dir, 'p/src/info.ts'));
        const r = run(path.join(dir, 'p'));
        expect(r.status).toBe(1);
        expect(r.stderr).toContain('needs a src/info.ts');
    });
});

describe('root README', () => {
    const readme = '# Repo\n\n<!-- docs:begin packages -->\n<!-- docs:end packages -->\n\nAfter.\n';
    beforeEach(() => {
        put('pnpm-workspace.yaml', 'packages: []\n');
        put('README.md', readme);
        put('packages/alpha/package.json', '{"name":"@x/alpha","description":"ignored, info wins"}');
        put('packages/alpha/src/info.ts', plugin('Alpha', 'Alpha plugin.'));
        put('packages/beta/package.json', '{"name":"@x/beta","description":"Beta from package.json"}');
        put('tools/build/package.json', '{"name":"@x/build","description":"Builds"}');
    });

    it('has one linked row per package folder and follows additions', () => {
        expect(run(dir, 'root').stdout).toContain('README.md: updated');
        const first = read('README.md');
        expect(first).toContain('| [Alpha](packages/alpha) | Alpha plugin. |');
        expect(first).toContain('| [@x/beta](packages/beta) | Beta from package.json |');
        expect(first).toContain('| [@x/build](tools/build) | Builds |');
        expect(first).toContain('After.');
        expect(first.match(/^\| \[/gm)).toHaveLength(3);

        put('packages/gamma/package.json', '{"name":"@x/gamma","description":"Gamma"}');
        expect(run(dir, 'root', '--check').status).toBe(1);
        run(dir, 'root');
        expect(read('README.md').match(/^\| \[/gm)).toHaveLength(4);
        expect(read('README.md')).toContain('[@x/gamma](packages/gamma)');

        fs.rmSync(path.join(dir, 'packages/beta'), { recursive: true });
        run(dir, 'root');
        expect(read('README.md')).not.toContain('beta');
        expect(run(dir, 'root', '--check').status).toBe(0);
    });

    it('requires the marker and the repo root', () => {
        put('README.md', '# no markers\n');
        expect(run(dir, 'root').stderr).toContain('docs:begin packages');
        fs.rmSync(path.join(dir, 'pnpm-workspace.yaml'));
        expect(run(dir, 'root').stderr).toContain('repository root');
    });
});
