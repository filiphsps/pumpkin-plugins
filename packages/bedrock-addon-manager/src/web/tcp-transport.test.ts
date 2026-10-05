import type { InputStream, OutputStream } from 'wasi:io/streams@0.2.3';
import type { TcpSocket } from 'wasi:sockets/tcp@0.2.3';
import { describe, expect, it, vi } from 'vitest';
import { TcpTransport } from './tcp-transport.ts';

function fixture() {
    const input = {
        read: vi.fn<() => Uint8Array>(() => new Uint8Array()),
        [Symbol.dispose]: vi.fn()
    };
    const output = {
        checkWrite: vi.fn(() => 1024),
        write: vi.fn(),
        flush: vi.fn(),
        [Symbol.dispose]: vi.fn()
    };
    const socket = {
        shutdown: vi.fn(),
        [Symbol.dispose]: vi.fn()
    };
    return {
        input,
        output,
        socket,
        transport: new TcpTransport(
            socket as unknown as TcpSocket,
            input as unknown as InputStream,
            output as unknown as OutputStream
        )
    };
}

describe('TcpTransport', () => {
    it('distinguishes empty and closed reads while propagating other host errors', () => {
        const { input, transport } = fixture();
        const bytes = new Uint8Array([1, 2, 3]);
        input.read.mockReturnValueOnce(bytes).mockReturnValueOnce(new Uint8Array());

        expect(transport.read(8)).toBe(bytes);
        expect(transport.read(8)).toBeNull();
        input.read.mockImplementationOnce(() => {
            throw Object.assign(new Error('closed'), { payload: { tag: 'closed' } });
        });
        expect(transport.read(8)).toBe('closed');
        const failure = new Error('read failed');
        input.read.mockImplementationOnce(() => {
            throw failure;
        });
        expect(() => transport.read(8)).toThrow(failure);
        expect(input.read).toHaveBeenCalledWith(8);
    });

    it('reports output capacity and sends response bytes through the host stream', () => {
        const { output, transport } = fixture();
        output.checkWrite.mockReturnValue(17);
        const bytes = new Uint8Array([4, 5, 6]);

        expect(transport.writable()).toBe(17);
        transport.write(bytes);
        expect(output.write).toHaveBeenCalledWith(bytes);
    });

    it('waits for a pending flush before shutting down and releasing the connection', () => {
        const { input, output, socket, transport } = fixture();
        output.checkWrite.mockReturnValueOnce(0).mockReturnValueOnce(32);

        expect(transport.finish()).toBe(false);
        expect(output.flush).toHaveBeenCalledOnce();
        expect(transport.finish()).toBe(false);
        expect(socket.shutdown).not.toHaveBeenCalled();
        expect(transport.finish()).toBe(true);
        expect(socket.shutdown).toHaveBeenCalledWith('send');
        expect(input[Symbol.dispose]).toHaveBeenCalledOnce();
        expect(output[Symbol.dispose]).toHaveBeenCalledOnce();
        expect(socket[Symbol.dispose]).toHaveBeenCalledOnce();

        expect(transport.finish()).toBe(true);
        expect(socket.shutdown).toHaveBeenCalledOnce();
    });

    it('releases resources when flushing fails or the session aborts', () => {
        const failedFlush = fixture();
        failedFlush.output.flush.mockImplementation(() => {
            throw new Error('peer disconnected');
        });
        expect(failedFlush.transport.finish()).toBe(true);
        expect(failedFlush.socket.shutdown).not.toHaveBeenCalled();
        expect(failedFlush.input[Symbol.dispose]).toHaveBeenCalledOnce();
        expect(failedFlush.output[Symbol.dispose]).toHaveBeenCalledOnce();
        expect(failedFlush.socket[Symbol.dispose]).toHaveBeenCalledOnce();

        const aborted = fixture();
        aborted.transport.abort();
        aborted.transport.abort();
        expect(aborted.input[Symbol.dispose]).toHaveBeenCalledOnce();
        expect(aborted.output[Symbol.dispose]).toHaveBeenCalledOnce();
        expect(aborted.socket[Symbol.dispose]).toHaveBeenCalledOnce();
    });
});
