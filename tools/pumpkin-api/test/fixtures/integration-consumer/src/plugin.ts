import { Command } from 'pumpkin:plugin/command@0.1.0';
import type { Context } from 'pumpkin:plugin/context@0.1.0';
import * as logging from 'pumpkin:plugin/logging@0.1.0';
import type { PluginMetadata } from 'pumpkin:plugin/metadata@0.1.0';
import { Plugin, registerPlugin } from '@pumpkin-plugins/pumpkin-api';

class ApiIntegrationFixture extends Plugin {
    private loadEventCount = 0;
    private delayedTaskCount = 0;
    private repeatingTaskCount = 0;
    private commandCount = 0;
    private cancelledTaskCount = 0;
    private selfCancelledTaskCount = 0;
    private lastLoadType = 'unknown';

    metadata(): PluginMetadata {
        return {
            name: 'PumpkinApiTestFixture',
            version: __PLUGIN_VERSION__,
            authors: [],
            description: 'Exercises the Pumpkin API against a real server.',
            dependencies: [],
            permissions: [],
        };
    }

    onLoad(context: Context): void {
        this.registerEvent(context, 'server-load-event', (_, event) => {
            this.loadEventCount += 1;
            this.lastLoadType = event.loadType;
            logging.log('info', `PumpkinApiTestFixture server-load callback loadType=${event.loadType}`);
        });

        this.scheduleDelayedTask(1, () => {
            this.delayedTaskCount += 1;
            logging.log('info', `PumpkinApiTestFixture delayed callback count=${this.delayedTaskCount}`);
        });

        this.scheduleRepeatingTask(1, 20, () => {
            this.repeatingTaskCount += 1;
            logging.log('info', `PumpkinApiTestFixture repeating callback count=${this.repeatingTaskCount}`);
        });

        const cancelledTaskId = this.scheduleDelayedTask(20, () => {
            this.cancelledTaskCount += 1;
        });
        this.cancelTask(cancelledTaskId);
        const repeatingTaskId = this.scheduleRepeatingTask(1, 1, () => {
            this.selfCancelledTaskCount += 1;
            this.cancelTask(repeatingTaskId);
        });
        this.scheduleDelayedTask(30, () => {
            logging.log(
                'info',
                `PumpkinApiTestFixture cancellation delayed=${this.cancelledTaskCount} ` +
                    `repeating=${this.selfCancelledTaskCount}`,
            );
        });

        const command = new Command(['pumpkin-api-test'], 'Inspect the Pumpkin API integration fixture.');
        this.registerCommand(context, command, () => {
            this.commandCount += 1;
            logging.log(
                'info',
                `PumpkinApiTestFixture command callback=${this.commandCount} loadEvents=${this.loadEventCount} ` +
                    `delayedTasks=${this.delayedTaskCount} loadType=${this.lastLoadType}`,
            );
            return 1;
        });
    }
}

registerPlugin(new ApiIntegrationFixture());

export * from '@pumpkin-plugins/pumpkin-api';
