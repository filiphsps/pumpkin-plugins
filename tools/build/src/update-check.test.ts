import type { LatestVersionOptions } from '@badisi/latest-version';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isBuildUpdateCheckAllowed, startBuildUpdateCheck } from './update-check.ts';

const emptyEnvironment: NodeJS.ProcessEnv = {};

afterEach(() => {
    vi.restoreAllMocks();
});

describe('build update check', () => {
    it('does not print an update when the installed version is current', async () => {
        const lookup = vi.fn(async (_packageName: string, _options?: LatestVersionOptions) => ({
            name: '@pumpkin-plugins/build',
            local: '0.1.0',
            latest: '0.1.0',
            updatesAvailable: false as const,
        }));
        const output: string[] = [];

        await startBuildUpdateCheck(['--types-only'], {
            environment: emptyEnvironment,
            isTTY: true,
            lookup,
            write: (notice) => output.push(notice),
        });

        expect(output).toEqual([]);
    });

    it('prints the current and latest versions with the migration preview command', async () => {
        const lookup = vi.fn(async (_packageName: string, _options?: LatestVersionOptions) => ({
            name: '@pumpkin-plugins/build',
            local: '0.1.0',
            latest: '0.2.0',
            updatesAvailable: { local: '0.2.0', globalNpm: false as const, globalYarn: false as const },
        }));
        const output: string[] = [];

        await startBuildUpdateCheck(['--types-only'], {
            environment: emptyEnvironment,
            isTTY: true,
            lookup,
            write: (notice) => output.push(notice),
        });

        expect(output.join('')).toContain('0.1.0');
        expect(output.join('')).toContain('0.2.0');
        expect(output.join('')).toContain('pnpm dlx @pumpkin-plugins/codemod update-build .');

        const lines = output.join('').trimEnd().split('\n');
        const boxWidth = lines[0]?.length ?? 0;
        expect(lines[0]).toMatch(/^┌─+┐$/);
        expect(lines.at(-1)).toBe(`└${'─'.repeat(boxWidth - 2)}┘`);
        expect(lines.slice(1, -1).length).toBeGreaterThan(0);
        for (const line of lines.slice(1, -1)) {
            expect(line).toMatch(/^│.*│$/);
            expect(line).toHaveLength(boxWidth);
        }
    });

    it('uses a one-day cache and a bounded npm request timeout', async () => {
        const lookup = vi.fn(async (_packageName: string, _options?: LatestVersionOptions) => ({
            name: '@pumpkin-plugins/build',
            local: '0.1.0',
            latest: '0.2.0',
            updatesAvailable: { local: '0.2.0', globalNpm: false as const, globalYarn: false as const },
        }));

        await startBuildUpdateCheck(['--types-only'], {
            environment: emptyEnvironment,
            isTTY: true,
            lookup,
            write: () => undefined,
        });

        const options = lookup.mock.calls[0]?.[1];
        expect(options?.useCache).toBe(true);
        expect(options?.cacheMaxAge).toBe(86_400_000);
        expect(options?.requestOptions?.timeout).toBeGreaterThan(0);
    });

    it('does not let lookup failures affect the build command', async () => {
        const output: string[] = [];
        const lookup = vi.fn(async (_packageName: string, _options?: LatestVersionOptions) => {
            throw new Error('registry unavailable');
        });

        await expect(
            startBuildUpdateCheck(['--types-only'], {
                environment: emptyEnvironment,
                isTTY: true,
                lookup,
                write: (notice) => output.push(notice),
            }),
        ).resolves.toBeUndefined();

        expect(output).toEqual([]);
    });

    it('ignores registry errors returned as lookup metadata', async () => {
        const lookup = vi.fn(async (_packageName: string, _options?: LatestVersionOptions) => ({
            name: '@pumpkin-plugins/build',
            error: new Error('registry unavailable'),
            updatesAvailable: false as const,
        }));
        const output: string[] = [];

        await startBuildUpdateCheck(['--types-only'], {
            environment: emptyEnvironment,
            isTTY: true,
            lookup,
            write: (notice) => output.push(notice),
        });

        expect(output).toEqual([]);
    });

    it.each([
        ['help', ['--help'], emptyEnvironment, true],
        ['short help', ['-h'], emptyEnvironment, true],
        ['version', ['--version'], emptyEnvironment, true],
        ['short version', ['-V'], emptyEnvironment, true],
        ['CI', ['--types-only'], { CI: 'true' }, true],
        ['development mode', ['--types-only'], { PUMPKIN_DEV_MODE: '1' }, true],
        ['non-interactive output', ['--types-only'], emptyEnvironment, false],
        ['command-line opt-out', ['--no-update-notifier'], emptyEnvironment, true],
        ['environment opt-out', ['--types-only'], { PUMPKIN_PLUGINS_NO_UPDATE_NOTIFIER: '1' }, true],
    ] as const)('skips update lookup for %s', (_scenario, args, environment, isTTY) => {
        expect(isBuildUpdateCheckAllowed(args, environment, isTTY)).toBe(false);
    });

    it('allows an interactive build without opt-outs to check for updates', () => {
        expect(isBuildUpdateCheckAllowed(['--types-only'], emptyEnvironment, true)).toBe(true);
    });
});
