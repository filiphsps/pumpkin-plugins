import { TRANSFER_PACKET_BYTES } from '../protocol/constants.ts';
import { transferFragment, transferResponse } from '../protocol/messages.ts';

/** Emits one DH transfer packet at a time while retaining the source payload. */
export class TransferCursor {
    private offset = 0;
    private responsePending = true;
    private buffered?: Uint8Array;

    readonly packetCount: number;

    constructor(
        private readonly tracker: number,
        private readonly buffer: number,
        private readonly data: Uint8Array
    ) {
        this.packetCount = Math.ceil(data.length / TRANSFER_PACKET_BYTES) + 1;
    }

    /** Returns the next packet without advancing the transfer. */
    peek(): Uint8Array | undefined {
        if (this.buffered) return this.buffered;
        if (this.offset < this.data.length) {
            this.buffered = transferFragment(this.buffer, this.data, this.offset);
        } else if (this.responsePending) {
            this.buffered = transferResponse(this.tracker, this.buffer);
        }
        return this.buffered;
    }

    /** Advances after the current packet has been sent. */
    advance(): void {
        const packet = this.peek();
        if (!packet) throw new Error('No DH transfer packet is pending');
        if (this.offset < this.data.length) {
            this.offset += Math.min(TRANSFER_PACKET_BYTES, this.data.length - this.offset);
        } else {
            this.responsePending = false;
        }
        this.buffered = undefined;
    }

    /** Whether every data fragment and the final response have been sent. */
    get done(): boolean {
        return this.offset >= this.data.length && !this.responsePending;
    }

    /** Number of source payload bytes retained until completion or cancellation. */
    get retainedBytes(): number {
        return this.data.length;
    }

    /** Number of data fragments and the final response still waiting to be sent. */
    get remainingPackets(): number {
        return Math.ceil((this.data.length - this.offset) / TRANSFER_PACKET_BYTES) + (this.responsePending ? 1 : 0);
    }
}
