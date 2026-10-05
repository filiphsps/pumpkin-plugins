/** Fetches and decodes JSON from a URL before returning. */
export type JsonRequest = (url: string, headers?: Record<string, string>) => unknown;

/** Describes whether a newer version exists and where to find it. */
export interface UpdateCheck {
    currentVersion: string;
    latestVersion: string | null;
    updateAvailable: boolean;
    releaseUrl?: string;
}

/** Compares two semantic versions, accepting an optional leading `v`. */
export function compareVersions(current: string, latest: string): number {
    const currentParts = parseVersion(current);
    const latestParts = parseVersion(latest);
    for (const index of [0, 1, 2] as const) {
        if (currentParts[index] !== latestParts[index]) {
            return compareNumeric(currentParts[index], latestParts[index]);
        }
    }
    return comparePrerelease(currentParts[3], latestParts[3]);
}

/** Parses a strict semantic version into numeric components and prerelease identifiers. */
function parseVersion(version: string): [string, string, string, string[]] {
    const match =
        /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
            version
        );
    if (!match) throw new TypeError(`Invalid semantic version: ${version}`);
    const prerelease = match[4]?.split('.') ?? [];
    if (prerelease.some((part) => /^0\d+$/.test(part))) {
        throw new TypeError(`Invalid semantic version: ${version}`);
    }
    return [match[1], match[2], match[3], prerelease];
}

/** Orders prereleases before stable versions and compares their identifiers. */
function comparePrerelease(current: string[], latest: string[]): number {
    if (current.length === 0 || latest.length === 0) {
        return current.length === latest.length ? 0 : current.length === 0 ? 1 : -1;
    }
    const length = Math.max(current.length, latest.length);
    for (let index = 0; index < length; index += 1) {
        if (current[index] === undefined || latest[index] === undefined) {
            return current[index] === undefined ? -1 : 1;
        }
        if (current[index] === latest[index]) continue;
        const currentNumeric = /^\d+$/.test(current[index]);
        const latestNumeric = /^\d+$/.test(latest[index]);
        if (currentNumeric && latestNumeric) {
            return compareNumeric(current[index], latest[index]);
        }
        if (currentNumeric !== latestNumeric) return currentNumeric ? -1 : 1;
        return current[index] < latest[index] ? -1 : 1;
    }
    return 0;
}

// Compare decimal strings without losing precision for large version components.
function compareNumeric(current: string, latest: string): number {
    if (current === latest) return 0;
    if (current.length !== latest.length) return current.length < latest.length ? -1 : 1;
    return current < latest ? -1 : 1;
}
