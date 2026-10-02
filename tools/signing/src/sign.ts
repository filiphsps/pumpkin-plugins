import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject, sign, verify } from 'node:crypto';
import { appendCustomSections, METADATA_SECTION, SIGNATURE_SECTION, stripSignature, type WasmSection } from './wasm.ts';

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const SECRET_PATTERN = /^[0-9a-fA-F]{64}$/;
const PUBLIC_PATTERN = /^[0-9a-f]{64}$/;
const SIGNATURE_PATTERN = /^[0-9a-f]{128}$/;

/** The metadata Pumpkin expects in the `pumpkin.metadata` section. Field order is the JSON order. */
export interface SigningMetadata {
    /** Marketplace the plugin comes from; empty for independent plugins. */
    marketplace_url: string;
    /** Marketplace plugin id; 0 for independent plugins. */
    plugin_id: number;
    /** The Pumpkin plugin name. */
    plugin_name: string;
    /** The plugin version. */
    version: string;
    /** Marketplace developer id; 0 for independent plugins. */
    dev_id: number;
    /** The developer's name. */
    dev_name: string;
    /** Whether the plugin is paid. */
    is_paid: boolean;
    /** Marketplace user id; 0 for independent plugins. */
    user_id: number;
    /** License key, or null. */
    license_key: string | null;
    /** When the build was signed, ISO-8601 UTC. */
    issued_at: string;
}

/** Result of {@link verifyWasm}. */
export interface VerifyResult {
    /** Whether the binary carries signing sections at all. */
    signed: boolean;
    /** Whether the signature checks out; always false when unsigned. */
    valid: boolean;
    /** Why the binary isn't valid. */
    error?: string;
    /** The signed metadata, when it could be read. */
    metadata?: SigningMetadata;
    /** The public key from the signature envelope, in hex. */
    publicKeyHex?: string;
}

/** A freshly generated Ed25519 key pair, both halves as hex. */
export interface KeyPair {
    /** The 32-byte secret seed as 64 hex characters. Keep it private. */
    secretKeyHex: string;
    /** The 32-byte public key as 64 hex characters. Safe to publish. */
    publicKeyHex: string;
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
        publicKeyHex: rawPublicKey(privateKey)
    };
}

/**
 * Signs a wasm binary the way Pumpkin verifies it. Existing signing sections are replaced.
 * @param wasm - The binary to sign.
 * @param metadata - What to embed; only the documented fields are written, in order.
 * @param secretKeyHex - The 32-byte seed as 64 hex characters.
 * @returns The binary with `pumpkin.metadata` and `wasm_signature` sections appended.
 * @throws {Error} When the key is malformed or the bytes aren't a wasm binary.
 */
export function signWasm(wasm: Uint8Array, metadata: SigningMetadata, secretKeyHex: string): Buffer {
    const key = secretKey(secretKeyHex);
    const { clean } = stripSignature(wasm);
    const metadataJson = Buffer.from(
        JSON.stringify({
            marketplace_url: metadata.marketplace_url,
            plugin_id: metadata.plugin_id,
            plugin_name: metadata.plugin_name,
            version: metadata.version,
            dev_id: metadata.dev_id,
            dev_name: metadata.dev_name,
            is_paid: metadata.is_paid,
            user_id: metadata.user_id,
            license_key: metadata.license_key,
            issued_at: metadata.issued_at
        }),
        'utf8'
    );
    const signature = sign(null, Buffer.concat([clean, metadataJson]), key);
    const envelope = Buffer.from(
        JSON.stringify({
            version: 1,
            algorithm: 'Ed25519',
            public_key_hex: rawPublicKey(key),
            signature_hex: signature.toString('hex')
        }),
        'utf8'
    );
    return appendCustomSections(clean, [
        [METADATA_SECTION, metadataJson],
        [SIGNATURE_SECTION, envelope]
    ]);
}

function last(sections: WasmSection[], name: string): WasmSection | undefined {
    return [...sections].reverse().find((s) => s.name === name);
}

function parseJson(data: Uint8Array): Record<string, unknown> | undefined {
    try {
        const value: unknown = JSON.parse(Buffer.from(data).toString('utf8'));
        return typeof value === 'object' && value !== null && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Checks the signature of a wasm binary. Never throws: problems are reported in the result.
 * @param wasm - The binary to check.
 * @returns Whether it is signed, whether the signature is valid, and what it says.
 */
export function verifyWasm(wasm: Uint8Array): VerifyResult {
    let stripped: ReturnType<typeof stripSignature>;
    try {
        stripped = stripSignature(wasm);
    } catch (error) {
        return { signed: false, valid: false, error: (error as Error).message };
    }
    const metadataSection = last(stripped.trailing, METADATA_SECTION);
    const signatureSection = last(stripped.trailing, SIGNATURE_SECTION);
    if (!signatureSection?.data) return { signed: false, valid: false, error: 'no signature found' };
    if (!metadataSection?.data) {
        return { signed: true, valid: false, error: `signature without a ${METADATA_SECTION} section` };
    }
    const metadata = parseJson(metadataSection.data) as SigningMetadata | undefined;
    const envelope = parseJson(signatureSection.data);
    const base = { signed: true, valid: false, ...(metadata ? { metadata } : {}) };
    if (!envelope) return { ...base, error: 'signature envelope is not a JSON object' };
    const publicKeyHex = envelope.public_key_hex;
    const signatureHex = envelope.signature_hex;
    if (envelope.version !== 1) return { ...base, error: `unsupported signature version ${String(envelope.version)}` };
    if (envelope.algorithm !== 'Ed25519') {
        return { ...base, error: `unsupported signature algorithm ${String(envelope.algorithm)}` };
    }
    if (typeof publicKeyHex !== 'string' || !PUBLIC_PATTERN.test(publicKeyHex)) {
        return { ...base, error: 'public_key_hex must be 64 lowercase hex characters' };
    }
    if (typeof signatureHex !== 'string' || !SIGNATURE_PATTERN.test(signatureHex)) {
        return { ...base, error: 'signature_hex must be 128 lowercase hex characters' };
    }
    const withKey = { ...base, publicKeyHex };
    const key = createPublicKey({
        key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKeyHex, 'hex')]),
        format: 'der',
        type: 'spki'
    });
    const payload = Buffer.concat([stripped.clean, metadataSection.data]);
    if (!verify(null, payload, key, Buffer.from(signatureHex, 'hex'))) {
        return { ...withKey, error: 'signature does not match the file contents' };
    }
    if (!metadata) return { ...withKey, error: 'metadata is not a JSON object' };
    return { signed: true, valid: true, metadata, publicKeyHex };
}
