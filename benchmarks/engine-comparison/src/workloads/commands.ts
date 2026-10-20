import type { WorkloadScenario } from '../benchmark-workloads.ts';

const COMMAND_OPERATION_COUNT = 4_000;

/** Command tokenization, alias resolution and route lookup workloads. */
export const COMMAND_WORKLOADS: readonly WorkloadScenario[] = [
    {
        name: 'command-routing',
        area: 'Command tokenization, alias resolution and route-map lookup',
        operationsPerSample: COMMAND_OPERATION_COUNT,
        run: runCommandRouting,
    },
    {
        name: 'command-tokenization',
        area: 'Command tokenization',
        operationsPerSample: COMMAND_OPERATION_COUNT,
        run: runCommandTokenization,
    },
    {
        name: 'command-route-lookup',
        area: 'Command alias and route-map lookup',
        operationsPerSample: COMMAND_OPERATION_COUNT,
        run: runCommandRouteLookup,
    },
];

const COMMAND_ROUTES = new Map([
    ['home', { permission: 'essentials.home', minimumArguments: 0, maximumArguments: 1 }],
    ['warp', { permission: 'essentials.warp', minimumArguments: 1, maximumArguments: 1 }],
    ['teleport', { permission: 'essentials.teleport', minimumArguments: 1, maximumArguments: 2 }],
    ['balance', { permission: 'essentials.balance', minimumArguments: 0, maximumArguments: 1 }],
    ['message', { permission: 'essentials.message', minimumArguments: 2, maximumArguments: 24 }],
    ['gamemode', { permission: 'minecraft.command.gamemode', minimumArguments: 1, maximumArguments: 2 }],
]);

const COMMAND_ALIASES = new Map([
    ['h', 'home'],
    ['w', 'warp'],
    ['tp', 'teleport'],
    ['bal', 'balance'],
    ['msg', 'message'],
    ['tell', 'message'],
    ['gm', 'gamemode'],
]);

const COMMAND_NAMES = ['home', 'h', 'warp', 'w', 'tp', 'bal', 'msg', 'tell', 'gm', 'unknown'];

const COMMAND_INPUTS = Array.from({ length: COMMAND_OPERATION_COUNT }, (_, index) => createCommandInput(index));

const COMMAND_LOOKUPS = COMMAND_INPUTS.map((input) => {
    const [requestedName = '', ...arguments_] = tokenizeCommand(input);
    return {
        requestedName: requestedName.toLowerCase(),
        argumentCount: arguments_.length,
        argumentLength: arguments_.join('').length,
    };
});

function runCommandRouting(): number {
    let checksum = 0;
    for (let index = 0; index < COMMAND_OPERATION_COUNT; index++) {
        const input = createCommandInput(index);
        const [requestedName = '', ...arguments_] = tokenizeCommand(input);
        const name = COMMAND_ALIASES.get(requestedName.toLowerCase()) ?? requestedName.toLowerCase();
        const route = COMMAND_ROUTES.get(name);
        if (route === undefined) {
            checksum = (checksum + arguments_.length + 1) >>> 0;
            continue;
        }

        if (arguments_.length >= route.minimumArguments && arguments_.length <= route.maximumArguments) {
            checksum = (checksum + route.permission.length + arguments_.join('').length) >>> 0;
        }
    }
    return checksum;
}

function runCommandTokenization(): number {
    let checksum = 0;
    for (const input of COMMAND_INPUTS) {
        const arguments_ = tokenizeCommand(input);
        const first = arguments_[0];
        const last = arguments_[arguments_.length - 1];
        checksum = (checksum + arguments_.length + (first?.length ?? 0) + (last?.length ?? 0)) >>> 0;
    }
    return checksum;
}

function runCommandRouteLookup(): number {
    let checksum = 0;
    for (const command of COMMAND_LOOKUPS) {
        const name = COMMAND_ALIASES.get(command.requestedName) ?? command.requestedName;
        const route = COMMAND_ROUTES.get(name);
        if (route === undefined) {
            checksum = (checksum + command.argumentCount + 1) >>> 0;
            continue;
        }

        if (command.argumentCount >= route.minimumArguments && command.argumentCount <= route.maximumArguments) {
            checksum = (checksum + route.permission.length + command.argumentLength) >>> 0;
        }
    }
    return checksum;
}

function createCommandInput(index: number): string {
    const commandName = COMMAND_NAMES[index % COMMAND_NAMES.length];
    const playerName = `Player${index % 1_800}`;
    return commandName === 'msg' || commandName === 'tell'
        ? `${commandName} ${playerName} "Shop purchase ${index}"`
        : `${commandName} ${playerName}`;
}

function tokenizeCommand(input: string): string[] {
    const arguments_: string[] = [];
    let value = '';
    let quote = '';
    let escaped = false;
    let hasValue = false;

    for (const character of input) {
        if (escaped) {
            value += character;
            escaped = false;
            hasValue = true;
        } else if (character === '\\') {
            escaped = true;
        } else if (quote !== '') {
            if (character === quote) quote = '';
            else value += character;
            hasValue = true;
        } else if (character === '"' || character === "'") {
            quote = character;
            hasValue = true;
        } else if (/\s/.test(character)) {
            if (hasValue) {
                arguments_.push(value);
                value = '';
                hasValue = false;
            }
        } else {
            value += character;
            hasValue = true;
        }
    }

    if (escaped) value += '\\';
    if (hasValue) arguments_.push(value);
    return arguments_;
}
