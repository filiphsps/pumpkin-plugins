import type { Context } from 'pumpkin:plugin/context@0.1.0';
import type { PlayerJoinEventData } from 'pumpkin:plugin/event@0.1.0';
import {
    type AiGoal,
    type ChunkGenerator,
    type CommandHandler,
    type CommandSuggestionHandler,
    type EventHandler,
    Plugin,
    type TaskHandler
} from '../src/index.ts';

const eventHandler: EventHandler<{ readonly name: string }> = (_server, event) => ({ name: event.name });
const ignoreName = (_name: string): void => {};
const sideEffectEventHandler: EventHandler<{ readonly name: string }> = (_server, event) => {
    ignoreName(event.name);
};
type IsAny<T> = 0 extends 1 & T ? true : false;
type DefaultEventPayloadIsNotAny = IsAny<Parameters<EventHandler>[1]> extends false ? true : never;
const defaultEventPayloadIsNotAny: DefaultEventPayloadIsNotAny = true;
const commandHandler: CommandHandler = (_sender, _server, _args) => 0;
const suggestionHandler: CommandSuggestionHandler = (_sender, _server, request) => ({
    start: request.start,
    length: request.input.length,
    values: [{ value: request.input }]
});
const taskHandler: TaskHandler = (_server) => {};
const aiGoal: AiGoal = {
    canStart: (_server, _entity) => true,
    shouldContinue: (_server, _entity) => true,
    start: (_server, _entity) => {},
    tick: (_server, _entity) => {},
    stop: (_server, _entity) => {}
};
const chunkGenerator: ChunkGenerator = (_phase, _chunk) => {};

class TypecheckPlugin extends Plugin {
    metadata() {
        return {
            name: 'typecheck-plugin',
            version: '1.0.0',
            authors: [],
            description: 'compile-time API contract',
            dependencies: [],
            permissions: []
        };
    }

    onLoad(context: Context): void {
        this.registerEvent(context, 'player-join-event', (_server, event: PlayerJoinEventData) => event);

        // @ts-expect-error A join-event payload cannot handle leave events.
        this.registerEvent(context, 'player-leave-event', (_server, event: PlayerJoinEventData) => event);
    }
}

void [
    eventHandler,
    sideEffectEventHandler,
    defaultEventPayloadIsNotAny,
    commandHandler,
    suggestionHandler,
    taskHandler,
    aiGoal,
    chunkGenerator,
    TypecheckPlugin
];
