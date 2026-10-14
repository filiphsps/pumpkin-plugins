import { strFromU8, strToU8 } from 'fflate';

/** Default IPC address of the provider. */
export const PIE_PROVIDER = 'PumpkinPIE';
/** Supported wire protocol, negotiated by ping rather than plugin version. */
export const PROTOCOL_VERSION = 0;
/** Wire limits, measured in UTF-8 bytes. */
export const LIMITS = { message: 1048576, text: 32768, id: 128, batch: 8192, ttl: 60000 } as const;
/** Local input cannot be sent safely. */
export class InputError extends Error {}
/** Reply or callback violates the wire contract. */
export class ProtocolError extends Error {}
/** The transport threw; normalized host errors cannot be distinguished further. */
export class UnavailableError extends Error {}
/** The provider explicitly rejected the request. */
export class RejectedError extends Error {}
/** The provider speaks an unsupported protocol. */
export class IncompatibleError extends Error {}
/** A synchronous callback attempted to call PIE again. */
export class ReentryError extends Error {}
/** Cache policy requested or applied by the provider. */
export type Cache = { readonly kind: 'never' } | { readonly kind: 'ttl'; readonly ms: number };
/** Placeholder subject's current player name; never a UUID. */
export interface Line {
    readonly text: string;
    readonly viewer?: string;
}
/** Resolved text, retaining unresolved tokens and their raw identifiers. */
export interface ResolvedLine {
    readonly text: string;
    readonly unresolved: readonly string[];
}
/** Negotiation and diagnostic information. Counts cover built-ins and expansion namespaces. */
export interface ProviderInfo {
    readonly expansions: number;
    readonly name: string;
    readonly placeholders: number;
    readonly protocol: number;
    readonly version: string;
}
/** An advertised placeholder. */
export interface RegisteredPlaceholder {
    readonly description: string;
    readonly id: string;
    readonly namespace: string;
    readonly source: string;
}
/** Expansion registration; names are advertised, not an access-control list. */
export interface ExpansionRegistration {
    readonly cache?: Cache;
    readonly namespace: string;
    readonly placeholders?: readonly string[];
}
/** Registration echoed with the provider's applied cache policy. */
export interface RegisteredExpansion {
    readonly cache: Cache;
    readonly namespace: string;
    readonly placeholders: readonly string[];
}
/** Single-value lookup preserves known empty strings. */
export type PlaceholderValue = { readonly known: false } | { readonly known: true; readonly value: string };
/** Context supplied by the provider; viewer is not authorization. */
export interface ExpansionRequest {
    readonly argument?: string;
    readonly id: string;
    readonly name: string;
    readonly namespace: string;
    readonly op: 'on_request';
    readonly viewer?: string;
}
/** All protocol 0 request operations. */
export type Request =
    | { readonly op: 'ping' }
    | { readonly op: 'get_registered_placeholders' }
    | ({ readonly op: 'set_placeholders'; readonly argument?: string } & Line)
    | { readonly op: 'set_placeholders_batch'; readonly requests: readonly Line[] }
    | {
          readonly op: 'get_placeholder_value';
          readonly id: string;
          readonly viewer?: string;
          readonly argument?: string;
      }
    | ({ readonly op: 'register_expansion' } & ExpansionRegistration)
    | { readonly op: 'unregister_expansion' }
    | ExpansionRequest;
/** Operation-to-result association, independent of wire wrapper names. */
export interface OperationResults {
    get_placeholder_value: PlaceholderValue;
    get_registered_placeholders: readonly RegisteredPlaceholder[];
    on_request: { readonly value?: string };
    ping: ProviderInfo;
    register_expansion: RegisteredExpansion;
    set_placeholders: ResolvedLine;
    set_placeholders_batch: readonly ResolvedLine[];
    unregister_expansion: readonly string[];
}
/** Result selected by a request's discriminant. */
export type ResultFor<R extends Request> = OperationResults[R['op']];

const wrappers = {
    ping: 'ping',
    get_registered_placeholders: 'registered',
    set_placeholders: 'resolved',
    set_placeholders_batch: 'resolved_batch',
    get_placeholder_value: 'value',
    register_expansion: 'registered_expansion',
    unregister_expansion: 'unregistered',
    on_request: 'on_request',
} as const;
type Failure = typeof InputError | typeof ProtocolError;

function fail(ErrorType: Failure, message: string): never {
    throw new ErrorType(message);
}
function object(value: unknown): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new ProtocolError('Expected a JSON object');
    return value as Record<string, unknown>;
}
function validUnicode(text: string): boolean {
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = text.charCodeAt(++i);
            if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
        } else if (code >= 0xdc00 && code <= 0xdfff) return false;
    }
    return true;
}
function text(value: unknown, max: number, ErrorType: Failure): string {
    if (typeof value !== 'string' || !validUnicode(value) || strToU8(value).length > max)
        fail(ErrorType, 'Invalid or oversized string');
    return value;
}
function optional(value: unknown, ErrorType: Failure): string | undefined {
    return value === undefined || value === null ? undefined : text(value, LIMITS.id, ErrorType);
}
function integer(value: unknown, ErrorType: Failure, max = Number.MAX_SAFE_INTEGER): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max)
        fail(ErrorType, 'Expected a nonnegative safe integer');
    return value;
}
function strings(value: unknown, max = LIMITS.id): string[] {
    if (!Array.isArray(value)) throw new ProtocolError('Expected a string array');
    return value.map((item) => text(item, max, ProtocolError));
}
/** Normalize and validate an expansion namespace, including reserved names. */
export function normalizeNamespace(value: string): string {
    const namespace = text(value, LIMITS.id, InputError).toLowerCase();
    if (!/^[a-z][a-z0-9]*$/.test(namespace) || ['player', 'server', 'pie'].includes(namespace))
        throw new InputError('Invalid or reserved namespace');
    return namespace;
}
/** Normalize and validate the local part of a contributed placeholder. */
export function normalizeName(value: string): string {
    const name = text(value, LIMITS.id, InputError).toLowerCase();
    if (!/^[a-z0-9_]+$/.test(name)) throw new InputError('Invalid placeholder name');
    return name;
}
/** Validate a provider cache policy, retaining the applied TTL. */
export function validateCache(value: unknown, ErrorType: Failure = InputError): Cache {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(ErrorType, 'Invalid cache policy');
    const cache = value as Record<string, unknown>;
    if (cache.kind === 'never') return { kind: 'never' };
    if (cache.kind === 'ttl')
        return {
            kind: 'ttl',
            ms: integer(cache.ms, ErrorType, ErrorType === ProtocolError ? LIMITS.ttl : Number.MAX_SAFE_INTEGER),
        };
    return fail(ErrorType, 'Invalid cache policy');
}
/** Validate one complete input line before sending or partitioning batches. */
export function validateLine(line: Line): void {
    if (typeof line !== 'object' || line === null) throw new InputError('Invalid input line');
    text(line.text, LIMITS.text, InputError);
    optional(line.viewer, InputError);
}
/** Encode a validated request, refusing message size and per-field violations. */
export function encodeRequest(request: Request): Uint8Array {
    switch (request.op) {
        case 'set_placeholders':
            validateLine(request);
            optional(request.argument, InputError);
            break;
        case 'set_placeholders_batch':
            if (!Array.isArray(request.requests) || request.requests.length > LIMITS.batch)
                throw new InputError('Invalid batch size');
            for (const line of request.requests) validateLine(line);
            break;
        case 'get_placeholder_value':
            text(request.id, LIMITS.id, InputError);
            optional(request.viewer, InputError);
            optional(request.argument, InputError);
            break;
        case 'register_expansion':
            normalizeNamespace(request.namespace);
            if (request.placeholders !== undefined) {
                if (!Array.isArray(request.placeholders)) throw new InputError('Invalid placeholder list');
                for (const name of request.placeholders) normalizeName(name);
            }
            if (request.cache !== undefined) validateCache(request.cache);
            break;
        case 'on_request':
            text(request.namespace, LIMITS.id, InputError);
            text(request.id, LIMITS.id, InputError);
            text(request.name, LIMITS.id, InputError);
            optional(request.viewer, InputError);
            optional(request.argument, InputError);
            break;
        case 'ping':
        case 'get_registered_placeholders':
        case 'unregister_expansion':
            break;
        default:
            throw new InputError('Unknown operation');
    }
    const bytes = strToU8(JSON.stringify(request));
    if (bytes.length > LIMITS.message) throw new InputError('Encoded request exceeds 1 MiB');
    return bytes;
}
// QuickJS does not provide TextDecoder. Validate scalar UTF-8 before fflate decodes it.
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
/** Parse bounded, strictly valid UTF-8 JSON as unknown data. */
export function decodeJson(bytes: Uint8Array): unknown {
    if (!(bytes instanceof Uint8Array) || bytes.length > LIMITS.message || !validUtf8(bytes))
        throw new ProtocolError('Invalid or oversized UTF-8 message');
    try {
        return JSON.parse(strFromU8(bytes));
    } catch {
        throw new ProtocolError('Invalid JSON message');
    }
}
function resolved(value: unknown): ResolvedLine {
    const body = object(value);
    return { text: text(body.text, LIMITS.text, ProtocolError), unresolved: strings(body.unresolved) };
}
/** Decode and validate a reply against the exact requested operation. */
export function decodeResult<R extends Request>(bytes: Uint8Array, request: R): ResultFor<R> {
    const reply = object(decodeJson(bytes));
    if (reply.ok === false) {
        if (typeof reply.error !== 'string') throw new ProtocolError('Rejection lacks an error');
        throw new RejectedError('PumpkinPIE rejected the request');
    }
    if (reply.ok !== true) throw new ProtocolError('Reply lacks a boolean ok');
    const wrapper = wrappers[request.op];
    for (const other of Object.values(wrappers))
        if (other !== wrapper && Object.hasOwn(reply, other)) throw new ProtocolError('Mismatched result variant');
    const body = object(reply[wrapper]);
    let result: OperationResults[Request['op']];
    switch (request.op) {
        case 'ping':
            result = {
                protocol: integer(body.protocol, ProtocolError, 65535),
                name: text(body.name, LIMITS.id, ProtocolError),
                version: text(body.version, LIMITS.id, ProtocolError),
                placeholders: integer(body.placeholders, ProtocolError),
                expansions: integer(body.expansions, ProtocolError),
            };
            if (result.protocol !== PROTOCOL_VERSION) throw new IncompatibleError('Unsupported PumpkinPIE protocol');
            break;
        case 'set_placeholders':
            result = resolved(body);
            break;
        case 'set_placeholders_batch':
            if (!Array.isArray(body.results) || body.results.length !== request.requests.length)
                throw new ProtocolError('Batch result count mismatch');
            result = body.results.map(resolved);
            break;
        case 'get_placeholder_value':
            if (body.known === false && !Object.hasOwn(body, 'value')) result = { known: false };
            else if (body.known === true) result = { known: true, value: text(body.value, LIMITS.text, ProtocolError) };
            else throw new ProtocolError('Contradictory placeholder value');
            break;
        case 'get_registered_placeholders':
            if (!Array.isArray(body.placeholders)) throw new ProtocolError('Invalid placeholder list');
            result = body.placeholders.map((value) => {
                const item = object(value);
                return {
                    id: text(item.id, LIMITS.id, ProtocolError),
                    description: text(item.description, LIMITS.text, ProtocolError),
                    namespace: text(item.namespace, LIMITS.id, ProtocolError),
                    source: text(item.source, LIMITS.id, ProtocolError),
                };
            });
            break;
        case 'register_expansion': {
            const namespace = text(body.namespace, LIMITS.id, ProtocolError);
            const placeholders = strings(body.placeholders);
            const expected = new Set((request.placeholders ?? []).map(normalizeName));
            if (
                namespace !== normalizeNamespace(request.namespace) ||
                placeholders.length !== expected.size ||
                new Set(placeholders).size !== placeholders.length ||
                placeholders.some((name) => !expected.has(name))
            )
                throw new ProtocolError('Registration result mismatch');
            result = { namespace, placeholders, cache: validateCache(body.cache, ProtocolError) };
            break;
        }
        case 'unregister_expansion':
            result = strings(body.namespaces);
            break;
        case 'on_request':
            result = body.value === undefined ? {} : { value: text(body.value, LIMITS.text, ProtocolError) };
            break;
    }
    // Every branch validates its own body before this operation-map association.
    return result as ResultFor<R>;
}
/** Validate an incoming provider callback, ignoring additive unknown fields. */
export function decodeCallback(bytes: Uint8Array): ExpansionRequest {
    const request = object(decodeJson(bytes));
    if (request.op !== 'on_request') throw new ProtocolError('Expected on_request');
    const namespace = text(request.namespace, LIMITS.id, ProtocolError).toLowerCase();
    const name = text(request.name, LIMITS.id, ProtocolError);
    const id = text(request.id, LIMITS.id, ProtocolError);
    try {
        if (
            normalizeNamespace(namespace) !== namespace ||
            normalizeName(name) !== name ||
            id.toLowerCase().split('_', 1)[0] !== namespace
        )
            throw new ProtocolError('Invalid callback identity');
    } catch {
        throw new ProtocolError('Invalid callback identity');
    }
    return {
        op: 'on_request',
        namespace,
        name,
        id,
        viewer: optional(request.viewer, ProtocolError),
        argument: optional(request.argument, ProtocolError),
    };
}
/** Encode a bounded expansion reply, retaining known empty values. */
export function encodeCallbackReply(value?: string): Uint8Array {
    if (value !== undefined) text(value, LIMITS.text, ProtocolError);
    return strToU8(JSON.stringify({ ok: true, on_request: value === undefined ? {} : { value } }));
}
