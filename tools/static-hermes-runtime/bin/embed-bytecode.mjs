/** Render Hermes bytecode as a C++ byte array embedded in the plugin component. */
export function renderEmbeddedBytecode(bytecode) {
    if (bytecode.length === 0) throw new Error('Hermes bytecode is empty');
    const lines = [];
    for (let index = 0; index < bytecode.length; index += 12) {
        lines.push(
            `    ${[...bytecode.subarray(index, index + 12)]
                .map((value) => `0x${value.toString(16).padStart(2, '0')}`)
                .join(', ')}`
        );
    }
    return /* cpp */ `#pragma once
#include <cstddef>
#include <cstdint>

static constexpr std::uint8_t pluginBundleBytecode[] = {\n${lines.join(',\n')}\n};
static constexpr std::size_t pluginBundleBytecodeSize = sizeof(pluginBundleBytecode);
`;
}
