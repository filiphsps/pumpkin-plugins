import { now } from 'wasi:clocks/monotonic-clock@0.2.3';
import { marketJsonRequest } from './http-request.ts';

const REQUEST_TIMEOUT_NS = 15_000_000_000n;

/** Sends a blocking HTTP GET through Pumpkin's WASI host. Use only outside server ticks. */
export function requestMarketJson(url: string): unknown {
    const request = marketJsonRequest(url);
    try {
        let step = request.next();
        while (!step.done) {
            step.value.block();
            step = request.next();
        }
        return step.value;
    } finally {
        request.return(undefined);
    }
}

/** The outcome of one asynchronous Market request. */
export type MarketJsonResult = { ok: true; value: unknown } | { ok: false; error: unknown };

/** Defers work to a later plugin task; callbacks must not run inline. */
export type SchedulePoll = (callback: () => void) => void;

/** Starts a WASI HTTP request and polls its response across scheduled tasks without blocking. */
export function requestMarketJsonAsync(
    url: string,
    schedule: SchedulePoll,
    complete: (result: MarketJsonResult) => void
): void {
    const request = marketJsonRequest(url);
    let finished = false;
    let started: bigint;
    let step: ReturnType<typeof request.next>;
    const finish = (result: MarketJsonResult): void => {
        finished = true;
        request.return(undefined);
        complete(result);
    };
    const poll = (): void => {
        if (finished) return;
        let result: MarketJsonResult | undefined;
        try {
            if (now() - started >= REQUEST_TIMEOUT_NS) throw new Error('WASI HTTP request timed out');
            if (!step.done && step.value.ready()) step = request.next();
            if (step.done) result = { ok: true, value: step.value };
            else schedule(poll);
        } catch (error) {
            result = { ok: false, error };
        }
        // Consumer exceptions must propagate instead of becoming transport failures.
        if (result) finish(result);
    };
    let failure: MarketJsonResult | undefined;
    try {
        started = now();
        step = request.next();
        schedule(poll);
    } catch (error) {
        failure = { ok: false, error };
    }
    if (failure) finish(failure);
}
