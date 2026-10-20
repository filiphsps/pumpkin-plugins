import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { demo } from '../test/schema.ts';
import { readConfig } from './read.ts';
import { commentLines, MANAGED_NOTE, renderConfig } from './render.ts';
import { defaultValues } from './schema.ts';

describe('renderConfig', () => {
    it('writes every setting with its comment', () => {
        const out = renderConfig(demo, defaultValues(demo), { note: 'Managed.' });
        expect(out.startsWith('# Demo configuration.\n# Managed.\n')).toBe(true);
        expect(out).toMatch(/^\[web\]$/m);
        expect(out).toContain('# Serve over HTTP.\nenabled = true\n');
        expect(out).toContain('# Port to listen on.\nport = 8123\n');
        expect(out).toContain('# Base URL, without a trailing slash.\nbase_url = ""\n');
        expect(out).toContain('# Optional access token.\n# token = "secret"\n');
        expect(out).toMatch(/^# \[overrides\."a\.txt"\]$/m);
        expect(out).toMatch(/^# order = 10 +# Sort order\.$/m);
        expect(out).toMatch(/^# enabled = true +# Include the file\.$/m);
        expect(out.indexOf('[web]')).toBeLessThan(out.indexOf('[overrides.'));
    });

    it('writes set optional settings and existing table entries', () => {
        const values = readConfig(demo, {
            web: { enabled: true, port: 1, base_url: '', token: 'abc' },
            overrides: { 'my.file.txt': { enabled: false, order: 2 } },
        }).values;
        const out = renderConfig(demo, values);
        expect(out).toContain('token = "abc"');
        expect(out).not.toContain('# token');
        expect(out).toContain('[overrides."my.file.txt"]\norder = 2\nenabled = false');
    });

    it('produces TOML that reads back to the same values with no issues', () => {
        const values = readConfig(demo, {
            web: { port: 9, token: 'x' },
            overrides: { 'a.txt': { order: 1 }, 'b.txt': { enabled: true } },
        }).values;
        const out = renderConfig(demo, values);
        const again = readConfig(demo, parse(out));
        expect(again.issues).toEqual([]);
        expect(again.values).toEqual(values);
        expect(renderConfig(demo, again.values)).toBe(out);
    });

    it('escapes DEL so values and table keys containing it read back', () => {
        const values = readConfig(demo, {
            web: { token: 'a\u007fb' },
            overrides: { 'x\u007fy.txt': { order: 1 } },
        }).values;
        const again = readConfig(demo, parse(renderConfig(demo, values)));
        expect(again.issues).toEqual([]);
        expect(again.values).toEqual(values);
    });

    it('wraps long comments without splitting words', () => {
        const lines = commentLines('one two three four five six', 14);
        expect(lines).toEqual(['# one two', '# three four', '# five six']);
        expect(commentLines('averyveryverylongword', 5)).toEqual(['# averyveryverylongword']);
    });

    it('explains that the file is managed by default', () => {
        expect(renderConfig(demo, defaultValues(demo))).toContain(MANAGED_NOTE.slice(0, 30));
    });
});
