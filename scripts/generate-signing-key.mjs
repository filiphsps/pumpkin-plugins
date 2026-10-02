// Prints a new Ed25519 key pair for signing plugin releases. Nothing is written to disk.
import { generateKeyPair } from '@pumpkin-plugins/signing';

const { secretKeyHex, publicKeyHex } = generateKeyPair();
console.log(`secret key (PLUGIN_SIGNING_KEY): ${secretKeyHex}`);
console.log(`public key:                      ${publicKeyHex}`);
console.log(
    '\nStore the secret as the PLUGIN_SIGNING_KEY repository secret (Settings, Secrets and variables, Actions) and ' +
        'keep it private; the public key is safe to publish.'
);
