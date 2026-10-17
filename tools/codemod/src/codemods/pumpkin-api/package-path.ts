import * as path from 'node:path';

/** Normalizes a path only when it stays inside the package directory. */
export function normalizePackagePath(value: string): string | undefined {
    const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
    if (
        value.length === 0 ||
        value.includes('\0') ||
        path.isAbsolute(value) ||
        path.win32.isAbsolute(value) ||
        path.win32.parse(value).root !== '' ||
        normalized === '.' ||
        normalized === '..' ||
        normalized.startsWith('../')
    ) {
        return undefined;
    }
    return normalized;
}
