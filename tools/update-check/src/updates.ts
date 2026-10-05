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
    for (let index = 0; index < 3; index += 1) {
        if (currentParts[index] !== latestParts[index]) {
            return currentParts[index] < latestParts[index] ? -1 : 1;
        }
    }
    return comparePrerelease(currentParts[3], latestParts[3]);
}

/** Parses a strict semantic version into numeric components and prerelease identifiers. */
function parseVersion(version: string): [number, number, number, string[]] {
    const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
        version
    );
    if (!match) throw new TypeError(`Invalid semantic version: ${version}`);
    return [Number(match[1]), Number(match[2]), Number(match[3]), match[4]?.split('.') ?? []];
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
            return Number(current[index]) < Number(latest[index]) ? -1 : 1;
        }
        if (currentNumeric !== latestNumeric) return currentNumeric ? -1 : 1;
        return current[index] < latest[index] ? -1 : 1;
    }
    return 0;
}
