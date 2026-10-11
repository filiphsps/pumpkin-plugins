import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { generateDocuments } from './documents.ts';

it('checks all targets without writing and validates every target before updating', () => {
    const root = mkdtempSync(join(tmpdir(), 'docs-targets-'));
    const first = 'Intro\n<!-- docs:begin facts -->\nstale\n<!-- docs:end facts -->\nUsage\n';
    const documents = [
        { file: 'README.md', blocks: { facts: 'New facts' } },
        { file: 'guide.md', blocks: { facts: 'Guide facts' } }
    ];
    try {
        writeFileSync(join(root, 'README.md'), first);
        writeFileSync(join(root, 'guide.md'), 'Missing markers');
        expect(() => generateDocuments(documents, root)).toThrow('docs:begin facts');
        expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe(first);
        writeFileSync(join(root, 'guide.md'), first);
        expect(generateDocuments(documents, root, true)).toBe('stale');
        expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe(first);
        expect(generateDocuments(documents, root)).toBe('updated');
        expect(readFileSync(join(root, 'README.md'), 'utf8')).toContain('New facts\n<!-- docs:end facts -->\nUsage\n');
        expect(generateDocuments(documents, root, true)).toBe('unchanged');
        expect(() => generateDocuments([documents[0], documents[0]], root)).toThrow('Duplicate');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

it('supports validated whole-document transforms with the same check behavior', () => {
    const root = mkdtempSync(join(tmpdir(), 'docs-transform-'));
    try {
        writeFileSync(join(root, 'README.md'), 'Use action-v1.0.0.');
        const docs = [{ file: 'README.md', transform: (source: string) => source.replace('v1.0.0', 'v2.0.0') }];
        expect(generateDocuments(docs, root, true)).toBe('stale');
        expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('Use action-v1.0.0.');
        expect(generateDocuments(docs, root)).toBe('updated');
        expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('Use action-v2.0.0.');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
