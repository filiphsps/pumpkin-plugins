/** Native targets must run and load on their own architecture; cross-compilation is insufficient. */
export const nativeTargets = [
    { target: 'x86_64-unknown-linux-gnu', runner: 'ubuntu-24.04', extension: 'so', prefix: 'lib' },
    { target: 'aarch64-unknown-linux-gnu', runner: 'ubuntu-26.04-arm', extension: 'so', prefix: 'lib' },
    { target: 'aarch64-apple-darwin', runner: 'macos-26', extension: 'dylib', prefix: 'lib' },
    { target: 'x86_64-pc-windows-msvc', runner: 'windows-2025', extension: 'dll', prefix: '' },
    { target: 'aarch64-pc-windows-msvc', runner: 'windows-11-arm', extension: 'dll', prefix: '' },
];

/** Target-qualified library and verification files attached to one native release. */
export function nativeAssetNames(component, target) {
    const platform = nativeTargets.find((entry) => entry.target === target);
    if (!platform) throw new Error(`Unsupported native target: ${target}`);
    const library = `${component}-${target}.${platform.extension}`;
    return [library, `${library}.sha256`, `${library}.json`];
}
