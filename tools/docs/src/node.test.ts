import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateRootReadme } from './node.ts';

let root: string;

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-node-test-'));
    put('README.md', '# Repo\n\n<!-- docs:begin packages -->\n<!-- docs:end packages -->\n');
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function put(relativePath: string, contents: string): void {
    const file = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
}

function read(relativePath: string): string {
    return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

describe('generateRootReadme', () => {
    it('reads action metadata from both YAML filenames and scalar styles', async () => {
        put('actions/plain/action.yml', 'name: Plain # comment\ndescription: Simple action # comment\n');
        put('actions/quoted/action.yaml', `name: "A: B"\ndescription: 'Action with a ''quote'''\n`);
        put(
            'actions/folded/action.yml',
            'name: Folded\ndescription: >-\n  First\n\n  Second\nruns:\n  using: node24\n'
        );
        put(
            'actions/literal/action.yml',
            'name: Literal\ndescription: |\n  First line\n  Second line\nruns:\n  using: node24\n'
        );
        put(
            'actions/blank/action.yml',
            'name: Blank\ndescription: >-\n  \n  Starts after a blank\nruns:\n  using: node24\n'
        );
        put('actions/no-metadata/README.md', '# Not an action\n');
        put('actions/not-a-directory.txt', 'ignored');

        expect(await generateRootReadme(root)).toBe('updated');
        const generated = read('README.md');
        expect(generated).toContain('| [Plain](actions/plain) | Simple action |');
        expect(generated).toContain("| [A: B](actions/quoted) | Action with a 'quote' |");
        expect(generated).toContain('| [Folded](actions/folded) | First  Second |');
        expect(generated).toContain('| [Literal](actions/literal) | First line Second line |');
        expect(generated).toContain('| [Blank](actions/blank) | Starts after a blank |');
        expect(generated).not.toContain('no-metadata');
        expect(generated).not.toContain('not-a-directory');

        expect(await generateRootReadme(root, true)).toBe('unchanged');
        put('actions/plain/action.yml', 'name: Plain\ndescription: Updated action\n');
        expect(await generateRootReadme(root, true)).toBe('stale');
        expect(read('README.md')).toBe(generated);
        expect(await generateRootReadme(root)).toBe('updated');
        expect(read('README.md')).toContain('| [Plain](actions/plain) | Updated action |');
    });

    it.each([
        ['missing top-level name', 'description: Description\n', 'is missing its top-level name'],
        ['missing top-level description', 'name: Name\n', 'is missing its top-level description'],
        [
            'malformed double-quoted value',
            'name: "unfinished\ndescription: Description\n',
            'needs a single-line name value'
        ],
        ['invalid double-quoted escape', 'name: "bad\\q"\ndescription: Description\n', 'has an invalid quoted name'],
        [
            'malformed single-quoted value',
            "name: 'unfinished\ndescription: Description\n",
            'needs a single-line name value'
        ],
        ['empty quoted value', 'name: ""\ndescription: Description\n', 'has an empty name'],
        ['empty block value', 'name: Name\ndescription: |\n', 'has an empty description']
    ])('rejects %s action metadata', async (_case, contents, message) => {
        put('actions/broken/action.yml', contents);

        await expect(generateRootReadme(root)).rejects.toThrow(message);
    });

    it('works when the repository has no actions directory', async () => {
        expect(await generateRootReadme(root)).toBe('updated');
        expect(read('README.md')).not.toContain('**Actions**');
    });

    it('requires the README and its packages marker', async () => {
        fs.rmSync(path.join(root, 'README.md'));
        await expect(generateRootReadme(root)).rejects.toThrow('README.md not found');

        put('README.md', '# Repo\n');
        await expect(generateRootReadme(root)).rejects.toThrow('docs:begin packages');
    });
});
