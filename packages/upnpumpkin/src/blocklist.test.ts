import { describe, expect, it } from 'vitest';
import { BLOCKED_ROUTERS, type BlockedRouter, blockedReason, findBlocked, renderBlockedRouters } from './blocklist.ts';

const rules: BlockedRouter[] = [
    { manufacturer: 'Acme', match: /^acme\b/i, reason: 'Acme routers have no UPnP' },
    {
        manufacturer: 'Globex',
        match: /globex/i,
        models: [
            { name: 'GX-100', match: /^GX-100$/i },
            { name: 'GX-2xx', match: /^GX-2\d\d$/i }
        ],
        reason: 'Globex GX routers reboot when a port is opened'
    }
];

describe('findBlocked', () => {
    it('blocks every model of a make that is blocked as a whole', () => {
        expect(findBlocked({ manufacturer: 'ACME Corp', model: 'Anything', source: 'upnp' }, rules)?.reason).toBe(
            'Acme routers have no UPnP'
        );
        expect(findBlocked({ manufacturer: 'Acme', source: 'web' }, rules)).toBe(rules[0]);
    });

    it('blocks only the listed models of a make, by model, model number or name', () => {
        const globex = (extra: object) => findBlocked({ manufacturer: 'Globex Inc', source: 'upnp', ...extra }, rules);
        expect(globex({ model: 'GX-100' })).toBe(rules[1]);
        expect(globex({ modelNumber: 'GX-215' })).toBe(rules[1]);
        expect(globex({ name: 'GX-299' })).toBe(rules[1]);
        expect(globex({ model: 'GX-300' })).toBeUndefined();
    });

    it('leaves a make alone when only some models are blocked and the model is unknown', () => {
        expect(findBlocked({ manufacturer: 'Globex', source: 'web' }, rules)).toBeUndefined();
    });

    it('never matches a router that does not say who made it, or another make', () => {
        expect(findBlocked({ model: 'Acme X', source: 'upnp' }, rules)).toBeUndefined();
        expect(
            findBlocked({ manufacturer: 'AVM Berlin', model: 'FRITZ!Box 7590', source: 'upnp' }, rules)
        ).toBeUndefined();
    });
});

describe('the real blocklist', () => {
    it('blocks Telekom, however its routers say it', () => {
        expect(blockedReason({ manufacturer: 'Telekom', name: 'Speedport', source: 'web' })).toContain('Telekom');
        expect(
            blockedReason({ manufacturer: 'Deutsche Telekom AG', model: 'Speedport Smart 4', source: 'upnp' })
        ).toBeDefined();
    });

    it('does not block other makes', () => {
        expect(blockedReason({ manufacturer: 'AVM Berlin', model: 'FRITZ!Box 7590', source: 'upnp' })).toBeUndefined();
        expect(blockedReason({ manufacturer: 'TP-Link', source: 'upnp' })).toBeUndefined();
    });

    it('has a reason without a full stop for every rule, since it is quoted in sentences', () => {
        for (const rule of BLOCKED_ROUTERS) expect(rule.reason).not.toMatch(/[.!?]$/);
    });
});

describe('renderBlockedRouters', () => {
    it('lists the make, the models or "All models", and why', () => {
        expect(renderBlockedRouters(rules)).toBe(
            [
                '| Make | Models | Why |',
                '| --- | --- | --- |',
                '| Acme | All models | Acme routers have no UPnP. |',
                '| Globex | GX-100, GX-2xx | Globex GX routers reboot when a port is opened. |'
            ].join('\n')
        );
    });

    it('says so when nothing is blocked', () => {
        expect(renderBlockedRouters([])).toBe('No router is blocked.');
    });
});
