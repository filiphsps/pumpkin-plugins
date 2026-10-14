import { describe, expect, it } from 'vitest';
import { compileTemplate, MAX_TEMPLATE_BYTES, renderTemplate } from './templates.ts';

describe('tab templates', () => {
    it('keeps placeholder output literal and does not recursively resolve it', () => {
        const template = compileTemplate('Hi %player_name%!');
        expect(renderTemplate(template, { text: 'Hi %server_online%!', unresolved: [] }, 'literal', true)).toBe(
            'Hi %server_online%!',
        );
    });

    it('preserves unresolved tokens or removes only those tokens by policy', () => {
        const template = compileTemplate('%player_name% / %unknown%');
        const resolution = { text: 'Steve / %unknown%', unresolved: ['unknown'] };
        expect(renderTemplate(template, resolution, 'literal', true)).toBe('Steve / %unknown%');
        expect(renderTemplate(template, resolution, 'empty', true)).toBe('Steve / ');
    });

    it('uses the configured fallback when the provider is unavailable', () => {
        const template = compileTemplate('Hello %player_name%');
        expect(renderTemplate(template, undefined, 'literal', false)).toBe('Hello %player_name%');
        expect(renderTemplate(template, undefined, 'empty', false)).toBe('Hello ');
    });

    it('rejects template input above the UTF-8 byte budget', () => {
        expect(() => compileTemplate('x'.repeat(MAX_TEMPLATE_BYTES + 1))).toThrow(/4 KiB/);
    });

    it('measures Unicode templates in UTF-8 bytes', () => {
        expect(() => compileTemplate('😀'.repeat(MAX_TEMPLATE_BYTES / 4 + 1))).toThrow(/4 KiB/);
    });
});
