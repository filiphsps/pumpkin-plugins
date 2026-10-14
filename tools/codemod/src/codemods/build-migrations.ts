import semver from 'semver';
import type { CodemodDefinition } from '../types.js';

/** A consumer migration introduced by a published build-tool release. */
export interface BuildMigration {
    /** Synchronous per-file transform for the release-specific change. */
    codemod: CodemodDefinition;
    /** First builder version that requires this consumer change. */
    introducedIn: string;
}

/** Release migrations that are required by published builder versions. */
export const buildMigrations: readonly BuildMigration[] = [];

/**
 * Selects migrations in release order for the interval after an installed builder through a target.
 *
 * @param installedVersion - Version currently installed in the consumer project.
 * @param latestVersion - Version that the update workflow targets.
 * @param migrations - Registry to select from; injectable for tests.
 * @returns Matching migrations sorted by their introduced builder version.
 */
export function selectBuildMigrations(
    installedVersion: string,
    latestVersion: string,
    migrations: readonly BuildMigration[] = buildMigrations,
): BuildMigration[] {
    return migrations
        .filter(
            ({ introducedIn }) => semver.gt(introducedIn, installedVersion) && semver.lte(introducedIn, latestVersion),
        )
        .sort(
            (left, right) =>
                semver.compare(left.introducedIn, right.introducedIn) ||
                left.codemod.id.localeCompare(right.codemod.id),
        );
}
