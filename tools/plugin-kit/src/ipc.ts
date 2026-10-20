import { sendIpcMessage } from 'pumpkin:plugin/ipc@0.1.0';

/**
 * Sends an IPC message to another plugin and returns its answer.
 * @param recipient - The other plugin's name, as it shows in Pumpkin.
 * @param message - The bytes to send.
 * @throws {Error} When the plugin isn't loaded or answers with an error.
 */
export function ipcSend(recipient: string, message: Uint8Array): Uint8Array {
    const answer = sendIpcMessage(recipient, message);
    if (answer.tag === 'err') throw new Error(answer.val);
    return answer.val;
}
