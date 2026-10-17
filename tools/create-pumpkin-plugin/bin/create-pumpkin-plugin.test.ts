import { describe, expect, it, vi } from 'vitest';
import { chooseLanguage, detectPackageManager } from './create-pumpkin-plugin.ts';

describe('chooseLanguage', () => {
    it('uses the prompt for an interactive caller without a language flag', async () => {
        const prompt = vi.fn(async () => 'javascript' as const);

        await expect(chooseLanguage({}, true, prompt)).resolves.toBe('javascript');
        expect(prompt).toHaveBeenCalledOnce();
    });
});

describe('detectPackageManager', () => {
    it.each([
        ['pnpm/12.10.1 npm/? node/v24.21.0 darwin arm64', 'pnpm'],
        ['npm/11.0.0 node/v24.21.0 darwin arm64', 'npm'],
        ['yarn/1.22.22 npm/? node/v24.21.0 darwin arm64', 'yarn'],
        ['yarn/4.9.2 npm/? node/v24.21.0 darwin arm64', 'yarn'],
        ['bun/1.2.0', 'bun'],
    ] as const)('detects %s from the package-manager user agent', (userAgent, expected) => {
        expect(detectPackageManager({ npm_config_user_agent: userAgent })).toBe(expected);
    });

    it('detects pnpm from the launcher path when no user agent is available', () => {
        expect(detectPackageManager({ npm_execpath: '/opt/pnpm/bin/pnpm.cjs' })).toBe('pnpm');
    });

    it('uses uppercase launcher variables when lowercase variants are absent', () => {
        expect(detectPackageManager({ NPM_CONFIG_USER_AGENT: 'YARN/4.9.2 npm/? node/v24.21.0' })).toBe('yarn');
    });

    it('returns no package manager for unknown launcher metadata', () => {
        expect(
            detectPackageManager({
                npm_config_user_agent: 'custom/1.0.0 node/v24.21.0',
                npm_execpath: '/opt/custom/bin/custom-cli.js',
            }),
        ).toBeUndefined();
    });
});
