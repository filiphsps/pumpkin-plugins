import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { demo } from '../test/schema.ts';
import { readConfig } from './read.ts';
import { commentLines, MANAGED_NOTE, renderConfig } from './render.ts';
import { defaultValues } from './schema.ts';

describe('renderConfig', () => {
    it('writes every setting with its comment', () => {
        expect(renderConfig(demo, defaultValues(demo), { note: 'Managed.' })).toBe(`# Demo configuration.
# Managed.

# The web server.
[web]

# Serve over HTTP.
enabled = true

# Port to listen on.
port = 8123

# Base URL, without a trailing slash.
base_url = ""

# Optional access token.
# token = "secret"

# Per-file settings.
#
# [overrides."a.txt"]
# order = 10  # Sort order.
# enabled = true  # Include the file.
`);
    });

    it('writes set optional settings and existing table entries', () => {
        const values = readConfig(demo, {
            web: { enabled: true, port: 1, base_url: '', token: 'abc' },
            overrides: { 'my.file.txt': { enabled: false, order: 2 } }
        }).values;
        const out = renderConfig(demo, values);
        expect(out).toContain('token = "abc"');
        expect(out).not.toContain('# token');
        expect(out).toContain('[overrides."my.file.txt"]\norder = 2\nenabled = false');
    });

    it('produces TOML that reads back to the same values with no issues', () => {
        const values = readConfig(demo, {
            web: { port: 9, token: 'x' },
            overrides: { 'a.txt': { order: 1 }, 'b.txt': { enabled: true } }
        }).values;
        const out = renderConfig(demo, values);
        const again = readConfig(demo, parse(out));
        expect(again.issues).toEqual([]);
        expect(again.values).toEqual(values);
        expect(renderConfig(demo, again.values)).toBe(out);
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
