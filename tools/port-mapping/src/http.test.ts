import { strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { httpRequest } from './http.ts';
import type { Connection, Dial } from './network.ts';
import { FakeNetwork, runSteps } from './testing/fake-network.ts';

/** A network whose one connection answers with fixed bytes, in the chunks given. */
function scripted(chunks: (Uint8Array | 'closed')[]): { net: FakeNetwork; written: number[] } {
    const written: number[] = [];
    const net = new FakeNetwork();
    const queue = [...chunks];
    const connection: Connection = {
        localAddress: [192, 168, 1, 50],
        read: () => queue.shift() ?? null,
        writable: () => 8,
        write: (bytes) => void written.push(...bytes),
        close: () => {}
    };
    net.dial = (): Dial => ({ poll: () => connection, abort: () => {} });
    return { net, written };
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
