import type { Context } from 'pumpkin:plugin/context@0.1.0';
import type { IpcMessage, PluginId } from 'pumpkin:plugin/ipc@0.1.0';
import * as logging from 'pumpkin:plugin/logging@0.1.0';
import type { PluginMetadata } from 'pumpkin:plugin/metadata@0.1.0';
import { ipcSend } from '@pumpkin-plugins/plugin-kit/ipc';
import { Plugin, registerPlugin } from '@pumpkin-plugins/pumpkin-api';
import { CallbackGuard, ExpansionRouter, PieClient, UnavailableError } from '../../../../src/index.ts';

const FIXTURE_NAME = 'PieConsumerFixture';
const guard = new CallbackGuard();
const router = new ExpansionRouter(guard);
const client = new PieClient(ipcSend, { guard });

/** Drives the client and router over real host IPC and logs what the provider returned. */
class PieConsumerFixture extends Plugin {
    private taskId: number | undefined;

    metadata(): PluginMetadata {
        return {
            name: FIXTURE_NAME,
            version: __PLUGIN_VERSION__,
            authors: [],
            description: 'PumpkinPIE client integration fixture',
            dependencies: [],
            permissions: [],
        };
    }

    override onLoad(context: Context): void {
        super.onLoad(context);
        router.register('pieconsumer', {
            echo: ({ viewer, argument }) => `${viewer ?? 'server'}:${argument ?? 'none'}`,
        });
        this.taskId = this.scheduleRepeatingTask(1, 10, () => this.verifyProvider());
    }

    override onUnload(context: Context): void {
        this.stopVerification();
        super.onUnload(context);
    }

    private verifyProvider(): void {
        try {
            const provider = client.ping();
            const registered = client.registerExpansion({ namespace: 'pieconsumer', placeholders: ['echo'] });
            const online = client.resolve('online=%server_online%');
            const own = client.resolve('own=%pieconsumer_echo%');
            const argument = client.getValue('pieconsumer_echo', undefined, 'arg');
            logging.log(
                'info',
                `${FIXTURE_NAME}: ${JSON.stringify({ protocol: provider.protocol, registered, online, own, argument })}`,
            );
            this.stopVerification();
        } catch (error) {
            // The provider may load after this plugin; keep polling until it answers.
            if (error instanceof UnavailableError) return;
            logging.log('error', `${FIXTURE_NAME}: provider verification failed: ${String(error)}`);
            this.stopVerification();
        }
    }

    /** Routes provider callbacks into the expansion router, which checks the sender. */
    override handleIpcMessage(sender: PluginId, message: IpcMessage): IpcMessage {
        return router.handle(sender, message);
    }

    private stopVerification(): void {
        if (this.taskId !== undefined) this.cancelTask(this.taskId);
        this.taskId = undefined;
    }
}

registerPlugin(new PieConsumerFixture());

export * from '@pumpkin-plugins/pumpkin-api';
