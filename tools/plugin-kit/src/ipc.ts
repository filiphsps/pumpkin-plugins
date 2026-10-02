import { sendIpcMessage } from 'pumpkin:plugin/ipc@0.1.0';

/**
 * Sends an IPC message to another plugin and returns its answer.
 * @param recipient - The other plugin's name, as it shows in Pumpkin.
 * @param message - The bytes to send.
 * @throws {Error} When the plugin isn't loaded or answers with an error.
 */
export function ipcSend(recipient: string, message: Uint8Array): Uint8Array {
    // The host returns nested results. Depending on the runtime the success value arrives bare or
    // as a tagged object, so both are accepted.
    const answer: unknown = sendIpcMessage(recipient, message);
    if (answer instanceof Uint8Array) return answer;
    const tagged = answer as { tag?: string; val?: unknown } | null;
    if (tagged?.tag === 'ok' && tagged.val instanceof Uint8Array) return tagged.val;
    if (tagged?.tag === 'err') throw new Error(String(tagged.val));
    throw new Error(`${recipient} did not answer`);
}
