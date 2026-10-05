import { describe, expect, it } from 'vitest';
import { checkMarketUpdate } from './market.ts';

describe('checkMarketUpdate', () => {
    it('requests the latest Market version for the exact plugin name', () => {
        let requestedUrl = '';
        const request = (url: string) => {
            requestedUrl = url;
            return { latest_version: '1.4.0', update_available: true };
        };
        const result = checkMarketUpdate({ request, pluginName: 'Plugin & more', currentVersion: '1.3.0' });
        expect(new URL(requestedUrl).searchParams.get('plugin_name')).toBe('Plugin & more');
        expect(result).toEqual({ currentVersion: '1.3.0', latestVersion: '1.4.0', updateAvailable: true });
    });

    it('reports no update when Market has no stable version', () => {
        expect(
            checkMarketUpdate({
                request: () => ({ latest_version: null, update_available: false }),
                pluginName: 'Demo',
                currentVersion: '1.0.0'
            })
        ).toEqual({ currentVersion: '1.0.0', latestVersion: null, updateAvailable: false });
    });

    it.each([
        {},
        null,
        [],
        { update_available: false },
        { latest_version: 12, update_available: false },
        { latest_version: null, update_available: true },
        { latest_version: '1.0.0', update_available: 'true' }
    ])('rejects malformed Market response %j', (response) => {
        expect(() =>
            checkMarketUpdate({ request: () => response, pluginName: 'Demo', currentVersion: '1.0.0' })
        ).toThrow('Invalid Market update response');
    });
    it('compares versions instead of trusting a stale update flag', () => {
        const result = checkMarketUpdate({
            request: () => ({ latest_version: '1.0.0', update_available: true }),
            pluginName: 'Demo',
            currentVersion: '2.0.0'
        });
        expect(result.updateAvailable).toBe(false);
    });

    it('validates the installed version when no release exists', () => {
        expect(() =>
            checkMarketUpdate({
                request: () => ({ latest_version: null, update_available: false }),
                pluginName: 'Demo',
                currentVersion: 'invalid'
            })
        ).toThrow('Invalid semantic version');
    });
});
