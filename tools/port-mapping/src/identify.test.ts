import { describe, expect, it } from 'vitest';
import { describeIdentity, probeWeb } from './identify.ts';
import { FakeIgd } from './testing/fake-igd.ts';
import { FakeNetwork, runSteps } from './testing/fake-network.ts';

describe('describeIdentity', () => {
    it('joins the maker and the model, without repeating the maker', () => {
        expect(describeIdentity({ manufacturer: 'AVM', model: 'FRITZ!Box 7590', source: 'upnp' })).toBe(
            'AVM FRITZ!Box 7590'
        );
        expect(describeIdentity({ manufacturer: 'Netgear', model: 'Netgear R7000', source: 'upnp' })).toBe(
            'Netgear R7000'
        );
    });

    it('falls back to what the router calls itself, then to the maker alone', () => {
        expect(describeIdentity({ manufacturer: 'Telekom', name: 'Speedport', source: 'web' })).toBe(
            'Telekom Speedport'
        );
        expect(describeIdentity({ manufacturer: 'Telekom', source: 'web' })).toBe('Telekom');
        expect(describeIdentity({ name: 'Home gateway', source: 'upnp' })).toBe('Home gateway');
        expect(describeIdentity({ source: 'upnp' })).toBe('unknown router');
    });
});

describe('probeWeb', () => {
    const login = (title: string) => ({ '/html/login/index.html': { body: `<html><head><title>${title}</title>` } });

    it('recognises a Speedport by its public login page', () => {
        const net = new FakeNetwork([
            new FakeIgd({ upnp: false, natPmp: false, webPages: login('Speedport Konfigurationsprogramm') })
        ]);
        expect(
            runSteps(
                net,
                probeWeb(net, [
                    [192, 168, 1, 254],
                    [192, 168, 1, 1]
                ])
            )
        ).toEqual({
            manufacturer: 'Telekom',
            name: 'Speedport',
            source: 'web'
        });
        expect(net.leaks).toBe(0);
    });

    it('recognises nothing from another router, a missing page or a page that is not Speedport', () => {
        const net = new FakeNetwork([new FakeIgd({ webPages: login('FRITZ!Box') })]);
        expect(runSteps(net, probeWeb(net, [[192, 168, 1, 1]]))).toBeUndefined();
        expect(runSteps(net, probeWeb(net, [[192, 168, 1, 77]]))).toBeUndefined();

        const missing = new FakeNetwork([new FakeIgd()]);
        expect(runSteps(missing, probeWeb(missing, [[192, 168, 1, 1]]))).toBeUndefined();

        const error = new FakeNetwork([
            new FakeIgd({ webPages: { '/html/login/index.html': { status: 404, body: '<title>Speedport</title>' } } })
        ]);
        expect(runSteps(error, probeWeb(error, [[192, 168, 1, 1]]))).toBeUndefined();
    });
});
