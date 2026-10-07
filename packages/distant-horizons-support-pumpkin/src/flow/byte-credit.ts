import { MAX_TRANSFER_MESSAGE_BYTES } from '../protocol/constants.ts';

/** Tracks per-client upload allowance in DH's decimal kilobytes per second. */
export class ByteCredit {
    private credit = 0;
    private updatedAt: number;

    constructor(
        private rateKbps: number,
        now: number
    ) {
        this.updatedAt = now;
    }

    /** Applies a negotiated rate change without retaining an unlimited credit balance. */
    setRate(rateKbps: number, now: number): void {
        this.refill(now);
        if (rateKbps === 0 || this.rateKbps === 0) this.credit = 0;
        this.rateKbps = rateKbps;
        this.updatedAt = now;
    }

    /** Returns whether one complete packet fits the allowance accrued by this time. */
    canSend(packetBytes: number, now: number): boolean {
        this.refill(now);
        return this.rateKbps === 0 || this.credit >= packetBytes;
    }

    /** Charges a packet after a successful send. */
    consume(packetBytes: number): void {
        if (this.rateKbps > 0) this.credit = Math.max(0, this.credit - packetBytes);
    }

    private refill(now: number): void {
        if (this.rateKbps === 0) {
            this.updatedAt = now;
            return;
        }
        const elapsed = Math.max(0, now - this.updatedAt);
        this.credit = Math.min(MAX_TRANSFER_MESSAGE_BYTES, this.credit + elapsed * this.rateKbps);
        this.updatedAt = now;
    }
}
