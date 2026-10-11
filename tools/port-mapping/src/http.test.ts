import { spawnSync } from 'node:child_process';
import { strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { httpRequest } from './http.ts';
import type { Connection, Dial } from './network.ts';
import { FakeNetwork, runSteps } from './testing/fake-network.ts';

/** A network whose one connection answers with fixed bytes, in the chunks given. */
function scripted(chunks: (Uint8Array | 'closed')[]): { net: FakeNetwork; written: number[]; closed: string[] } {
    const written: number[] = [];
    const closed: string[] = [];
    const net = new FakeNetwork();
    const queue = [...chunks];
    const connection: Connection = {
        localAddress: [192, 168, 1, 50],
        read: () => queue.shift() ?? null,
        writable: () => 8,
        write: (bytes) => void written.push(...bytes),
        close: () => void closed.push('closed')
    };
    net.dial = (): Dial => ({ poll: () => connection, abort: () => {} });
    return { net, written, closed };
}

const to = { address: [192, 168, 1, 1], port: 80 } as const;
const get = { method: 'GET', path: '/x' } as const;
const text = (s: string) => strToU8(s);

describe('httpRequest', () => {
    it('sends the request in pieces that fit and reads a Content-Length body', () => {
        const { net, written } = scripted([text('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhel'), text('lo')]);
        const response = runSteps(
            net,
            httpRequest(net, to, { method: 'POST', path: '/p', headers: { A: 'b' }, body: 'data' })
        );
        expect(response).toMatchObject({ status: 200, body: 'hello', localAddress: [192, 168, 1, 50] });
        const sent = String.fromCharCode(...written);
        expect(sent).toContain(
            'POST /p HTTP/1.1\r\nHost: 192.168.1.1:80\r\nConnection: close\r\nA: b\r\nContent-Length: 4\r\n\r\ndata'
        );
    });

    it('reads a body that ends when the peer closes', () => {
        const { net } = scripted([text('HTTP/1.1 200 OK\r\n\r\nall of it'), 'closed']);
        expect(runSteps(net, httpRequest(net, to, get)).body).toBe('all of it');
    });

    it('decodes chunked bodies, also when split across reads', () => {
        const { net } = scripted([
            text('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhel'),
            text('lo\r\n6\r\n world\r\n0\r\n\r\n')
        ]);
        expect(runSteps(net, httpRequest(net, to, get)).body).toBe('hello world');
    });

    it('accepts hexadecimal chunks with extensions', () => {
        const { net } = scripted([
            text('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nA;name=value\r\n0123456789\r\n0\r\n\r\n')
        ]);
        expect(runSteps(net, httpRequest(net, to, get)).body).toBe('0123456789');
    });

    it.each(['+1', '1x', '', '20000000000000'])('rejects invalid chunk size %j and closes the connection', (token) => {
        const { net, closed } = scripted([
            text(`HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${token}\r\nx\r\n0\r\n\r\n`),
            'closed'
        ]);
        expect(() => runSteps(net, httpRequest(net, to, get))).toThrow('invalid chunk size');
        expect(closed).toEqual(['closed']);
        const next = scripted([text('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok')]);
        expect(runSteps(next.net, httpRequest(next.net, to, get)).body).toBe('ok');
        expect(next.closed).toEqual(['closed']);
    });

    it('rejects a backward chunk cursor in a bounded subprocess', () => {
        const result = spawnSync(
            process.execPath,
            [
                '--input-type=module',
                '-e',
                `import { httpRequest } from ${JSON.stringify(new URL('./http.ts', import.meta.url).href)};
                const bytes = new TextEncoder().encode('HTTP/1.1 200 OK\\r\\nTransfer-Encoding: chunked\\r\\n\\r\\n-6\\r\\nx\\r\\n0\\r\\n\\r\\n');
                let closed = 0;
                const connection = { localAddress: [192,168,1,50], read: () => bytes,
                    writable: () => 65536, write: () => {}, close: () => closed++ };
                const net = { now: () => 0, dial: () => ({ poll: () => connection }) };
                try { httpRequest(net, { address: [192,168,1,1], port: 80 }, { method: 'GET', path: '/' }).next();
                    process.exitCode = 1;
                } catch (error) { console.log(JSON.stringify({ message: error.message, closed })); }`
            ],
            { encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL' }
        );
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({ message: 'invalid chunk size', closed: 1 });
    });

    it('waits for a split zero terminator and trailers', () => {
        const { net, closed } = scripted([
            text('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx\r\n0\r\n'),
            text('Checksum: yes\r\n'),
            text('\r\n')
        ]);
        expect(runSteps(net, httpRequest(net, to, get)).body).toBe('x');
        // A malformed later trailer must not be skipped by completing at the zero-size line.
        expect(closed).toEqual(['closed']);
        const malformed = scripted([
            text('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n'),
            text('not-a-header\r\n\r\n')
        ]);
        expect(() => runSteps(malformed.net, httpRequest(malformed.net, to, get))).toThrow('invalid chunk trailer');
        expect(malformed.closed).toEqual(['closed']);
    });

    it.each(['1\r\nx!!0\r\n\r\n', '1\r\nx\r!0\r\n\r\n'])('rejects a chunk without its trailing CRLF: %j', (body) => {
        const { net, closed } = scripted([
            text(`HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${body}`),
            'closed'
        ]);
        expect(() => runSteps(net, httpRequest(net, to, get))).toThrow('invalid chunk delimiter');
        expect(closed).toEqual(['closed']);
    });

    it.each(['1\r\n', '3\r\nx', '1\r\nx\r\n', '0\r\n', '0\r\nChecksum: yes\r\n'])(
        'rejects a chunked body closed before completion: %j',
        (body) => {
            const { net, closed } = scripted([
                text(`HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${body}`),
                'closed'
            ]);
            expect(() => runSteps(net, httpRequest(net, to, get))).toThrow('truncated chunked body');
            expect(closed).toEqual(['closed']);
        }
    );

    it.each(['-1', '+1', '1x', '1.5', '', '9007199254740992'])('rejects invalid Content-Length %j', (length) => {
        const { net, closed } = scripted([text(`HTTP/1.1 200 OK\r\nContent-Length: ${length}\r\n\r\nx`), 'closed']);
        expect(() => runSteps(net, httpRequest(net, to, get))).toThrow('invalid Content-Length');
        expect(closed).toEqual(['closed']);
    });

    it('rejects a peer closing before Content-Length bytes arrive', () => {
        const { net, closed } = scripted([text('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhi'), 'closed']);
        expect(() => runSteps(net, httpRequest(net, to, get))).toThrow('truncated Content-Length body');
        expect(closed).toEqual(['closed']);
    });

    it('accepts zero Content-Length without waiting for peer closure', () => {
        const { net, closed } = scripted([text('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n')]);
        expect(runSteps(net, httpRequest(net, to, get)).body).toBe('');
        expect(closed).toEqual(['closed']);
    });

    it('reports error statuses to the caller', () => {
        const { net } = scripted([text('HTTP/1.1 500 X\r\nContent-Length: 2\r\n\r\nno')]);
        expect(runSteps(net, httpRequest(net, to, get))).toMatchObject({ status: 500, body: 'no' });
    });

    it('fails on answers that are not HTTP', () => {
        const { net } = scripted([text('SSH-2.0-OpenSSH\r\n\r\n'), 'closed']);
        expect(() => runSteps(net, httpRequest(net, to, get))).toThrow('not HTTP');
    });

    it('fails when nothing arrives in time and closes the connection', () => {
        const net = new FakeNetwork();
        const closed: string[] = [];
        const connection: Connection = {
            localAddress: [1, 1, 1, 1],
            read: () => null,
            writable: () => 100,
            write: () => {},
            close: () => void closed.push('x')
        };
        net.dial = (): Dial => ({ poll: () => connection, abort: () => {} });
        expect(() => runSteps(net, httpRequest(net, to, get, 1000))).toThrow('took too long');
        expect(closed).toEqual(['x']);
    });

    it('fails when the connection cannot be made, and when a connection never comes up', () => {
        const net = new FakeNetwork();
        expect(() => runSteps(net, httpRequest(net, to, get))).toThrow('connection refused');

        const stuck = new FakeNetwork();
        let aborted = false;
        stuck.dial = (): Dial => ({
            poll: () => undefined,
            abort: () => {
                aborted = true;
            }
        });
        expect(() => runSteps(stuck, httpRequest(stuck, to, get, 500))).toThrow('could not connect');
        expect(aborted).toBe(true);
    });
});
