import { describe, expect, it } from 'vitest';
import { renderEmbeddedBytecode } from '../bin/embed-bytecode.mjs';

describe('embedded Hermes bytecode', () => {
    it('renders bytecode bytes and their size as a C++ header', () => {
        expect(renderEmbeddedBytecode(Buffer.from([0, 127, 255]))).toContain(
            'static constexpr std::uint8_t pluginBundleBytecode[] = {\n    0x00, 0x7f, 0xff\n};'
        );
        expect(renderEmbeddedBytecode(Buffer.from([0, 127, 255]))).toContain(
            'static constexpr std::size_t pluginBundleBytecodeSize = sizeof(pluginBundleBytecode);'
        );
    });

    it('rejects an empty bytecode file', () => {
        expect(() => renderEmbeddedBytecode(Buffer.alloc(0))).toThrow(/empty/);
    });
});
