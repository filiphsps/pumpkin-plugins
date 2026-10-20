import { Command } from 'pumpkin:plugin/command@0.1.0';
import type { Context } from 'pumpkin:plugin/context@0.1.0';
import type { IpcMessage, PluginId } from 'pumpkin:plugin/ipc@0.1.0';
import * as logging from 'pumpkin:plugin/logging@0.1.0';
import type { PluginMetadata } from 'pumpkin:plugin/metadata@0.1.0';
import { ipcSend } from '@pumpkin-plugins/plugin-kit/ipc';
import { handleIpcMessage as apiHandleIpcMessage, Plugin, registerPlugin } from '@pumpkin-plugins/pumpkin-api';
import { strFromU8, strToU8 } from 'fflate';
import { PieSession, UnavailableError } from '../../../../src/index.ts';

const fixtureName = 'PieSessionFixture';
let session: PieSession | undefined;

/** Drives a PieSession over real host IPC: registers an argument-aware expansion and stops on command. */
class PieSessionFixture extends Plugin {
    private taskId: number | undefined;

    metadata(): PluginMetadata {
        return {
            name: fixtureName,
            version: __PLUGIN_VERSION__,
            authors: [],
            description: 'PumpkinPIE session integration fixture',
            dependencies: [],
            permissions: [],
        };
    }

    override onLoad(ctx: Context): void {
        super.onLoad(ctx);
        session = new PieSession({ send: ipcSend, now: () => 0 });
        session.registerExpansion('piesession', {
            echo: ({ viewer, argument }) => `${viewer ?? 'server'}:${argument ?? 'none'}`,
            decline: () => undefined,
        });
        this.taskId = this.scheduleRepeatingTask(1, 10, () => this.verifyProvider());

        const command = new Command(['piesession'], 'Stop the PumpkinPIE session fixture');
        this.registerCommand(ctx, command, (_sender, _server, _args) => {
            session?.stop();
            logging.log('info', `${fixtureName}: session stopped`);
            return 1;
        });
    }

    override onUnload(ctx: Context): void {
        this.stopVerification();
        session?.stop();
        session = undefined;
        super.onUnload(ctx);
    }

    private verifyProvider(): void {
        const current = session;
        if (current === undefined) return;
        try {
            // PumpkinPIE may load after this plugin; keep polling until it answers, because the
            // session waits out its retry backoff after a failed first attempt.
            current.client.ping();
        } catch (error) {
            if (error instanceof UnavailableError) return;
        }
        this.stopVerification();
        try {
            current.tick();
            if (current.state.kind !== 'ready') {
                logging.log('error', `${fixtureName}: PumpkinPIE is unavailable`);
                return;
            }
            const batch = current.client.resolveBatch([
                { text: 'left=%piesession_echo%', viewer: 'Casey' },
                { text: 'right=%piesession_echo%', viewer: 'Morgan' },
                { text: '%piesession_decline%', viewer: 'Casey' },
                { text: '%missing_piesession_value%', viewer: 'Casey' },
            ]);
            const argument = current.client.getValue('piesession_echo', 'ArgViewer', 'argument-value');
            const forged = current.router.handle(
                'UntrustedPlugin',
                strToU8(
                    JSON.stringify({
                        op: 'on_request',
                        namespace: 'piesession',
                        id: 'fixture',
                        name: 'echo',
                        viewer: 'Spoofed',
                    }),
                ),
            );
            const senderRejected = JSON.parse(strFromU8(forged)).ok === false;
            logging.log('info', `${fixtureName}: ${JSON.stringify({ batch, argument, senderRejected })}`);
        } catch (error) {
            logging.log('error', `${fixtureName}: provider verification failed: ${String(error)}`);
        }
    }

    private stopVerification(): void {
        if (this.taskId !== undefined) this.cancelTask(this.taskId);
        this.taskId = undefined;
    }
}

registerPlugin(new PieSessionFixture());

export { handleTask } from '@pumpkin-plugins/pumpkin-api';

/** Routes provider callbacks into the registered expansion router. */
export function handleIpcMessage(sender: PluginId, message: IpcMessage): IpcMessage {
    return session?.router.handle(sender, message) ?? apiHandleIpcMessage(sender, message);
}

/** Uses the API package's command handler registry. */
export * from '@pumpkin-plugins/pumpkin-api';
