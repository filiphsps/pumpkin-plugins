import { describe, expect, it, vi } from 'vitest';
import { registerDictionary } from './register-dictionary.js';

describe('Minecraft Terms extension', () => {
    it('registers the packaged dictionary with Code Spell Checker', async () => {
        const context = { asAbsolutePath: vi.fn(() => '/extension/cspell-ext.json') };
        const registerConfig = vi.fn();

        await registerDictionary(context, { registerConfig });

        expect(context.asAbsolutePath).toHaveBeenCalledWith('cspell-ext.json');
        expect(registerConfig).toHaveBeenCalledWith('/extension/cspell-ext.json');
    });
});
