import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject, sign, verify } from 'node:crypto';
import { appendCustomSections, METADATA_SECTION, SIGNATURE_SECTION, stripSignature, type WasmSection } from './wasm.ts';

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const SECRET_PATTERN = /^[0-9a-fA-F]{64}$/;
const PUBLIC_PATTERN = /^[0-9a-fA-F]{64}$/;
const SIGNATURE_PATTERN = /^[0-9a-fA-F]{128}$/;
// Pumpkin reads its legacy `pumpkin.signature` section name as a signature too.
const SIGNATURE_SECTIONS = [SIGNATURE_SECTION, 'pumpkin.signature'];

/** An ID in Pumpkin signing metadata. Numbers must be safe integers; bigints support the full s64 range. */
export type SigningId = bigint | number;

/** The metadata Pumpkin expects in the `pumpkin.metadata` section. Field order is the JSON order. */
export interface SigningMetadata {
    /** Marketplace developer id; 0 for independent plugins. */
    dev_id: SigningId;
    /** The developer's name. */
    dev_name: string;
    /** Whether the plugin is paid. */
    is_paid: boolean;
    /** Signing date text; the host accepts an opaque string. */
    issued_at: string;
    /** License key, or null when absent, matching the host's optional string. */
    license_key?: string | null;
    /** Marketplace the plugin comes from; empty for independent plugins. */
    marketplace_url: string;
    /** Marketplace plugin id; 0 for independent plugins. */
    plugin_id: SigningId;
    /** The Pumpkin plugin name. */
    plugin_name: string;
    /** Marketplace user id; 0 for independent plugins. */
    user_id: SigningId;
    /** The plugin version. */
    version: string;
}

/** Metadata returned by {@link verifyWasm}; IDs remain exact `bigint` values. */
export type VerifiedSigningMetadata = Omit<SigningMetadata, 'dev_id' | 'plugin_id' | 'user_id'> & {
    /** Marketplace developer id as an exact s64 value. */
    dev_id: bigint;
    /** Marketplace plugin id as an exact s64 value. */
    plugin_id: bigint;
    /** Marketplace user id as an exact s64 value. */
    user_id: bigint;
};

/** Result of {@link verifyWasm}. */
export interface VerifyResult {
    /** Why the binary isn't valid. */
    error?: string;
    /** The signed metadata, when it could be read. */
    metadata?: VerifiedSigningMetadata;
    /** The public key from the signature envelope, in hex. */
    publicKeyHex?: string;
    /** Whether the binary carries signing sections at all. */
    signed: boolean;
    /** Whether the signature checks out; always false when unsigned. */
    valid: boolean;
}

/** A freshly generated Ed25519 key pair, both halves as hex. */
export interface KeyPair {
    /** The 32-byte public key as 64 hex characters. Safe to publish. */
    publicKeyHex: string;
    /** The 32-byte secret seed as 64 hex characters. Keep it private. */
    secretKeyHex: string;
}

function secretKey(secretKeyHex: string): KeyObject {
    if (typeof secretKeyHex !== 'string' || !SECRET_PATTERN.test(secretKeyHex.trim())) {
        throw new Error('invalid signing key: expected a 32-byte Ed25519 seed as 64 hex characters');
    }
    const der = Buffer.concat([PKCS8_PREFIX, Buffer.from(secretKeyHex.trim(), 'hex')]);
    return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

function rawPublicKey(key: KeyObject): string {
    return createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(SPKI_PREFIX.length).toString('hex');
}

/**
 * Derives the public key of a secret key.
 * @param secretKeyHex - The 32-byte seed as 64 hex characters.
 * @returns The raw 32-byte public key in hex.
 * @throws {Error} When the secret isn't 64 hex characters.
 */
export function publicKeyOf(secretKeyHex: string): string {
    return rawPublicKey(secretKey(secretKeyHex));
}

/**
 * Generates a new Ed25519 key pair.
 * @returns The secret seed and the public key, both in hex.
 */
export function generateKeyPair(): KeyPair {
    const { privateKey } = generateKeyPairSync('ed25519');
    const der = privateKey.export({ format: 'der', type: 'pkcs8' });
    return {
        secretKeyHex: der.subarray(PKCS8_PREFIX.length).toString('hex'),
        publicKeyHex: rawPublicKey(privateKey),
    };
}

/**
 * Signs a wasm binary the way Pumpkin verifies it. Existing signing sections are replaced.
 * @param wasm - The binary to sign.
 * @param metadata - What to embed; only the documented fields are written, in order.
 * @param secretKeyHex - The 32-byte seed as 64 hex characters.
 * @returns The binary with `pumpkin.metadata` and `wasm_signature` sections appended.
 * @throws {Error} When the key or bytes are invalid, a metadata field has the wrong type, or a metadata ID is
 *   unsafe or outside the s64 range.
 */
export function signWasm(wasm: Uint8Array, metadata: SigningMetadata, secretKeyHex: string): Buffer {
    const key = secretKey(secretKeyHex);
    const { clean } = stripSignature(wasm);
    const fields: [string, string][] = [
        ['marketplace_url', serializeString(metadata.marketplace_url, 'marketplace_url')],
        ['plugin_id', serializeMetadataId(metadata.plugin_id, 'plugin_id')],
        ['plugin_name', serializeString(metadata.plugin_name, 'plugin_name')],
        ['version', serializeString(metadata.version, 'version')],
        ['dev_id', serializeMetadataId(metadata.dev_id, 'dev_id')],
        ['dev_name', serializeString(metadata.dev_name, 'dev_name')],
        ['is_paid', serializeBoolean(metadata.is_paid, 'is_paid')],
        ['user_id', serializeMetadataId(metadata.user_id, 'user_id')],
    ];
    if (metadata.license_key !== undefined) {
        const licenseKey = metadata.license_key;
        fields.push([
            'license_key',
            licenseKey === null ? 'null' : serializeString(licenseKey, 'license_key', 'a string or null'),
        ]);
    }
    fields.push(['issued_at', serializeString(metadata.issued_at, 'issued_at')]);
    const metadataJson = Buffer.from(
        `{${fields.map(([name, value]) => `${JSON.stringify(name)}:${value}`).join(',')}}`,
        'utf8',
    );
    const signature = sign(null, Buffer.concat([clean, metadataJson]), key);
    const envelope = Buffer.from(
        JSON.stringify({
            version: 1,
            algorithm: 'Ed25519',
            public_key_hex: rawPublicKey(key),
            signature_hex: signature.toString('hex'),
        }),
        'utf8',
    );
    return appendCustomSections(clean, [
        [METADATA_SECTION, metadataJson],
        [SIGNATURE_SECTION, envelope],
    ]);
}

function last(sections: WasmSection[], names: readonly string[]): WasmSection | undefined {
    return [...sections].reverse().find((s) => s.name !== undefined && names.includes(s.name));
}

const ID_FIELDS = ['plugin_id', 'dev_id', 'user_id'];
const MIN_I64 = -(1n << 63n);
const MAX_I64 = (1n << 63n) - 1n;

// JS callers aren't type-checked, so check the types here rather than sign metadata the host can't parse.
function serializeString(value: unknown, field: string, expected = 'a string'): string {
    if (typeof value !== 'string') throw new Error(`metadata.${field} must be ${expected}`);
    return JSON.stringify(value);
}

function serializeBoolean(value: unknown, field: string): string {
    if (typeof value !== 'boolean') throw new Error(`metadata.${field} must be a boolean`);
    return String(value);
}

function serializeMetadataId(value: SigningId, field: string): string {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) {
        throw new Error(`metadata.${field} must be a safe integer or bigint`);
    }
    if (typeof value !== 'number' && typeof value !== 'bigint') {
        throw new Error(`metadata.${field} must be a safe integer or bigint`);
    }
    const id = typeof value === 'bigint' ? value : BigInt(value);
    if (id < MIN_I64 || id > MAX_I64) {
        throw new Error(`metadata.${field} must be a signed 64-bit integer`);
    }
    return id.toString();
}

function parseJson(data: Uint8Array, metadataIds = false): Record<string, unknown> | undefined {
    try {
        const invalidIds = new WeakSet<object>();
        const value: unknown = JSON.parse(
            Buffer.from(data).toString('utf8'),
            function (this: object, key: string, field: unknown, context?: { source: string }) {
                if (metadataIds && ID_FIELDS.includes(key) && typeof field === 'number') {
                    const source = context?.source;
                    if (!source || !/^-?\d+$/.test(source)) {
                        invalidIds.add(this);
                        return field;
                    }
                    const id = BigInt(source);
                    if (id < MIN_I64 || id > MAX_I64) invalidIds.add(this);
                    else return id;
                }
                return field;
            },
        );
        return typeof value === 'object' && value !== null && !Array.isArray(value) && !invalidIds.has(value)
            ? (value as Record<string, unknown>)
            : undefined;
    } catch {
        return undefined;
    }
}

function isSigningMetadata(
    value: Record<string, unknown> | undefined,
): value is VerifiedSigningMetadata & Record<string, unknown> {
    if (!value) return false;
    return (
        ['marketplace_url', 'plugin_name', 'version', 'dev_name', 'issued_at'].every(
            (key) => typeof value[key] === 'string',
        ) &&
        ID_FIELDS.every((key) => typeof value[key] === 'bigint') &&
        typeof value.is_paid === 'boolean' &&
        (value.license_key === undefined || value.license_key === null || typeof value.license_key === 'string')
    );
}

/**
 * Checks the signature of a wasm binary. Never throws: problems are reported in the result.
 *
 * Like Pumpkin, it reads the signature from a `wasm_signature` or `pumpkin.signature` section and
 * accepts hex in either case. It still differs from Pumpkin in three ways: it reads only the signing
 * sections at the end of the file, it requires a version 1 Ed25519 JSON envelope where Pumpkin also
 * accepts raw signature bytes, and it keeps the last value of a repeated JSON key where Pumpkin
 * rejects the section.
 * @param wasm - The binary to check.
 * @param expectedPublicKeyHex - The trusted signer's public key in hex. When set, a file signed by any
 *   other key is reported as invalid. Without it, a valid result only means the file agrees with its
 *   own envelope, so compare `publicKeyHex` with a key you trust.
 * @returns Whether it is signed, whether the signature is valid, and what it says.
 */
export function verifyWasm(wasm: Uint8Array, expectedPublicKeyHex?: string): VerifyResult {
    let stripped: ReturnType<typeof stripSignature>;
    try {
        stripped = stripSignature(wasm);
    } catch (error) {
        return { signed: false, valid: false, error: (error as Error).message };
    }
    const metadataSection = last(stripped.trailing, [METADATA_SECTION]);
    const signatureSection = last(stripped.trailing, SIGNATURE_SECTIONS);
    if (!signatureSection?.data) return { signed: false, valid: false, error: 'no signature found' };
    if (!metadataSection?.data) {
        return { signed: true, valid: false, error: `signature without a ${METADATA_SECTION} section` };
    }
    const parsedMetadata = parseJson(metadataSection.data, true);
    const metadata = isSigningMetadata(parsedMetadata)
        ? { ...parsedMetadata, license_key: parsedMetadata.license_key ?? null }
        : undefined;
    const envelope = parseJson(signatureSection.data);
    const base = { signed: true, valid: false, ...(metadata ? { metadata } : {}) };
    if (!envelope) return { ...base, error: 'signature envelope is not a JSON object' };
    const rawPublicKeyHex = envelope.public_key_hex;
    const signatureHex = envelope.signature_hex;
    if (envelope.version !== 1) return { ...base, error: `unsupported signature version ${String(envelope.version)}` };
    if (envelope.algorithm !== 'Ed25519') {
        return { ...base, error: `unsupported signature algorithm ${String(envelope.algorithm)}` };
    }
    if (typeof rawPublicKeyHex !== 'string' || !PUBLIC_PATTERN.test(rawPublicKeyHex)) {
        return { ...base, error: 'public_key_hex must be 64 hex characters' };
    }
    if (typeof signatureHex !== 'string' || !SIGNATURE_PATTERN.test(signatureHex)) {
        return { ...base, error: 'signature_hex must be 128 hex characters' };
    }
    const publicKeyHex = rawPublicKeyHex.toLowerCase();
    const withKey = { ...base, publicKeyHex };
    const key = createPublicKey({
        key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKeyHex, 'hex')]),
        format: 'der',
        type: 'spki',
    });
    const payload = Buffer.concat([stripped.clean, metadataSection.data]);
    if (!verify(null, payload, key, Buffer.from(signatureHex, 'hex'))) {
        return { ...withKey, error: 'signature does not match the file contents' };
    }
    if (expectedPublicKeyHex !== undefined && publicKeyHex !== expectedPublicKeyHex.trim().toLowerCase()) {
        return { ...withKey, error: `unexpected signer ${publicKeyHex}` };
    }
    if (!metadata) return { ...withKey, error: 'metadata does not match the Pumpkin host schema' };
    return { signed: true, valid: true, metadata, publicKeyHex };
}
