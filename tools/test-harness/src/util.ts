// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI color codes start with the ESC control character
const ANSI = /\x1b\[[0-9;]*m/g;

/** Removes ANSI color codes from text. */
export function stripAnsi(text: string): string {
    return text.replace(ANSI, '');
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Deep-merges plain objects; arrays and scalars in `over` replace those in `base`. */
export function deepMerge(base: Obj, over: Obj): Obj {
    const out: Obj = { ...base };
    for (const [key, value] of Object.entries(over)) {
        const existing = out[key];
        out[key] = isObj(existing) && isObj(value) ? deepMerge(existing, value) : value;
    }
    return out;
}

/** Name of the release asset for a platform, as published by Pumpkin-MC/Pumpkin. */
export function assetName(platform: NodeJS.Platform, arch: string): string {
    const key = `${platform}-${arch}`;
    const names: Record<string, string> = {
        'darwin-arm64': 'pumpkin-ARM64-macOS',
        'linux-x64': 'pumpkin-X64-Linux',
        'linux-arm64': 'pumpkin-ARM64-Linux',
        'win32-x64': 'pumpkin-X64-Windows.exe',
        'win32-arm64': 'pumpkin-ARM64-Windows.exe'
    };
    const name = names[key];
    if (!name) throw new Error(`No Pumpkin release binary for ${key}; set PUMPKIN_BIN to a local build`);
    return name;
}

/** Parses `sha256sum` output into a map of file name to hex digest. */
export function parseChecksums(text: string): Map<string, string> {
    const sums = new Map<string, string>();
    for (const line of text.split('\n')) {
        const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line);
        if (m) sums.set(m[2], m[1].toLowerCase());
    }
    return sums;
}
