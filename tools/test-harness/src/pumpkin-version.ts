/**
 * The Pumpkin release that integration tests run against. Keep it aligned with the WIT pin in
 * `tools/pumpkin-api/wit.lock.json` and the API version in `tools/pumpkin-api/package.json`, because
 * the server's plugin ABI must match them.
 */
export const PUMPKIN_RELEASE = '0.2.0+26.3-26.51';

/**
 * SHA-256 of each `PUMPKIN_RELEASE` server binary, keyed by asset name and copied from the release's
 * `checksums.sha256`. Update it together with `PUMPKIN_RELEASE`; a stale entry fails the download with
 * a checksum mismatch.
 */
export const PUMPKIN_RELEASE_SHA256: Readonly<Record<string, string>> = {
    'pumpkin-ARM64-Linux': '5cc0300f42e37d40f500b7b21d5194351939729c11b3bb0c28b4b77419dc00c9',
    'pumpkin-ARM64-Linux-musl': '8a6ff413ba709075d6c82be10179c7091d443fbf1418daebfbb3ad7a150a02af',
    'pumpkin-ARM64-Windows.exe': '7dd2db77b9ea0ccaeda18fed3d465c97ff882561fdc01e160b2f40a66d0f4030',
    'pumpkin-ARM64-macOS': '7c4e7d61ee31f83faa578b9969f12c29c74281a4129f6aefea0bd8de309a4226',
    'pumpkin-X64-Linux': '68c4416ca9fbfb3f2aeb6a8ce1de0e3fb02c5a85a53c8ba59a27941d7e43d8cd',
    'pumpkin-X64-Linux-musl': '798fc1aee4ebe005f029b7cb7144064f77d927c52c417554f74bd325de400b65',
    'pumpkin-X64-Windows.exe': '6d652f2d272bbe0675f5627e7375ea1aa84dac3c699b5bdd142ff189a4fba180',
};
