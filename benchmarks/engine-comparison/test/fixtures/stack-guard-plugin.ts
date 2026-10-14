import type { Context } from 'pumpkin:plugin/context@0.1.0';
import * as logging from 'pumpkin:plugin/logging@0.1.0';
import type { PluginMetadata } from 'pumpkin:plugin/metadata@0.1.0';
import { Plugin, registerPlugin } from '@pumpkin-plugins/pumpkin-api';

export * from '@pumpkin-plugins/pumpkin-api';

class StackGuardPlugin extends Plugin {
    metadata(): PluginMetadata {
        return {
            name: 'StackGuard',
            version: '0.0.0',
            authors: [],
            description: '',
            dependencies: [],
            permissions: []
        };
    }

    onLoad(context: Context): void {
        super.onLoad(context);
        logging.log('info', `STACK_GUARD:${catchesStackOverflow()}`);
    }
}

function catchesStackOverflow(): boolean {
    function recurse(): number {
        return recurse() + 1;
    }

    try {
        recurse();
        return false;
    } catch (error) {
        return error instanceof RangeError && error.message.includes('Maximum call stack size exceeded');
    }
}

registerPlugin(new StackGuardPlugin());
