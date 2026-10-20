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
        {
            now: () => clock.now,
            idleTimeoutMs: 1000,
            minProgressBytes: 1,
            writeBudget: 1 << 20,
            chunkSize: 1 << 20,
            ...options,
        },
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

    it('answers HEAD for an unknown pack without sending the GET error body', () => {
        const t = setup();
        t.transport.inbound.push(strToU8('HEAD /packs/nope.mcpack HTTP/1.1\r\n\r\n'));
        t.run();

        const res = t.transport.response();
        expect(res.status).toBe(404);
        expect(res.headers['Content-Type']).toBe('text/plain');
        expect(res.headers['Content-Length']).toBe('4');
        expect(res.body).toHaveLength(0);
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

    it('drops an incomplete head at its absolute deadline despite trickle progress', () => {
        const t = setup();
        for (const now of [0, 900, 999]) {
            t.clock.now = now;
            t.transport.inbound.push(strToU8('G'));
            expect(t.session.tick()).toBe(true);
        }
        t.clock.now = 1000;
        t.transport.inbound.push(get('/packs/a.mcpack'));
        expect(t.session.tick()).toBe(false);
        expect(t.transport.aborted).toBe(true);
        expect(t.lookups).toEqual([]);
        expect(t.files).toEqual([]);
    });

    it('allows a completed head and a progressing download to outlive the head deadline', () => {
        const t = setup({ writeBudget: 500 });
        t.clock.now = 999;
        t.transport.inbound.push(get('/packs/a.mcpack'));
        for (let i = 0; i < 20; i++) {
            t.transport.space = 500;
            const active = t.session.tick();
            t.clock.now += 500;
            if (!active) break;
        }
        expect(t.transport.response().body).toEqual(PACK);
        expect(t.clock.now).toBeGreaterThan(1000);
        expect(t.transport.aborted).toBe(false);
        expect(t.files[0].closed).toBe(1);
    });

    it('drops a download whose client reads only a few bytes at a time', () => {
        const t = setup({ minProgressBytes: 1000 });
        t.transport.inbound.push(get('/packs/a.mcpack'));
        let active = true;
        for (let tick = 0; tick < 100 && active; tick++) {
            t.transport.space = 10;
            active = t.session.tick();
            t.clock.now += 100;
        }
        expect(active).toBe(false);
        expect(t.transport.aborted).toBe(true);
        expect(t.transport.written.length).toBeLessThan(PACK.length);
        expect(t.files.map((f) => f.closed)).toEqual([1]);
    });

    it('keeps a slow download that still moves the minimum each timeout', () => {
        const t = setup({ minProgressBytes: 1000, chunkSize: 1200 });
        t.transport.inbound.push(get('/packs/a.mcpack'));
        let active = true;
        for (let tick = 0; tick < 100 && active; tick++) {
            t.transport.space = 1200;
            active = t.session.tick();
            t.clock.now += 900;
        }
        expect(t.transport.aborted).toBe(false);
        expect(t.transport.response().body).toEqual(PACK);
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

    it('services deadlines and releases the file even when both shared quotas are exhausted', () => {
        const t = setup({ writeBudget: 500 });
        t.transport.inbound.push(get('/packs/a.mcpack'));
        expect(t.session.tick()).toBe(true);
        const written = t.transport.written.length;
        t.clock.now = 1001;
        expect(t.session.tick({ bytes: 0, operations: 0 })).toBe(false);
        expect(t.transport.written.length).toBe(written);
        expect(t.transport.aborted).toBe(true);
        expect(t.files[0].closed).toBe(1);
    });

    it.each([1, 2])('retains the byte reservation when write %s throws after accepting data', (failAt) => {
        const first = setup({ writeBudget: 400, chunkSize: 100 });
        const second = setup({ writeBudget: 400, chunkSize: 100 });
        const request = get('/packs/a.mcpack');
        first.transport.inbound.push(request);
        second.transport.inbound.push(request);
        const write = first.transport.write.bind(first.transport);
        let writes = 0;
        first.transport.write = (bytes) => {
            write(bytes);
            if (++writes === failAt) throw new Error('write outcome unknown');
        };
        const quota = { bytes: 400, operations: 64 };
        expect(first.session.tick(quota)).toBe(false);
        second.session.tick(quota);
        const bytes = first.transport.written.length + second.transport.written.length + request.length * 2;
        expect(bytes).toBeLessThanOrEqual(400);
        expect(first.files[0].closed).toBe(1);
        first.session.abort();
        second.session.abort();
        expect(first.files[0].closed).toBe(1);
    });

    it('retains the requested byte reservation when a read has an unknown outcome', () => {
        const first = setup();
        const second = setup();
        let attempted = 0;
        first.transport.read = (max) => {
            attempted = max;
            throw new Error('read outcome unknown');
        };
        second.transport.inbound.push(get('/packs/a.mcpack'));
        const quota = { bytes: 400, operations: 64 };
        expect(first.session.tick(quota)).toBe(false);
        expect(attempted).toBe(400);
        expect(quota.bytes).toBe(0);
        expect(second.session.tick(quota)).toBe(true);
        expect(second.lookups).toEqual([]);
        expect(second.transport.written).toEqual([]);
        second.session.abort();
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
