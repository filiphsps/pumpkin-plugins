import { strFromU8, strToU8 } from 'fflate';

/** Wire version, independent of npm, native ABI and Pumpkin WIT versions. */
export const PROTOCOL_VERSION = 1;
/** Native metadata name used by the host's IPC router. */
export const PROVIDER = 'Pumpkin++';
/** Hard byte, scalar, coordinate and native duration bounds for short control calls. */
export const LIMITS = Object.freeze({
    message: 8192,
    world: 128,
    id: 64,
    hostRelease: 128,
    detail: 256,
    /** Maximum configured native job lifetime, used to bound safe retries after uncertain submission. */
    maxJobDeadlineMs: 30000,
    leaseMs: 60000,
    chunkCoordinate: 1_000_000,
});
/** Invalid caller input; no IPC request is sent. */
export class InputError extends Error {}
/** Malformed response; it cannot be treated as a trustworthy provider result. */
export class ProtocolError extends Error {}
/** Explicitly unsupported protocol or provider identity. */
export class IncompatibleError extends Error {}
/** Native provider identity and the exact Pumpkin host build it targets. */
export interface ProviderInfo {
    readonly hostRelease: string;
    readonly hostSourceCommit: string;
    readonly protocol: typeof PROTOCOL_VERSION;
    readonly provider: typeof PROVIDER;
}
/** A currently loaded world name and supported chunk coordinates, not block coordinates. */
export interface ChunkTarget {
    readonly world: string;
    readonly x: number;
    readonly z: number;
}
/** Opaque operation identity, owned by the IPC caller and reusable across callbacks. */
export interface OperationHandle {
    readonly operationId: string;
}
/** Short control requests; caller identity always comes from the host IPC sender. */
export type Request =
    | { readonly v: typeof PROTOCOL_VERSION; readonly op: 'probe' }
    | ({ readonly v: typeof PROTOCOL_VERSION; readonly op: 'submit' } & ChunkTarget)
    | { readonly v: typeof PROTOCOL_VERSION; readonly op: 'poll' | 'cancel'; readonly operationId: string }
    | { readonly v: typeof PROTOCOL_VERSION; readonly op: 'release'; readonly leaseId: string };
/** Observed work state. A ready lease has fixed expiry and polling never renews it. */
export type JobState = OperationHandle &
    (
        | { readonly state: 'queued' | 'running' }
        | { readonly state: 'ready'; readonly leaseId: string; readonly remainingLeaseMs: number }
    );
/** Cancellation acknowledgement, or the ready lease when completion wins the cancellation race. */
export type CancelResult = OperationHandle &
    (
        | { readonly state: 'cancelled' }
        | { readonly state: 'ready'; readonly leaseId: string; readonly remainingLeaseMs: number }
    );
/** Stable bridge rejection and terminal job error categories. */
export type ErrorCode =
    | 'incompatible'
    | 'busy'
    | 'invalid_request'
    | 'unknown_world'
    | 'host_failure'
    | 'not_found'
    | 'timeout'
    | 'cancelled'
    | 'expired';
/** Native error, separate from provider reachability; terminal poll failures retain their handle. */
export interface BridgeRejection {
    readonly code: ErrorCode;
    readonly message?: string;
    readonly operationId?: string;
}
/** Idempotent acknowledgement for a caller-owned lease. */
export interface ReleaseResult {
    readonly leaseId: string;
    readonly released: true;
}
/** Maps operations to their distinct success values. */
export interface OperationResults {
    readonly cancel: CancelResult;
    readonly poll: JobState;
    readonly probe: ProviderInfo;
    readonly release: ReleaseResult;
    readonly submit: JobState;
}
/** Keeps request/success associations while retaining typed native errors. */
export type ResultFor<R extends Request> = OperationResults[R['op']] | BridgeRejection;

function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProtocolError('Expected an object');
    return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
    if (typeof value !== 'string' || value.length === 0 || value.length > max || strToU8(value).length > max)
        throw new ProtocolError('Invalid text field');
    for (const scalar of value) {
        const code = scalar.codePointAt(0) ?? 0;
        if (code < 32 || (code >= 127 && code <= 159) || (code >= 0xd800 && code <= 0xdfff))
            throw new ProtocolError('Invalid text scalar');
    }
    return value;
}
function integer(value: unknown, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
        throw new ProtocolError('Invalid integer field');
    return value;
}
function id(value: unknown): string {
    const result = text(value, LIMITS.id);
    if (!/^[A-Za-z0-9_-]+$/.test(result)) throw new ProtocolError('Invalid opaque ID');
    return result;
}
function absent(body: Record<string, unknown>, fields: string[]): void {
    for (const field of fields) if (Object.hasOwn(body, field)) throw new ProtocolError('Contradictory result fields');
}
/** Validates and encodes known fields; additive caller properties are never serialized. */
export function encodeRequest(request: Request): Uint8Array {
    try {
        if (object(request).v !== PROTOCOL_VERSION) throw new ProtocolError('Invalid request version');
        const head = { v: PROTOCOL_VERSION, op: request.op };
        let body: object;
        switch (request.op) {
            case 'probe':
                body = head;
                break;
            case 'submit':
                body = {
                    ...head,
                    world: text(request.world, LIMITS.world),
                    x: integer(request.x, -LIMITS.chunkCoordinate, LIMITS.chunkCoordinate),
                    z: integer(request.z, -LIMITS.chunkCoordinate, LIMITS.chunkCoordinate),
                };
                break;
            case 'poll':
            case 'cancel':
                body = { ...head, operationId: id(request.operationId) };
                break;
            case 'release':
                body = { ...head, leaseId: id(request.leaseId) };
                break;
            default:
                throw new ProtocolError('Unknown operation');
        }
        const bytes = strToU8(JSON.stringify(body));
        if (bytes.length > LIMITS.message) throw new ProtocolError('Oversized request');
        return bytes;
    } catch (error) {
        if (error instanceof ProtocolError) throw new InputError(error.message);
        throw error;
    }
}
// QuickJS has no TextDecoder. Validate scalar UTF-8 before decoding with fflate.
function validUtf8(bytes: Uint8Array): boolean {
    for (let i = 0; i < bytes.length; ) {
        const first = bytes[i++];
        if (first <= 0x7f) continue;
        let count: number;
        let low = 0x80;
        let high = 0xbf;
        if (first >= 0xc2 && first <= 0xdf) count = 1;
        else if (first >= 0xe0 && first <= 0xef) {
            count = 2;
            if (first === 0xe0) low = 0xa0;
            if (first === 0xed) high = 0x9f;
        } else if (first >= 0xf0 && first <= 0xf4) {
            count = 3;
            if (first === 0xf0) low = 0x90;
            if (first === 0xf4) high = 0x8f;
        } else return false;
        if (i + count > bytes.length || bytes[i] < low || bytes[i] > high) return false;
        i++;
        for (let j = 1; j < count; j++, i++) if (bytes[i] < 0x80 || bytes[i] > 0xbf) return false;
    }
    return true;
}
/** Parses bounded scalar UTF-8 JSON; unknown additive fields are ignored by validators. */
export function decodeJson(bytes: Uint8Array): unknown {
    if (!(bytes instanceof Uint8Array) || bytes.length > LIMITS.message || !validUtf8(bytes))
        throw new ProtocolError('Invalid or oversized UTF-8');
    try {
        return JSON.parse(strFromU8(bytes));
    } catch {
        throw new ProtocolError('Invalid JSON');
    }
}
function rejection(body: Record<string, unknown>, request: Request): BridgeRejection {
    const code = body.code;
    if (
        code !== 'incompatible' &&
        code !== 'busy' &&
        code !== 'invalid_request' &&
        code !== 'unknown_world' &&
        code !== 'host_failure' &&
        code !== 'not_found' &&
        code !== 'timeout' &&
        code !== 'cancelled' &&
        code !== 'expired'
    )
        throw new ProtocolError('Unknown error code');
    absent(body, ['state', 'leaseId', 'remainingLeaseMs', 'released', 'provider', 'protocol']);
    const result: { code: ErrorCode; operationId?: string; message?: string } = { code };
    if (body.operationId !== undefined) {
        result.operationId = id(body.operationId);
        if ((request.op !== 'poll' && request.op !== 'cancel') || result.operationId !== request.operationId)
            throw new ProtocolError('Error operation ID mismatch');
    }
    if (
        (code === 'timeout' ||
            code === 'cancelled' ||
            code === 'expired' ||
            (code === 'host_failure' && request.op === 'poll')) &&
        result.operationId === undefined
    )
        throw new ProtocolError('Terminal error lacks operation ID');
    if (body.message !== undefined) result.message = text(body.message, LIMITS.detail);
    return result;
}
function operation(body: Record<string, unknown>, request: Request): JobState | CancelResult {
    const operationId = id(body.operationId);
    if ((request.op === 'poll' || request.op === 'cancel') && operationId !== request.operationId)
        throw new ProtocolError('Operation ID mismatch');
    absent(body, ['code', 'released', 'provider', 'protocol']);
    if (request.op === 'cancel') {
        if (body.state === 'cancelled') {
            absent(body, ['leaseId', 'remainingLeaseMs']);
            return { state: 'cancelled', operationId };
        }
        if (body.state !== 'ready') throw new ProtocolError('Invalid cancellation acknowledgement');
    }
    if (body.state === 'ready')
        return {
            state: 'ready',
            operationId,
            leaseId: id(body.leaseId),
            remainingLeaseMs: integer(body.remainingLeaseMs, 1, LIMITS.leaseMs),
        };
    absent(body, ['leaseId', 'remainingLeaseMs']);
    if (body.state !== 'queued' && body.state !== 'running') throw new ProtocolError('Invalid operation state');
    return { state: body.state, operationId };
}
/** Validates native replies, including handle correlation, before exposing typed results. */
export function decodeReply<R extends Request>(bytes: Uint8Array, request: R): ResultFor<R> {
    const reply = object(decodeJson(bytes));
    integer(reply.v, 0, 65535);
    if (reply.v !== PROTOCOL_VERSION) throw new IncompatibleError('Unsupported Pumpkin++ envelope');
    if (reply.ok === false) return rejection(reply, request);
    if (reply.ok !== true) throw new ProtocolError('Reply lacks boolean ok');
    let value: OperationResults[Request['op']];
    switch (request.op) {
        case 'probe': {
            integer(reply.protocol, 0, 65535);
            if (reply.protocol !== PROTOCOL_VERSION || text(reply.provider, LIMITS.id) !== PROVIDER)
                throw new IncompatibleError('Unsupported Pumpkin++ identity or protocol');
            absent(reply, ['state', 'operationId', 'leaseId', 'code', 'released']);
            const commit = text(reply.hostSourceCommit, 40);
            if (!/^[a-f0-9]{40}$/.test(commit)) throw new ProtocolError('Invalid host source commit');
            value = {
                provider: PROVIDER,
                protocol: PROTOCOL_VERSION,
                hostRelease: text(reply.hostRelease, LIMITS.hostRelease),
                hostSourceCommit: commit,
            };
            break;
        }
        case 'submit':
        case 'poll':
        case 'cancel':
            value = operation(reply, request);
            break;
        case 'release':
            if (reply.released !== true || id(reply.leaseId) !== request.leaseId)
                throw new ProtocolError('Release acknowledgement mismatch');
            absent(reply, ['state', 'operationId', 'remainingLeaseMs', 'code', 'provider', 'protocol']);
            value = { released: true, leaseId: request.leaseId };
            break;
    }
    // Each branch validates its own result before applying this operation association.
    return value as ResultFor<R>;
}
