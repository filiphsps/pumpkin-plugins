import { createPublicKey, type KeyObject, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateKeyPair, publicKeyOf, signWasm, verifyWasm } from './sign.ts';
import { METADATA, minimalWasm, SEED } from './testing/fixtures.ts';
import { appendCustomSections, parseSections, stripSignature } from './wasm.ts';

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

// Computed once from SEED over minimalWasm() + METADATA; Ed25519 is deterministic.
const KNOWN_PUBLIC_KEY = '03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8';
const KNOWN_SIGNATURE =
    'baff55fcd5f0a601e81f227ee00f104dfd15696fdee83936f90e058d9a57d05003dc9b7bb29c5c116d7ac667c29100bff29e638fc31e749de0128084f97c9a07';

describe('keys', () => {
    it('generates a usable pair', () => {
        const pair = generateKeyPair();
        expect(pair.secretKeyHex).toMatch(/^[0-9a-f]{64}$/);
        expect(pair.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
        expect(publicKeyOf(pair.secretKeyHex)).toBe(pair.publicKeyHex);
        expect(generateKeyPair().secretKeyHex).not.toBe(pair.secretKeyHex);
    });

    it('derives the RFC 8032 public key for a known seed', () => {
        const seed = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
        expect(publicKeyOf(seed)).toBe('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
    });

    it.each([
        ['empty', ''],
        ['short', 'abcd'],
        ['too long', `${SEED}00`],
        ['not hex', 'z'.repeat(64)]
    ])('rejects a %s key', (_label, key) => {
        expect(() => signWasm(minimalWasm(), METADATA, key)).toThrow(/invalid signing key/);
        expect(() => publicKeyOf(key)).toThrow(/64 hex/);
    });

    it('accepts uppercase hex and surrounding whitespace', () => {
        expect(publicKeyOf(` ${SEED.toUpperCase()}\n`)).toBe(publicKeyOf(SEED));
    });
});

describe('signWasm', () => {
    const wasm = minimalWasm();
    const signed = signWasm(wasm, METADATA, SEED);

    it('keeps the original bytes and appends the two sections in order', () => {
        expect(signed.subarray(0, wasm.length).equals(wasm)).toBe(true);
        const added = parseSections(signed).slice(parseSections(wasm).length);
        expect(added.map((s) => s.name)).toEqual(['pumpkin.metadata', 'wasm_signature']);
        expect(signed.at(wasm.length)).toBe(0x00);
    });

    it('writes exactly the documented metadata fields in order', () => {
        const section = parseSections(signed).find((s) => s.name === 'pumpkin.metadata');
        const json = Buffer.from(section?.data ?? []).toString('utf8');
        expect(Object.keys(JSON.parse(json))).toEqual([
            'marketplace_url',
            'plugin_id',
            'plugin_name',
            'version',
            'dev_id',
            'dev_name',
            'is_paid',
            'user_id',
            'license_key',
            'issued_at'
        ]);
        expect(JSON.parse(json)).toEqual(METADATA);
    });

    it('drops fields that are not part of the format', () => {
        const extra = signWasm(wasm, { ...METADATA, extra: 1 } as typeof METADATA, SEED);
        expect(verifyWasm(extra).metadata).toEqual(METADATA);
    });

    it('writes the envelope with the documented fields', () => {
        const section = parseSections(signed).find((s) => s.name === 'wasm_signature');
        const envelope = JSON.parse(Buffer.from(section?.data ?? []).toString('utf8'));
        expect(Object.keys(envelope)).toEqual(['version', 'algorithm', 'public_key_hex', 'signature_hex']);
        expect(envelope.version).toBe(1);
        expect(envelope.algorithm).toBe('Ed25519');
        expect(envelope.public_key_hex).toBe(publicKeyOf(SEED));
    });

    it('is deterministic', () => {
        expect(signWasm(wasm, METADATA, SEED).equals(signed)).toBe(true);
    });

    it('matches a known answer for a fixed seed', () => {
        const section = parseSections(signed).find((s) => s.name === 'wasm_signature');
        const envelope = JSON.parse(Buffer.from(section?.data ?? []).toString('utf8'));
        expect(envelope.public_key_hex).toBe(KNOWN_PUBLIC_KEY);
        expect(envelope.signature_hex).toBe(KNOWN_SIGNATURE);
    });

    it('verifies independently with crypto.verify and the envelope public key', () => {
        const { clean, trailing } = stripSignature(signed);
        const [metadata, signature] = trailing;
        const envelope = JSON.parse(Buffer.from(signature?.data ?? []).toString('utf8'));
        const key: KeyObject = createPublicKey({
            key: Buffer.concat([SPKI_PREFIX, Buffer.from(envelope.public_key_hex, 'hex')]),
            format: 'der',
            type: 'spki'
        });
        const payload = Buffer.concat([clean, metadata?.data ?? Buffer.alloc(0)]);
        expect(verify(null, payload, key, Buffer.from(envelope.signature_hex, 'hex'))).toBe(true);
        expect(
            verify(null, Buffer.concat([payload, Buffer.from('x')]), key, Buffer.from(envelope.signature_hex, 'hex'))
        ).toBe(false);
    });

    it('rejects input that is not wasm', () => {
        expect(() => signWasm(Buffer.from('hello world'), METADATA, SEED)).toThrow(/not a WebAssembly/);
    });
});

describe('verifyWasm', () => {
    const wasm = minimalWasm();
    const signed = signWasm(wasm, METADATA, SEED);

    it('round trips', () => {
        expect(verifyWasm(signed)).toEqual({
            signed: true,
            valid: true,
            metadata: METADATA,
            publicKeyHex: publicKeyOf(SEED)
        });
    });

    it('reports unsigned input as not signed', () => {
        const result = verifyWasm(wasm);
        expect(result.signed).toBe(false);
        expect(result.valid).toBe(false);
        expect(result.error).toMatch(/no signature/);
    });

    it('reports non-wasm input without throwing', () => {
        expect(verifyWasm(Buffer.from('hello'))).toMatchObject({ signed: false, valid: false });
    });

    it('re-signing replaces the old sections', () => {
        const other = generateKeyPair();
        const resigned = signWasm(signed, { ...METADATA, version: '9.9.9' }, other.secretKeyHex);
        const names = parseSections(resigned).map((s) => s.name);
        expect(names.filter((n) => n === 'pumpkin.metadata')).toHaveLength(1);
        expect(names.filter((n) => n === 'wasm_signature')).toHaveLength(1);
        const result = verifyWasm(resigned);
        expect(result.valid).toBe(true);
        expect(result.publicKeyHex).toBe(other.publicKeyHex);
        expect(result.metadata?.version).toBe('9.9.9');
        expect(stripSignature(resigned).clean.equals(wasm)).toBe(true);
    });

    it('re-signing with the same inputs is idempotent', () => {
        expect(signWasm(signed, METADATA, SEED).equals(signed)).toBe(true);
    });

    it('fails when any byte of the file is changed', () => {
        for (let i = 0; i < signed.length; i++) {
            const tampered = Buffer.from(signed);
            tampered[i] = (tampered[i] as number) ^ 0x01;
            expect(verifyWasm(tampered).valid, `byte ${i}`).toBe(false);
        }
    });

    it('fails when code is changed but the sections stay recognizable', () => {
        const tampered = Buffer.from(signed);
        tampered[11] = (tampered[11] as number) ^ 0xff;
        const result = verifyWasm(tampered);
        expect(result).toMatchObject({ signed: true, valid: false });
        expect(result.error).toMatch(/does not match/);
    });

    it('fails when the metadata is swapped for different metadata', () => {
        const forged = signWasm(wasm, { ...METADATA, plugin_name: 'evil' }, SEED);
        const { trailing } = stripSignature(forged);
        const genuine = stripSignature(signed).trailing;
        const mixed = appendCustomSections(stripSignature(signed).clean, [
            ['pumpkin.metadata', trailing[0]?.data ?? Buffer.alloc(0)],
            ['wasm_signature', genuine[1]?.data ?? Buffer.alloc(0)]
        ]);
        expect(verifyWasm(mixed)).toMatchObject({ signed: true, valid: false });
    });

    it('fails when the signature section is missing its metadata section', () => {
        const { clean, trailing } = stripSignature(signed);
        const onlySignature = appendCustomSections(clean, [['wasm_signature', trailing[1]?.data ?? Buffer.alloc(0)]]);
        expect(verifyWasm(onlySignature)).toMatchObject({ signed: true, valid: false });
    });

    it('fails on a malformed envelope', () => {
        const { clean, trailing } = stripSignature(signed);
        const metadata = trailing[0]?.data ?? Buffer.alloc(0);
        for (const envelope of [
            'not json',
            '[]',
            '{"version":2}',
            '{"version":1,"algorithm":"RSA"}',
            '{"version":1,"algorithm":"Ed25519","public_key_hex":"00","signature_hex":"00"}'
        ]) {
            const bad = appendCustomSections(clean, [
                ['pumpkin.metadata', metadata],
                ['wasm_signature', Buffer.from(envelope)]
            ]);
            expect(verifyWasm(bad), envelope).toMatchObject({ signed: true, valid: false });
        }
    });

    it('rejects a signature made by a different key than the envelope claims', () => {
        const other = generateKeyPair();
        const a = stripSignature(signed);
        const b = stripSignature(signWasm(wasm, METADATA, other.secretKeyHex));
        const envelope = JSON.parse(Buffer.from(a.trailing[1]?.data ?? []).toString('utf8'));
        envelope.signature_hex = JSON.parse(Buffer.from(b.trailing[1]?.data ?? []).toString('utf8')).signature_hex;
        const swapped = appendCustomSections(a.clean, [
            ['pumpkin.metadata', a.trailing[0]?.data ?? Buffer.alloc(0)],
            ['wasm_signature', Buffer.from(JSON.stringify(envelope))]
        ]);
        expect(verifyWasm(swapped).valid).toBe(false);
    });
});

describe('components', () => {
    it('signs and verifies a component-model binary', () => {
        const component = Buffer.from(minimalWasm());
        component.set([0x0d, 0x00, 0x01, 0x00], 4);
        const signed = signWasm(component, METADATA, SEED);
        expect(signed.subarray(0, component.length).equals(component)).toBe(true);
        expect(verifyWasm(signed).valid).toBe(true);
    });
});
