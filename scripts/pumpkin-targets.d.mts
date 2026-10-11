/** A commit-pinned source tree. */
export interface SourcePin {
    repository: string;
    ref: string;
}
/** A named API/WIT/server compatibility record. */
export interface Target {
    name: string;
    api: SourcePin & { entry: string; installedVersion?: string };
    wit: SourcePin & { path: string; installedPath?: string };
    server: SourcePin & { tag: string; sha256?: Record<string, string>; checksums?: string };
}
/** Validates and returns a configured target. */
export function readTarget(root?: string, name?: string): Target;
/** Returns validated CI target names. */
export function compatibilityTargets(root?: string): string[];
/** Resolves the selected source inputs. */
export function resolveBuildTarget(
    pluginDir: string,
    options?: { root?: string; env?: NodeJS.ProcessEnv }
): Promise<{
    target: Target;
    apiRoot: string;
    apiEntry: string;
    witRoot: string;
}>;
