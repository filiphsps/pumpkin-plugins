import { strFromU8, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { noise } from '../../test/fixtures.ts';
import { FakeFile, FakeTransport } from '../../test/transport.ts';
import { HttpSession, type SessionOptions } from './session.ts';

const PACK = noise(5000, 7);
const get = (target: string, headers = '') => strToU8(`GET ${target} HTTP/1.1\r\nHost: t\r\n${headers}\r\n`);

function setup(options: Partial<SessionOptions> = {}) {
    const clock = { now: 0 };
    const transport = new FakeTransport();
    const files: FakeFile[] = [];
    const lookups: string[] = [];
    const session = new HttpSession(
        transport,
        (name) => {
            lookups.push(name);
            if (name !== 'a.mcpack') return undefined;
            const file = new FakeFile(PACK);
            files.push(file);
            return file;
        },
        { now: () => clock.now, idleTimeoutMs: 1000, writeBudget: 1 << 20, chunkSize: 1 << 20, ...options }
    );
    /** Ticks until the session ends or `maxTicks` pass, giving the transport `space` bytes each tick. */
    const run = (maxTicks = 1000, space = Number.POSITIVE_INFINITY) => {
        let ticks = 0;
        for (; ticks < maxTicks; ticks++) {
            transport.space = space;
            if (!session.tick()) break;
        }
        return ticks;
    };
    return { clock, transport, files, lookups, session, run };
}

describe('HttpSession', () => {
    it('serves a whole pack', () => {
        const t = setup();
        t.transport.inbound.push(get('/packs/a.mcpack'));
        t.run();
        const res = t.transport.response();
        expect(res.status).toBe(200);
        expect(res.headers['Content-Length']).toBe(String(PACK.length));
        expect(res.headers['Content-Type']).toBe('application/zip');
        expect(res.headers['Accept-Ranges']).toBe('bytes');
        expect(res.body).toEqual(PACK);
        expect(t.files.map((f) => f.closed)).toEqual([1]);
        expect(t.transport.aborted).toBe(false);
    });

    it('answers HEAD with the headers of a GET and no body', () => {
        const t = setup();
        t.transport.inbound.push(strToU8('HEAD /packs/a.mcpack HTTP/1.1\r\n\r\n'));
        t.run();
        const res = t.transport.response();
        expect(res.status).toBe(200);
        expect(res.headers['Content-Length']).toBe(String(PACK.length));
        expect(res.body).toHaveLength(0);
        expect(t.files.map((f) => f.closed)).toEqual([1]);
    });

    it('serves byte ranges', () => {
        const range = (header: string) => {
            const t = setup();
            t.transport.inbound.push(get('/packs/a.mcpack', `Range: ${header}\r\n`));
            t.run();
            return t.transport.response();
        };
        const part = range('bytes=100-199');
        expect(part.status).toBe(206);
        expect(part.headers['Content-Range']).toBe(`bytes 100-199/${PACK.length}`);
        expect(part.headers['Content-Length']).toBe('100');
        expect(part.body).toEqual(PACK.subarray(100, 200));

        expect(range('bytes=-10').body).toEqual(PACK.subarray(PACK.length - 10));
        expect(range('bytes=4990-').body).toEqual(PACK.subarray(4990));

        const bad = range('bytes=99999-');
        expect(bad.status).toBe(416);
        expect(bad.headers['Content-Range']).toBe(`bytes */${PACK.length}`);
        expect(bad.body).toHaveLength(0);

        expect(range('bytes=0-1,5-6')).toMatchObject({ status: 200 });
    });

    it('closes the file for a rejected range too', () => {
        const t = setup();
        t.transport.inbound.push(get('/packs/a.mcpack', 'Range: bytes=99999-\r\n'));
        t.run();
        expect(t.files.map((f) => f.closed)).toEqual([1]);
    });

    it('404s unknown packs and anything outside /packs/', () => {
        for (const target of ['/packs/nope.mcpack', '/', '/config.toml']) {
            const t = setup();
            t.transport.inbound.push(get(target));
            t.run();
            expect(t.transport.response().status, target).toBe(404);
        }
    });

    it('never looks up a path that tries to leave the packs folder', () => {
        const t = setup();
        t.transport.inbound.push(get('/packs/..%2Fconfig.toml'));
        t.run();
        expect(t.transport.response().status).toBe(404);
        expect(t.lookups).toEqual([]);
    });

    it('rejects other methods and malformed requests', () => {
        const post = setup();
        post.transport.inbound.push(strToU8('POST /packs/a.mcpack HTTP/1.1\r\n\r\n'));
        post.run();
        expect(post.transport.response()).toMatchObject({ status: 405, headers: { Allow: 'GET, HEAD' } });

        const junk = setup();
        junk.transport.inbound.push(strToU8('not http at all\r\n\r\n'));
        junk.run();
        expect(junk.transport.response().status).toBe(400);
    });

    it('answers 400 to a request head that never ends', () => {
        const t = setup();
        t.transport.inbound.push(new Uint8Array(9000).fill(65));
        t.run();
        expect(t.transport.response().status).toBe(400);
    });

    it('assembles a request that arrives in pieces over several ticks', () => {
        const t = setup();
        for (const byte of get('/packs/a.mcpack')) t.transport.inbound.push(Uint8Array.of(byte));
        t.run();
        expect(t.transport.response().status).toBe(200);
        expect(t.transport.response().body).toEqual(PACK);
    });

    it('copes with a reader that accepts only a few bytes per tick', () => {
        const t = setup({ chunkSize: 64 });
        t.transport.inbound.push(get('/packs/a.mcpack'));
        const ticks = t.run(5000, 37);
        expect(ticks).toBeGreaterThan(100);
        expect(t.transport.response().body).toEqual(PACK);
        expect(Math.max(...t.files[0].reads)).toBeLessThanOrEqual(37);
    });

    it('sends at most the write budget per tick', () => {
        const t = setup({ writeBudget: 500 });
        t.transport.inbound.push(get('/packs/a.mcpack'));
        t.transport.space = Number.POSITIVE_INFINITY;
        t.session.tick();
        expect(t.transport.written.length).toBeLessThanOrEqual(500);
        t.run();
        expect(t.transport.response().body).toEqual(PACK);
    });

    it('keeps ticking until the transport reports the connection closed', () => {
        const t = setup();
        t.transport.finishAfter = 4;
        t.transport.inbound.push(get('/packs/a.mcpack'));
        t.run();
        expect(t.session.tick()).toBe(false);
        expect(t.transport.written.length).toBeGreaterThan(PACK.length);
    });

    it('drops a connection that goes quiet', () => {
        const t = setup();
        t.transport.inbound.push(strToU8('GET /packs/a.mcpack HTT'));
        t.run(3);
        t.clock.now = 5000;
        expect(t.session.tick()).toBe(false);
        expect(t.transport.aborted).toBe(true);
    });

    it('drops a download whose client stopped reading', () => {
        const t = setup();
        t.transport.inbound.push(get('/packs/a.mcpack'));
        t.run(5, 100);
        t.clock.now = 5000;
        t.transport.space = 0;
        expect(t.session.tick()).toBe(false);
        expect(t.transport.aborted).toBe(true);
        expect(t.files.map((f) => f.closed)).toEqual([1]);
    });

    it('closes the file when the client disconnects mid-download', () => {
        const t = setup();
        t.transport.inbound.push(get('/packs/a.mcpack'));
        t.run(2, 100);
        t.transport.failWrites = true;
        t.transport.space = 1000;
        expect(t.session.tick()).toBe(false);
        expect(t.transport.aborted).toBe(true);
        expect(t.files.map((f) => f.closed)).toEqual([1]);
    });

    it('ends quietly when the client hangs up before sending a request', () => {
        const t = setup();
        t.transport.inbound.push('closed');
        expect(t.session.tick()).toBe(false);
        expect(t.transport.aborted).toBe(true);
        expect(t.lookups).toEqual([]);
    });

    it('gives a short error body that matches its Content-Length', () => {
        const t = setup();
        t.transport.inbound.push(get('/packs/nope.mcpack'));
        t.run();
        const res = t.transport.response();
        expect(strFromU8(res.body)).toBe('404\n');
        expect(res.headers['Content-Length']).toBe(String(res.body.length));
    });
});
