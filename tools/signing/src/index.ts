export {
    generateKeyPair,
    type KeyPair,
    publicKeyOf,
    type SigningMetadata,
    signWasm,
    type VerifyResult,
    verifyWasm
} from './sign.ts';
export {
    appendCustomSections,
    customSection,
    METADATA_SECTION,
    parseSections,
    SIGNATURE_SECTION,
    SIGNING_SECTIONS,
    type StrippedWasm,
    stripSignature,
    type WasmSection
} from './wasm.ts';
