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

    it('rejects malformed Market responses', () => {
        expect(() => checkMarketUpdate({ request: () => ({}), pluginName: 'Demo', currentVersion: '1.0.0' })).toThrow(
            'Invalid Market update response'
        );
    });
});
