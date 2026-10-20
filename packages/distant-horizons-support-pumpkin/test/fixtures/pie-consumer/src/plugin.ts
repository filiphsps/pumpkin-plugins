import type { Context } from 'pumpkin:plugin/context@0.1.0';
import * as logging from 'pumpkin:plugin/logging@0.1.0';
import type { PluginMetadata } from 'pumpkin:plugin/metadata@0.1.0';
import { ipcSend } from '@pumpkin-plugins/plugin-kit/ipc';
import { Plugin, registerPlugin } from '@pumpkin-plugins/pumpkin-api';
import { PieClient, UnavailableError } from '@pumpkin-plugins/pumpkin-pie-api';

const FIXTURE_NAME = 'DistantHorizonsPIEFixture';

/** Uses PumpkinPIE to resolve the live Distant Horizons expansion contract. */
class DistantHorizonsPieFixture extends Plugin {
    private taskId: number | undefined;

    metadata(): PluginMetadata {
        return {
            name: FIXTURE_NAME,
            version: __PLUGIN_VERSION__,
            authors: [],
            description: 'Distant Horizons PumpkinPIE consumer integration fixture',
            dependencies: [],
            permissions: [],
        };
    }

    override onLoad(context: Context): void {
        super.onLoad(context);
        this.taskId = this.scheduleRepeatingTask(1, 10, () => this.verifyProvider());
    }

    override onUnload(context: Context): void {
        this.stopVerification();
        super.onUnload(context);
    }

    private verifyProvider(): void {
        try {
            const pie = new PieClient(ipcSend);
            const advertised = pie.list().filter(({ namespace }) => namespace === 'dhs');
            if (advertised.length === 0) return;

            const required = ['dhs_clients', 'dhs_memory_entries', 'dhs_client_connected'];
            if (!required.every((id) => advertised.some((placeholder) => placeholder.id === id))) return;

            const clients = pie.getValue('dhs_clients');
            const memoryEntries = pie.getValue('dhs_memory_entries');
            const clientConnected = pie.getValue('dhs_client_connected');
            if (
                !clients.known ||
                clients.value !== '0' ||
                !memoryEntries.known ||
                memoryEntries.value !== '0' ||
                clientConnected.known
            ) {
                throw new Error(
                    `Distant Horizons placeholders returned unexpected values: ${JSON.stringify({
                        clients,
                        memoryEntries,
                        clientConnected,
                    })}`,
                );
            }

            logging.log(
                'info',
                `${FIXTURE_NAME}: ${JSON.stringify({
                    advertisedCount: advertised.length,
                    ids: advertised.map(({ id }) => id),
                    clients,
                    memoryEntries,
                    clientConnected,
                })}`,
            );
            this.stopVerification();
        } catch (error) {
            if (error instanceof UnavailableError) return;
            logging.log('error', `${FIXTURE_NAME}: provider verification failed: ${String(error)}`);
            this.stopVerification();
        }
    }

    private stopVerification(): void {
        if (this.taskId !== undefined) this.cancelTask(this.taskId);
        this.taskId = undefined;
    }
}

registerPlugin(new DistantHorizonsPieFixture());

export * from '@pumpkin-plugins/pumpkin-api';
