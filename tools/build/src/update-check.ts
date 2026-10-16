import { createRequire } from 'node:module';
import { type LatestVersionOptions, type LatestVersionPackage, latestVersion, ONE_DAY } from '@badisi/latest-version';

const packageMetadata = createRequire(import.meta.url)('../package.json') as {
    name: string;
    repository: { url: string };
};
const packageName = packageMetadata.name;
const repositoryUrl = packageMetadata.repository.url.replace(/^git\+/, '').replace(/\.git$/, '');
const releaseComponent = packageName.split('/').at(-1) ?? packageName;
const requestTimeout = 5_000;

/** Registry lookup signature used by the build notice. */
export type BuildVersionLookup = (packageName: string, options?: LatestVersionOptions) => Promise<LatestVersionPackage>;

/**
 * Reports whether an executable build invocation should check npm for an update.
 *
 * @param args - Arguments passed to the build executable.
 * @param environment - Environment used to identify CI, development mode, and opt-out.
 * @param isTTY - Whether the build command writes to an interactive terminal.
 * @returns `true` when the invocation is eligible for a background update lookup.
 */
export function isBuildUpdateCheckAllowed(
    args: readonly string[],
    environment: NodeJS.ProcessEnv,
    isTTY: boolean,
): boolean {
    return (
        isTTY &&
        !environment.CI &&
        environment.PUMPKIN_DEV_MODE !== '1' &&
        environment.PUMPKIN_PLUGINS_NO_UPDATE_NOTIFIER !== '1' &&
        !args.some((argument) => ['--help', '-h', '--version', '-V', '--no-update-notifier'].includes(argument))
    );
}

/** Options for the build update check. */
export interface BuildUpdateCheckOptions {
    /** Environment used for update-check eligibility. */
    environment: NodeJS.ProcessEnv;
    /** Whether output is connected to an interactive terminal. */
    isTTY: boolean;
    /** Registry lookup, replaceable in tests. */
    lookup?: BuildVersionLookup;
    /** Receives the update notice. Defaults to standard error. */
    write?: (notice: string) => void;
}

/**
 * Looks for a newer published build tool and prints an optional migration notice.
 *
 * @remarks Lookup errors and missing package metadata are intentionally ignored so they cannot
 * affect a plugin build. The caller should start this promise without awaiting it.
 * @param args - Arguments passed to the build executable.
 * @param options - Eligibility, lookup, and output dependencies.
 */
export async function startBuildUpdateCheck(args: readonly string[], options: BuildUpdateCheckOptions): Promise<void> {
    if (!isBuildUpdateCheckAllowed(args, options.environment, options.isTTY)) return;

    try {
        const result = await (options.lookup ?? latestVersion)(packageName, {
            useCache: true,
            cacheMaxAge: ONE_DAY,
            requestOptions: { timeout: requestTimeout },
        } satisfies LatestVersionOptions);
        const currentVersion = result.local;
        const availableUpdate = result.updatesAvailable === false ? undefined : result.updatesAvailable.local;
        const availableVersion = availableUpdate ? result.latest : undefined;
        if (result.error || currentVersion === undefined || availableVersion === undefined) return;

        (options.write ?? ((notice) => process.stderr.write(notice)))(
            formatBuildUpdateNotice(currentVersion, availableVersion),
        );
    } catch {
        // Network and registry failures must not change build behavior.
    }
}

function formatBuildUpdateNotice(currentVersion: string, latestVersion: string): string {
    const content = [
        '',
        `Update available v${currentVersion} ≫ v${latestVersion}`,
        `Changelog: ${new URL(`releases/tag/${releaseComponent}-v${latestVersion}`, `${repositoryUrl}/`).href}`,
        'Run "pnpm dlx @pumpkin-plugins/codemod update-build ." to update',
        '',
        'Follow Filiph Sandström for updates: https://x.com/filiphsandstrom',
        '',
    ];
    const contentWidth = Math.max(...content.map((line) => line.length));
    const border = '─'.repeat(contentWidth + 2);
    const body = content.map((line) => {
        const leftPadding = Math.floor((contentWidth - line.length) / 2);
        const centeredLine = `${' '.repeat(leftPadding)}${line}${' '.repeat(contentWidth - line.length - leftPadding)}`;
        return `│ ${centeredLine} │`;
    });
    return [`╭${border}╮`, ...body, `╰${border}╯`, ''].join('\n');
}
