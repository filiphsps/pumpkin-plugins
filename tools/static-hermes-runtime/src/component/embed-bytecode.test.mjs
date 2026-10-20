import { describe, expect, it } from 'vitest';
import { renderEmbeddedBytecode } from './embed-bytecode.ts';

describe('embedded Hermes bytecode', () => {
    it('embeds the bytecode file from the header directory and keeps its size symbol', () => {
        const header = renderEmbeddedBytecode('plugin_bundle.hbc', 3);

        expect(header).toMatch(/pluginBundleBytecode\[\] = \{\s*#embed "plugin_bundle\.hbc"\s*\};/);
        expect(header).toContain('pluginBundleBytecodeSize = sizeof(pluginBundleBytecode)');
        expect(header).not.toContain('0x');
    });

    it('rejects an empty bytecode file', () => {
        expect(() => renderEmbeddedBytecode('plugin_bundle.hbc', 0)).toThrow(/empty/);
    });
});
