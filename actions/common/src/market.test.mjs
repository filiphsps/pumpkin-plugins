import assert from 'node:assert/strict';
import * as http from 'node:http';
import { describe, it } from 'node:test';
import { findListingById, findListingByName, marketUrl } from './market.mjs';

function server(handler) {
    return new Promise((resolve) => {
        const instance = http.createServer(handler).listen(0, '127.0.0.1', () => {
            const address = instance.address();
            resolve({ instance, url: `http://127.0.0.1:${address.port}` });
        });
    });
}

function json(response, value) {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(value));
}

describe('shared Market API helpers', () => {
    it('defaults to the public Market and trims trailing slashes', () => {
        assert.equal(marketUrl(''), 'https://market.pumpkinmc.org');
        assert.equal(marketUrl('https://market.example.test//'), 'https://market.example.test');
    });

    it('accepts plain HTTP only for a loopback test server', () => {
        assert.equal(marketUrl('http://127.0.0.1:8080/'), 'http://127.0.0.1:8080');
        assert.equal(marketUrl('http://localhost:8080'), 'http://localhost:8080');
        assert.throws(() => marketUrl('http://market.example.test'), /api-url must use https/);
        assert.throws(() => marketUrl('not a url'), /api-url must be an absolute URL/);
    });

    it('treats a missing ID as absent and rejects a malformed listing', async () => {
        const market = await server((request, response) => {
            if (request.url.endsWith('/missing')) {
                response.statusCode = 404;
                response.end('not found');
            } else json(response, { id: 'not-a-number', name: 'Listing', version: null });
        });
        try {
            assert.equal(await findListingById(market.url, 'missing'), undefined);
            await assert.rejects(findListingById(market.url, 'broken'), /not a valid listing/);
        } finally {
            market.instance.close();
        }
    });

    it('finds an exact name that Market search ranks below the first page', async () => {
        const pages = [];
        const market = await server((request, response) => {
            const page = Number(new URL(request.url, 'http://test').searchParams.get('page'));
            pages.push(page);
            if (page === 1) {
                json(
                    response,
                    Array.from({ length: 20 }, (_, index) => ({
                        id: index + 1,
                        name: `Tab ${index}`,
                        version: '1.0.0',
                    })),
                );
            } else json(response, [{ id: 99, name: 'Tab', version: '2.0.0' }]);
        });
        try {
            const listing = await findListingByName(market.url, 'tab');
            assert.equal(listing?.id, 99);
            assert.deepEqual(pages, [1, 2], 'search stops after the first short page');
        } finally {
            market.instance.close();
        }
    });

    it('bounds a name search that never runs out of results', async () => {
        let requests = 0;
        const market = await server((_request, response) => {
            requests++;
            json(
                response,
                Array.from({ length: 20 }, (_, index) => ({ id: index + 1, name: `Other ${index}`, version: null })),
            );
        });
        try {
            await assert.rejects(findListingByName(market.url, 'Tab'), /use plugin-id/);
            assert.ok(requests <= 10, `search made ${requests} requests`);
        } finally {
            market.instance.close();
        }
    });

    it('counts a listing repeated across pages once', async () => {
        // A server that ignores the page parameter returns the same full page every time.
        const market = await server((_request, response) =>
            json(
                response,
                Array.from({ length: 20 }, (_, index) => ({
                    id: index + 1,
                    name: index === 0 ? 'Tab' : `Tab ${index}`,
                    version: '1.0.0',
                })),
            ),
        );
        try {
            assert.equal((await findListingByName(market.url, 'Tab'))?.id, 1);
        } finally {
            market.instance.close();
        }
    });

    it('rejects an exact name match whose listing data is malformed', async () => {
        const market = await server((_request, response) => json(response, [{ id: 7, name: 'Listing', version: 3 }]));
        try {
            await assert.rejects(findListingByName(market.url, 'listing'), /not a valid listing/);
        } finally {
            market.instance.close();
        }
    });
});
