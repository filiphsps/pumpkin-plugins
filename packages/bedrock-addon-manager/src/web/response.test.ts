import { strFromU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { noise } from '../../test/fixtures.ts';
import { FakeFile } from '../../test/transport.ts';
import type { HttpRequest } from './http.ts';
import { planResponse } from './response.ts';

const PACK = noise(1000, 5);

function plan(request: Partial<HttpRequest> | undefined, known = 'a.mcpack') {
    const files: FakeFile[] = [];
    const lookups: string[] = [];
    const result = planResponse(
        request && { method: 'GET', target: '/packs/a.mcpack', headers: {}, ...request },
        (name) => {
            lookups.push(name);
            if (name !== known) return undefined;
            const file = new FakeFile(PACK);
            files.push(file);
            return file;
        }
    );
    return { ...result, files, lookups, text: strFromU8(result.head) };
}

describe('planResponse', () => {
    it('streams a whole pack', () => {
        const p = plan({});
        expect(p.text).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
        expect(p.text).toContain('Content-Length: 1000\r\n');
        expect(p.body).toMatchObject({ offset: 0, remaining: 1000 });
        expect(p.files[0].closed).toBe(0);
    });

    it('streams just the requested range', () => {
        const p = plan({ headers: { range: 'bytes=100-199' } });
        expect(p.text).toMatch(/^HTTP\/1\.1 206 Partial Content\r\n/);
        expect(p.text).toContain('Content-Range: bytes 100-199/1000\r\n');
        expect(p.body).toMatchObject({ offset: 100, remaining: 100 });
    });

    it('sends only headers for HEAD and closes the file straight away', () => {
        const p = plan({ method: 'HEAD' });
        expect(p.text).toContain('Content-Length: 1000\r\n');
        expect(p.body).toBeUndefined();
        expect(p.files.map((f) => f.closed)).toEqual([1]);
    });

    it('rejects an unsatisfiable range with 416 and closes the file', () => {
        const p = plan({ headers: { range: 'bytes=5000-' } });
        expect(p.text).toMatch(/^HTTP\/1\.1 416 /);
        expect(p.text).toContain('Content-Range: bytes */1000\r\n');
        expect(p.body).toBeUndefined();
        expect(p.files.map((f) => f.closed)).toEqual([1]);
    });

    it('answers 404 for unknown packs without opening anything else', () => {
        expect(plan({ target: '/packs/nope.mcpack' }).text).toMatch(/^HTTP\/1\.1 404 /);
        expect(plan({ target: '/elsewhere' }).lookups).toEqual([]);
    });

    it('never looks up a name that tries to leave the packs folder', () => {
        const p = plan({ target: '/packs/..%2Fconfig.toml' });
        expect(p.text).toMatch(/^HTTP\/1\.1 404 /);
        expect(p.lookups).toEqual([]);
    });

    it('answers 405 for other methods and 400 for a malformed request', () => {
        expect(plan({ method: 'POST' }).text).toMatch(/^HTTP\/1\.1 405 [\s\S]*Allow: GET, HEAD/);
        expect(plan(undefined).text).toMatch(/^HTTP\/1\.1 400 /);
    });

    it('includes the whole body of an error in the head, with a matching length', () => {
        const p = plan({ target: '/packs/nope.mcpack' });
        expect(p.text.endsWith('\r\n\r\n404\n')).toBe(true);
        expect(p.text).toContain('Content-Length: 4\r\n');
    });

    it('handles an empty pack without trying to stream it', () => {
        const empty = planResponse(
            { method: 'GET', target: '/packs/e.mcpack', headers: {} },
            () => new FakeFile(new Uint8Array(0))
        );
        expect(strFromU8(empty.head)).toContain('Content-Length: 0\r\n');
        expect(empty.body).toBeUndefined();
    });
});
