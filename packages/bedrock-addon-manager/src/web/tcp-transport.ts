import type { InputStream, OutputStream } from 'wasi:io/streams@0.2.3';
import type { TcpSocket } from 'wasi:sockets/tcp@0.2.3';
import { disposeWasiResource } from '@pumpkin-plugins/plugin-kit/wasi-resource';
import { wasiErrorCode } from '../platform/wasi-error.ts';
import type { Transport } from './session.ts';

/** One accepted TCP connection, adapted to the non-blocking `Transport` the HTTP session uses. */
export class TcpTransport implements Transport {
    private flushRequested = false;
    private released = false;

    /** Wraps the three resources `accept` returns. */
    constructor(
        private readonly socket: TcpSocket,
        private readonly input: InputStream,
        private readonly output: OutputStream
    ) {}

    /** {@inheritDoc web/session!Transport#read} */
    read(max: number): Uint8Array | null | 'closed' {
        try {
            const bytes = this.input.read(max);
            return bytes.length > 0 ? bytes : null;
        } catch (err) {
            if (wasiErrorCode(err) === 'closed') return 'closed';
            throw err;
        }
    }

    /** {@inheritDoc web/session!Transport#writable} */
    writable(): number {
        return this.output.checkWrite();
    }

    /** {@inheritDoc web/session!Transport#write} */
    write(bytes: Uint8Array): void {
        this.output.write(bytes);
    }

    /** {@inheritDoc web/session!Transport#finish} */
    finish(): boolean {
        if (this.released) return true;
        try {
            if (!this.flushRequested) {
                this.output.flush();
                this.flushRequested = true;
                return false;
            }
            // `check-write` reports 0 until the flush has completed.
            if (this.output.checkWrite() === 0) return false;
            this.socket.shutdown('send');
        } catch {
            // The peer is gone; there is nothing left to deliver.
        }
        this.release();
        return true;
    }

    /** {@inheritDoc web/session!Transport#abort} */
    abort(): void {
        this.release();
    }

    private release(): void {
        if (this.released) return;
        this.released = true;
        for (const resource of [this.input, this.output, this.socket]) {
            try {
                disposeWasiResource(resource);
            } catch {
                // Already closed.
            }
        }
    }
}
