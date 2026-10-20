import type { Context } from 'pumpkin:plugin/context@0.1.0';
import * as logging from 'pumpkin:plugin/logging@0.1.0';
import type { PluginMetadata } from 'pumpkin:plugin/metadata@0.1.0';
import { ipcSend } from '@pumpkin-plugins/plugin-kit/ipc';
import { Plugin, registerPlugin } from '@pumpkin-plugins/pumpkin-api';
import { PieClient, UnavailableError } from '@pumpkin-plugins/pumpkin-pie-api';

const FIXTURE_NAME = 'WaypointsPIEFixture';

/** Uses the public consumer API against the live Waypoints expansion. */
class WaypointsPieFixture extends Plugin {
    private taskId: number | undefined;

    metadata(): PluginMetadata {
        return {
            name: FIXTURE_NAME,
            version: __PLUGIN_VERSION__,
            authors: [],
            description: 'Waypoints PumpkinPIE consumer integration fixture',
            dependencies: [],
            permissions: [],
        };
    }

    override onLoad(context: Context): void {
        super.onLoad(context);
        this.taskId = this.scheduleRepeatingTask(1, 10, () => this.verifyProvider());
    }

    override onUnload(context: Context): void {
        if (this.taskId !== undefined) this.cancelTask(this.taskId);
        this.taskId = undefined;
        super.onUnload(context);
    }

    private verifyProvider(): void {
        try {
            const pie = new PieClient(ipcSend);
            pie.ping();
            const advertised = pie.list().filter(({ namespace }) => namespace === 'waypoints');
            const required = ['waypoints_count', 'waypoints_closest_name', 'waypoints_waypoint_exists'];
            if (!required.every((id) => advertised.some((placeholder) => placeholder.id === id))) return;

            const [plain, tokenized] = pie.resolveBatch([
                { text: 'Resolved literal text', viewer: 'OfflineSubject' },
                { text: 'Count: %waypoints_count%', viewer: 'OfflineSubject' },
            ]);
            const direct = pie.getValue('waypoints_count', 'OfflineSubject');
            if (
                plain?.text !== 'Resolved literal text' ||
                plain.unresolved.length !== 0 ||
                tokenized?.text !== 'Count: %waypoints_count%' ||
                !tokenized.unresolved.includes('waypoints_count') ||
                direct.known
            ) {
                throw new Error('Waypoints callback did not preserve the offline-viewer contract');
            }

            logging.log(
                'info',
                `${FIXTURE_NAME}: ${JSON.stringify({
                    advertisedCount: advertised.length,
                    resolved: plain,
                    unresolved: tokenized,
                    offlineKnown: direct.known,
                })}`,
            );
            if (this.taskId !== undefined) this.cancelTask(this.taskId);
            this.taskId = undefined;
        } catch (error) {
            // PumpkinPIE may load after this plugin; keep polling until it answers.
            if (error instanceof UnavailableError) return;
            logging.log('error', `${FIXTURE_NAME}: provider verification failed: ${String(error)}`);
            if (this.taskId !== undefined) this.cancelTask(this.taskId);
            this.taskId = undefined;
        }
    }
}

registerPlugin(new WaypointsPieFixture());

export * from '@pumpkin-plugins/pumpkin-api';
