import { Command } from 'pumpkin:plugin/command@0.1.0';
import type { Context } from 'pumpkin:plugin/context@0.1.0';
import type { IpcMessage, PluginId } from 'pumpkin:plugin/ipc@0.1.0';
import * as logging from 'pumpkin:plugin/logging@0.1.0';
import type { PluginMetadata } from 'pumpkin:plugin/metadata@0.1.0';
import { ipcSend } from '@pumpkin-plugins/plugin-kit/ipc';
import { handleIpcMessage as apiHandleIpcMessage, Plugin, registerPlugin } from '@pumpkin-plugins/pumpkin-api';
import { PieSession } from '@pumpkin-plugins/pumpkin-pie-api';
import { strFromU8, strToU8 } from 'fflate';

const fixtureName = 'TabDisplayPIEFixture';
let session: PieSession | undefined;

/** Minimal guest fixture that registers an argument-aware expansion with the real provider. */
class PieExpansionFixture extends Plugin {
    metadata(): PluginMetadata {
        return {
            name: fixtureName,
            version: __PLUGIN_VERSION__,
            authors: [],
            description: 'Plan 016 PumpkinPIE integration fixture',
            dependencies: [],
            permissions: [],
        };
    }

    override onLoad(ctx: Context): void {
        super.onLoad(ctx);
        session = new PieSession({ send: ipcSend, now: () => 0 });
        session.registerExpansion('tabdisplayfixture', {
            echo: ({ viewer, argument }) => `${viewer ?? 'server'}:${argument ?? 'none'}`,
            decline: () => undefined,
        });
        this.scheduleDelayedTask(1, () => this.verifyProvider());

        const command = new Command(['piefixture'], 'Stop the PumpkinPIE integration fixture');
        this.registerCommand(ctx, command, (_sender, _server, _args) => {
            session?.stop();
            logging.log('info', `${fixtureName}: session stopped`);
            return 1;
        });
    }

    override onUnload(ctx: Context): void {
        session?.stop();
        session = undefined;
        super.onUnload(ctx);
    }

    private verifyProvider(): void {
        const current = session;
        if (current === undefined) return;
        try {
            current.tick();
            if (current.state.kind !== 'ready') {
                logging.log('error', `${fixtureName}: PumpkinPIE is unavailable`);
                return;
            }
            const batch = current.client.resolveBatch([
                { text: 'left=%tabdisplayfixture_echo%', viewer: 'Casey' },
                { text: 'right=%tabdisplayfixture_echo%', viewer: 'Morgan' },
                { text: '%tabdisplayfixture_decline%', viewer: 'Casey' },
                { text: '%missing_tabdisplay_value%', viewer: 'Casey' },
            ]);
            const argument = current.client.getValue('tabdisplayfixture_echo', 'ArgViewer', 'argument-value');
            const forged = current.router.handle(
                'UntrustedPlugin',
                strToU8(
                    JSON.stringify({
                        op: 'on_request',
                        namespace: 'tabdisplayfixture',
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
}

registerPlugin(new PieExpansionFixture());

export { handleTask } from '@pumpkin-plugins/pumpkin-api';

/** Routes provider callbacks into the registered expansion router. */
export function handleIpcMessage(sender: PluginId, message: IpcMessage): IpcMessage {
    return session?.router.handle(sender, message) ?? apiHandleIpcMessage(sender, message);
}

/** Uses the API package's command handler registry. */
export * from '@pumpkin-plugins/pumpkin-api';
