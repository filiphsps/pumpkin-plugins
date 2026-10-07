import {
    TRANSFER_FRAGMENT_OVERHEAD_BYTES,
    TRANSFER_FRAGMENT_SAFE_WINDOW_MS,
    TRANSFER_PACKET_BYTES
} from '../protocol/constants.ts';
import { transferFragment, transferResponse } from '../protocol/messages.ts';

/** Chooses a protocol-bounded fragment that fits within a safe interval at the client's rate. */
export function transferFragmentDataLimit(bandwidthKbps: number): number {
    if (!Number.isSafeInteger(bandwidthKbps) || bandwidthKbps < 0) {
        throw new RangeError('Invalid DH bandwidth rate');
    }
    if (bandwidthKbps === 0) return TRANSFER_PACKET_BYTES;
    return Math.min(
        TRANSFER_PACKET_BYTES,
        Math.max(1, bandwidthKbps * TRANSFER_FRAGMENT_SAFE_WINDOW_MS - TRANSFER_FRAGMENT_OVERHEAD_BYTES)
    );
}

/** Emits one DH transfer packet at a time while retaining the source payload. */
export class TransferCursor {
    private offset = 0;
    private responsePending = true;
    private buffered?: Uint8Array;
    private sentPackets = 0;
    private fragmentDataBytes: number;

    constructor(
        private readonly tracker: number,
        private readonly buffer: number,
        private readonly data: Uint8Array,
        bandwidthKbps = 0
    ) {
        this.fragmentDataBytes = transferFragmentDataLimit(bandwidthKbps);
    }

    /** Resizes only unsent fragments after the client changes its requested bandwidth. */
    setBandwidthRate(bandwidthKbps: number): void {
        const next = transferFragmentDataLimit(bandwidthKbps);
        if (next === this.fragmentDataBytes) return;
        this.fragmentDataBytes = next;
        this.buffered = undefined;
    }

    /** Returns the next packet without advancing the transfer. */
    peek(): Uint8Array | undefined {
        if (this.buffered) return this.buffered;
        if (this.offset < this.data.length) {
            this.buffered = transferFragment(this.buffer, this.data, this.offset, this.fragmentDataBytes);
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
            const fragmentBytes = Math.min(this.fragmentDataBytes, this.data.length - this.offset);
            this.offset += fragmentBytes;
        } else {
            this.responsePending = false;
        }
        this.sentPackets++;
        this.buffered = undefined;
    }

    /** Whether every data fragment and the final response have been sent. */
    get done(): boolean {
        return this.offset >= this.data.length && !this.responsePending;
    }

    /** Whether the client currently owns an in-progress assembly buffer for this transfer. */
    get hasInFlightBuffer(): boolean {
        return this.offset > 0 && !this.done;
    }

    /** Number of source payload bytes retained until completion or cancellation. */
    get retainedBytes(): number {
        return this.data.length;
    }

    /** Number of data fragments and the final response still waiting to be sent. */
    get remainingPackets(): number {
        return Math.ceil((this.data.length - this.offset) / this.fragmentDataBytes) + (this.responsePending ? 1 : 0);
    }

    /** Estimated total packets after counting sent packets and current fragment sizing. */
    get packetCount(): number {
        return this.sentPackets + this.remainingPackets;
    }
}
