/**
 * Render a C++ header that embeds the Hermes bytecode file with `#embed`.
 *
 * @param bytecodeFileName - Bytecode file name, resolved from the header's own directory.
 * @param byteLength - Size of the bytecode file, used to reject an empty compile result.
 */
export function renderEmbeddedBytecode(bytecodeFileName: string, byteLength: number): string {
    if (byteLength === 0) throw new Error('Hermes bytecode is empty');
    // clang accepts #embed in C++ as an extension and warns about it.
    return /* cpp */ `#pragma once
#include <cstddef>
#include <cstdint>

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wc23-extensions"
static constexpr std::uint8_t pluginBundleBytecode[] = {
#embed "${bytecodeFileName}"
};
#pragma clang diagnostic pop
static constexpr std::size_t pluginBundleBytecodeSize = sizeof(pluginBundleBytecode);
`;
}
