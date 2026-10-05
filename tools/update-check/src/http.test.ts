import { strToU8 } from 'fflate';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
    handle: vi.fn(),
    now: vi.fn(),
    created: [] as Array<{ name: string; drop: ReturnType<typeof vi.fn> }>,
    dropped: [] as string[],
    fail: ''
}));
vi.mock('wasi:clocks/monotonic-clock@0.2.3', () => ({ now: host.now }));
vi.mock('wasi:http/outgoing-handler@0.2.3', () => ({ handle: host.handle }));
vi.mock('wasi:http/types@0.2.3', () => {
    class Resource {
        constructor(public name: string) {
            host.created.push(this);
        }
        drop = vi.fn(() => {
            host.dropped.push(this.name);
        });
    }
    return {
        Fields: class extends Resource {
            constructor() {
                super('fields');
            }
            set() {
                if (host.fail === 'headers') throw new Error('header failure');
            }
        },
        OutgoingRequest: class extends Resource {
            constructor(_fields: unknown) {
                super('request');
            }
            setMethod() {}
            setScheme() {}
            setAuthority() {
                if (host.fail === 'authority') throw new Error('authority failure');
            }
            setPathWithQuery = vi.fn();
        },
        RequestOptions: class extends Resource {
            constructor() {
                super('options');
            }
            setConnectTimeout() {
                if (host.fail === 'timeout') throw new Error('timeout failure');
            }
            setFirstByteTimeout() {}
            setBetweenBytesTimeout() {}
        }
    };
});

import { requestMarketJson, requestMarketJsonAsync } from './http.ts';

const closed = { payload: { tag: 'closed' } };
function resource(name: string) {
    const result = {
        name,
        drop: vi.fn(() => {
            host.dropped.push(name);
        })
    };
    host.created.push(result);
    return result;
}
function transport(chunks: Array<Uint8Array | object> = [strToU8('{"message":"héllo"}'), closed]) {
    const headers = { ...resource('headers-pollable'), ready: vi.fn(() => true), block: vi.fn() };
    const bytes = { ...resource('stream-pollable'), ready: vi.fn(() => true), block: vi.fn() };
    const stream = {
        ...resource('stream'),
        subscribe: vi.fn(() => bytes),
        read: vi.fn(() => {
            const chunk = chunks.shift() ?? closed;
            if (!(chunk instanceof Uint8Array)) throw chunk;
            return chunk;
        })
    };
    const body = { ...resource('body'), stream: vi.fn(() => stream) };
    const response = { ...resource('response'), status: vi.fn(() => 200), consume: vi.fn(() => body) };
    const future = {
        ...resource('future'),
        subscribe: vi.fn(() => headers),
        get: vi.fn(() => ({ tag: 'ok', val: { tag: 'ok', val: response } }))
    };
    host.handle.mockReturnValue(future);
    return { headers, bytes, stream, body, response, future };
}
function asyncRequest(url = 'https://example.test/api') {
    const queued: Array<() => void> = [];
    const complete = vi.fn();
    requestMarketJsonAsync(
        url,
        (callback) => {
            queued.push(callback);
        },
        complete
    );
    return {
        complete,
        queued,
        drain: () => {
            let count = 0;
            while (queued.length) {
                if (++count > 100) throw new Error('Request did not finish');
                queued.shift()?.();
            }
        }
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    host.created.length = 0;
    host.dropped.length = 0;
    host.fail = '';
    host.now.mockReturnValue(0);
});

describe('WASI HTTP requests', () => {
    it('waits for readiness without blocking and releases children before parents', () => {
        const t = transport([new Uint8Array(), strToU8('{"message":"hé'), strToU8('llo"}'), closed]);
        t.headers.ready.mockReturnValueOnce(false);
        t.bytes.ready.mockReturnValueOnce(false);
        const request = asyncRequest();
        expect(t.future.get).not.toHaveBeenCalled();
        request.queued.shift()?.();
        expect(t.future.get).not.toHaveBeenCalled();
        request.drain();
        expect(request.complete).toHaveBeenCalledExactlyOnceWith({ ok: true, value: { message: 'héllo' } });
        expect(t.headers.block).not.toHaveBeenCalled();
        expect(t.bytes.block).not.toHaveBeenCalled();
        expect(host.dropped).toEqual(['headers-pollable', 'stream-pollable', 'stream', 'body', 'response', 'future']);
    });

    it('continues synchronous reads after an empty chunk', () => {
        transport([strToU8('{'), new Uint8Array(), strToU8('"ok":true}'), closed]);
        expect(requestMarketJson('https://example.test')).toEqual({ ok: true });
        expect(host.dropped).toEqual(['headers-pollable', 'stream-pollable', 'stream', 'body', 'response', 'future']);
    });

    it.each(['http://example.test?query=1#fragment', 'HTTPS://example.test/?query=1'])('supports URL %s', (url) => {
        transport();
        expect(requestMarketJson(url)).toEqual({ message: 'héllo' });
        const request = host.created.find((r) => r.name === 'request') as unknown as {
            setPathWithQuery: ReturnType<typeof vi.fn>;
        };
        expect(request.setPathWithQuery).toHaveBeenCalledWith('/?query=1');
    });

    it.each(['ftp://example.test', 'https://user@example.test/', 'https://example.test/hello world'])(
        'rejects invalid URL %s before sending',
        (url) => {
            const request = asyncRequest(url);
            expect(request.complete).toHaveBeenCalledWith({
                ok: false,
                error: expect.objectContaining({ message: expect.stringContaining('parse URL') })
            });
            expect(host.handle).not.toHaveBeenCalled();
        }
    );

    it.each(['headers', 'authority', 'timeout'])('cleans up when configuring %s fails', (stage) => {
        host.fail = stage;
        const request = asyncRequest();
        expect(request.complete).toHaveBeenCalledOnce();
        expect(host.dropped).toEqual(
            stage === 'headers' ? ['fields'] : stage === 'authority' ? ['request'] : ['options', 'request']
        );
    });

    it('retains the failing operation in errors', () => {
        const t = transport();
        t.response.status.mockReturnValue(503);
        const request = asyncRequest();
        request.drain();
        expect(request.complete).toHaveBeenCalledWith({
            ok: false,
            error: expect.objectContaining({ message: 'WASI HTTP read response status: Market returned HTTP 503' })
        });
        expect(host.dropped).toEqual(['headers-pollable', 'response', 'future']);
    });

    it.each([
        [[strToU8('not JSON'), closed], 'parse response JSON'],
        [[new Uint8Array(65537)], 'too large'],
        [[{ payload: { tag: 'last-operation-failed' } }], 'read response stream']
    ] as const)('reports body failure %# and frees resources', (chunks, message) => {
        transport([...chunks]);
        const request = asyncRequest();
        request.drain();
        expect(request.complete).toHaveBeenCalledWith({
            ok: false,
            error: expect.objectContaining({ message: expect.stringContaining(message) })
        });
        expect(host.dropped).toEqual(['headers-pollable', 'stream-pollable', 'stream', 'body', 'response', 'future']);
    });

    it('bounds requests that remain pending and ignores stale scheduled polls', () => {
        const t = transport();
        t.headers.ready.mockReturnValue(false);
        const request = asyncRequest();
        const poll = request.queued[0];
        host.now.mockReturnValue(15_000_000_000);
        request.drain();
        poll();
        expect(request.complete).toHaveBeenCalledOnce();
        expect(request.complete).toHaveBeenCalledWith({
            ok: false,
            error: expect.objectContaining({ message: expect.stringContaining('timed out') })
        });
        expect(host.dropped).toEqual(['headers-pollable', 'future']);
    });

    it('releases resources when scheduling fails', () => {
        transport();
        const complete = vi.fn();
        requestMarketJsonAsync(
            'https://example.test',
            () => {
                throw new Error('scheduler unavailable');
            },
            complete
        );
        expect(complete).toHaveBeenCalledWith({
            ok: false,
            error: expect.objectContaining({ message: 'scheduler unavailable' })
        });
        expect(host.dropped).toEqual(['headers-pollable', 'future']);
    });

    it('does not swallow consumer exceptions', () => {
        transport();
        const queued: Array<() => void> = [];
        const complete = vi.fn(() => {
            throw new Error('consumer failed');
        });
        requestMarketJsonAsync(
            'https://example.test',
            (cb) => {
                queued.push(cb);
            },
            complete
        );
        expect(() => {
            while (queued.length) queued.shift()?.();
        }).toThrow('consumer failed');
        expect(complete).toHaveBeenCalledOnce();
        expect(host.dropped).toContain('future');
    });
    it('includes structured host error details', () => {
        const t = transport();
        t.future.get.mockReturnValue({
            tag: 'ok',
            val: { tag: 'err', val: { tag: 'dns-error', val: { rcode: 3 } } }
        } as never);
        const request = asyncRequest();
        request.drain();
        expect(request.complete).toHaveBeenCalledWith({
            ok: false,
            error: expect.objectContaining({ message: expect.stringContaining('dns-error') })
        });
        expect(host.dropped).toEqual(['headers-pollable', 'future']);
    });

    it('cleans up when opening the body stream fails', () => {
        const t = transport();
        t.body.stream.mockImplementation(() => {
            throw new Error('stream unavailable');
        });
        const request = asyncRequest();
        request.drain();
        expect(request.complete).toHaveBeenCalledWith({
            ok: false,
            error: expect.objectContaining({ message: expect.stringContaining('open response stream') })
        });
        expect(host.dropped).toEqual(['headers-pollable', 'body', 'response', 'future']);
    });

    it('does not dispose resources transferred to a failed handle call', () => {
        host.handle.mockImplementationOnce(() => {
            throw new Error('permission denied');
        });
        const request = asyncRequest();
        expect(request.complete).toHaveBeenCalledWith({
            ok: false,
            error: expect.objectContaining({ message: expect.stringContaining('send outgoing request') })
        });
        expect(host.dropped).toEqual([]);
    });

    it('cleans up if a synchronous wait fails', () => {
        const t = transport();
        t.headers.block.mockImplementation(() => {
            throw new Error('poll failure');
        });
        expect(() => requestMarketJson('https://example.test')).toThrow('poll failure');
        expect(host.dropped).toEqual(['headers-pollable', 'future']);
    });

    it('continues cleanup when disposal throws', () => {
        const t = transport();
        t.stream.drop.mockImplementation(() => {
            throw new Error('dispose failure');
        });
        expect(requestMarketJson('https://example.test')).toEqual({ message: 'héllo' });
        expect(t.body.drop).toHaveBeenCalledOnce();
        expect(t.future.drop).toHaveBeenCalledOnce();
    });

    it('cleans up when a follow-up cannot be scheduled', () => {
        transport();
        const queued: Array<() => void> = [];
        const complete = vi.fn();
        let count = 0;
        requestMarketJsonAsync(
            'https://example.test',
            (callback) => {
                if (count++) throw new Error('scheduler stopped');
                queued.push(callback);
            },
            complete
        );
        queued.shift()?.();
        expect(complete).toHaveBeenCalledWith({
            ok: false,
            error: expect.objectContaining({ message: 'scheduler stopped' })
        });
        expect(host.dropped).toEqual(['headers-pollable', 'stream-pollable', 'stream', 'body', 'response', 'future']);
    });
});
