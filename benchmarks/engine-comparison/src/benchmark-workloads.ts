/** Describes whether a workload uses a guest-side fixture or the real Pumpkin API. */
export type WorkloadProvenance = 'synthetic guest fixture' | 'real Pumpkin API';

/** Timings and deterministic output for one measured workload. */
export interface BenchmarkWorkload {
    /** Human-readable description of the algorithm being measured. */
    area: string;
    /** Deterministic result used to confirm equivalent work across runtimes. */
    checksum: number;
    /** Stable identifier used to compare the same workload across runtimes. */
    name: string;
    /** Input items or requests processed by each timed sample. */
    operationsPerSample: number;
    /** Whether the workload is a guest fixture or uses a real Pumpkin API call. */
    provenance: WorkloadProvenance;
    /** Elapsed time in milliseconds for each measured run, after warm-up. */
    samplesMs: number[];
}

type WorkloadScenario = Pick<BenchmarkWorkload, 'name' | 'area' | 'operationsPerSample'> & {
    run: () => number;
};

/** Number of timed runs for each workload, after one un-timed warm-up. */
const SAMPLE_COUNT = 5;
const STRING_PART_COUNT = 25_000;
const STRING_JOIN_REPEAT_COUNT = 64;
const STRING_REPEAT_COUNT = 4_000;
const STRING_PAD_COUNT = 4_000;
const ARRAY_LOCALE_STRING_COUNT = 8_000;
const STRING_CASE_COUNT = 8_000;
const TYPED_ARRAY_STRING_COUNT = 4_000;
const FROM_CHAR_CODE_COUNT = 8_000;
const STRING_REPLACE_COUNT = 8_000;
const COMMAND_OPERATION_COUNT = 4_000;

const CONFIG_SOURCE = JSON.stringify({
    enabled: true,
    cache: { maxEntries: 512, ttlTicks: 1200 },
    channels: ['status', 'inventory', 'health'],
    aliases: { hp: 'health', inv: 'inventory', st: 'status' },
});

const STRING_PARTS = buildStringParts();
const ARRAY_LOCALE_STRING_VALUES = ['a', 'b', 'c', 'd'].map((value) => value.repeat(64));
const TYPED_ARRAY_JOIN_VALUES = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const TYPED_ARRAY_LOCALE_VALUES = Uint8Array.from({ length: 16 }, (_, index) => index + 1);

const WORKLOADS: readonly WorkloadScenario[] = [
    { name: 'numeric', area: 'Numeric arithmetic baseline', operationsPerSample: 1_000_000, run: runNumeric },
    { name: 'objects', area: 'Object allocation and traversal', operationsPerSample: 50_000, run: runObjects },
    { name: 'strings', area: 'String construction and joining', operationsPerSample: 25_000, run: runStrings },
    {
        name: 'string-construction',
        area: 'String part construction',
        operationsPerSample: STRING_PART_COUNT,
        run: runStringConstruction,
    },
    {
        name: 'string-join',
        area: 'Batched dense ASCII array joining',
        operationsPerSample: STRING_PART_COUNT * STRING_JOIN_REPEAT_COUNT,
        run: runStringJoin,
    },
    {
        name: 'string-radix-integer',
        area: 'Integer radix formatting',
        operationsPerSample: STRING_PART_COUNT,
        run: runStringRadixInteger,
    },
    {
        name: 'string-join-unicode',
        area: 'Unicode join correctness and code-unit behavior',
        operationsPerSample: 7,
        run: runStringJoinUnicode,
    },
    {
        name: 'string-repeat-ascii',
        area: 'Repeated ASCII string construction',
        operationsPerSample: STRING_REPEAT_COUNT,
        run: runStringRepeatASCII,
    },
    {
        name: 'string-pad-ascii',
        area: 'ASCII string padding at both ends',
        operationsPerSample: STRING_PAD_COUNT * 2,
        run: runStringPadASCII,
    },
    {
        name: 'array-to-locale-string-ascii',
        area: 'Locale string conversion for ASCII array elements',
        operationsPerSample: ARRAY_LOCALE_STRING_COUNT * ARRAY_LOCALE_STRING_VALUES.length,
        run: runArrayToLocaleStringASCII,
    },
    {
        name: 'string-case-ascii',
        area: 'ASCII string case conversion',
        operationsPerSample: STRING_CASE_COUNT * 2,
        run: runStringCaseASCII,
    },
    {
        name: 'typed-array-join-ascii',
        area: 'ASCII typed array joining',
        operationsPerSample: TYPED_ARRAY_STRING_COUNT * TYPED_ARRAY_JOIN_VALUES.length,
        run: runTypedArrayJoinASCII,
    },
    {
        name: 'typed-array-locale-ascii',
        area: 'ASCII typed array locale conversion',
        operationsPerSample: TYPED_ARRAY_STRING_COUNT * TYPED_ARRAY_LOCALE_VALUES.length,
        run: runTypedArrayLocaleASCII,
    },
    {
        name: 'string-from-char-code-ascii',
        area: 'ASCII multi-argument character code conversion',
        operationsPerSample: FROM_CHAR_CODE_COUNT,
        run: runStringFromCharCodeASCII,
    },
    {
        name: 'string-replace-ascii',
        area: 'ASCII string replace and replaceAll',
        operationsPerSample: STRING_REPLACE_COUNT * 2,
        run: runStringReplaceASCII,
    },
    {
        name: 'config-validation',
        area: 'Configuration parsing and validation',
        operationsPerSample: 1_000,
        run: runConfigValidation,
    },
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
    {
        name: 'permission-resolution',
        area: 'Permission inheritance and context lookup',
        operationsPerSample: 12_000,
        run: runPermissionResolution,
    },
    { name: 'player-directory', area: 'Player and home lookups', operationsPerSample: 18_000, run: runPlayerDirectory },
    { name: 'event-cache', area: 'Lifecycle cache updates', operationsPerSample: 20_000, run: runEventCache },
    {
        name: 'chat-formatting',
        area: 'Chat template formatting and filtering',
        operationsPerSample: 3_000,
        run: runChatFormatting,
    },
    {
        name: 'scoreboard-rendering',
        area: 'Scoreboard text rendering',
        operationsPerSample: 12_000,
        run: runScoreboardRendering,
    },
    {
        name: 'region-protection',
        area: 'Region containment and access checks',
        operationsPerSample: 20_000,
        run: runRegionProtection,
    },
    {
        name: 'world-edit-plan',
        area: 'Block-edit plan generation',
        operationsPerSample: 55_296,
        run: runWorldEditPlan,
    },
    {
        name: 'economy-transfers',
        area: 'Balance transfer processing',
        operationsPerSample: 12_000,
        run: runEconomyTransfers,
    },
    {
        name: 'inventory-stacking',
        area: 'Inventory stack allocation',
        operationsPerSample: 2_500,
        run: runInventoryStacking,
    },
    {
        name: 'cooldown-rate-limit',
        area: 'Cooldown and rate-limit checks',
        operationsPerSample: 20_000,
        run: runCooldownRateLimit,
    },
    { name: 'tick-scheduler', area: 'Scheduled task processing', operationsPerSample: 6_000, run: runTickScheduler },
    {
        name: 'audit-history',
        area: 'Audit history filtering',
        operationsPerSample: 13_000,
        run: runAuditHistory,
    },
    {
        name: 'player-state-json',
        area: 'Player-state JSON round trip',
        operationsPerSample: 1_200,
        run: runPlayerStatePersistence,
    },
    { name: 'custom-payload', area: 'Custom payload encoding', operationsPerSample: 16_384, run: runPacketEncoding },
];

/** Runs and measures every deterministic plugin-style workload. */
export function measureSyntheticWorkloads(): BenchmarkWorkload[] {
    return WORKLOADS.map(({ name, area, operationsPerSample, run }) =>
        measureWorkload(name, area, 'synthetic guest fixture', operationsPerSample, run),
    );
}

/**
 * Measures one workload after a warm-up run.
 * @param name - Stable workload identifier.
 * @param area - Algorithm represented by the workload.
 * @param provenance - Whether this measures a synthetic fixture or real Pumpkin API behavior.
 * @param operationsPerSample - Number of inputs processed in each timed run.
 * @param run - Runs the workload and returns a deterministic checksum.
 * @returns The timed samples and final checksum.
 */
export function measureWorkload(
    name: string,
    area: string,
    provenance: WorkloadProvenance,
    operationsPerSample: number,
    run: () => number,
): BenchmarkWorkload {
    run();
    let checksum = 0;
    const samplesMs: number[] = [];
    for (let sample = 0; sample < SAMPLE_COUNT; sample++) {
        const startedAt = Date.now();
        checksum = run();
        samplesMs.push(Date.now() - startedAt);
    }
    return { name, area, provenance, operationsPerSample, samplesMs, checksum };
}

function runNumeric(): number {
    let value = 1;
    for (let index = 0; index < 1_000_000; index++) {
        value = (value * 48_271 + index + 1) % 2_147_483_647;
    }
    return value + (Math.imul(0x811c9dc5, 16_777_619) >>> 0);
}

function runObjects(): number {
    const records: { id: number; value: number }[] = [];
    for (let id = 0; id < 50_000; id++) {
        records.push({ id, value: (id * 17) % 97 });
    }

    let total = 0;
    for (const record of records) {
        total = (total + record.id * record.value) >>> 0;
    }
    return total;
}

function runStrings(): number {
    const parts = buildStringParts();
    const joined = parts.join('|');
    return joined.length + joined.charCodeAt(joined.length - 1);
}

function runStringConstruction(): number {
    const parts = buildStringParts();
    const first = parts[0];
    const last = parts[parts.length - 1];
    if (first === undefined || last === undefined) return -1;
    return parts.length + first.length + last.length + first.charCodeAt(0) + last.charCodeAt(last.length - 1);
}

function runStringJoin(): number {
    let checksum = 0;
    for (let repeat = 0; repeat < STRING_JOIN_REPEAT_COUNT; repeat++) {
        const joined = STRING_PARTS.join('|');
        checksum += joined.length + joined.charCodeAt(joined.length - 1);
    }
    return checksum;
}

function runStringRadixInteger(): number {
    let checksum = 0;
    for (let index = 0; index < STRING_PART_COUNT; index++) {
        const text = index.toString(36);
        checksum = (checksum + text.length + text.charCodeAt(text.length - 1)) >>> 0;
    }

    for (const [value, radix, expected] of RADIX_STRING_CASES) {
        if (value.toString(radix) !== expected) return -1;
    }
    return checksum;
}

function runStringJoinUnicode(): number {
    const parts: (string | null | undefined | { toString: () => string })[] = ['before', 'é', '𐐷', undefined, null];
    parts[6] = {
        toString() {
            parts[0] = 'after';
            return 'later';
        },
    };

    const joined = parts.join('·');
    if (joined !== 'before·é·𐐷····later') return -1;
    return joined.length + joined.charCodeAt(joined.length - 1);
}

function runStringRepeatASCII(): number {
    let checksum = 0;
    for (let index = 0; index < STRING_REPEAT_COUNT; index++) {
        const repeated = 'abcd'.repeat(128);
        checksum += repeated.length + repeated.charCodeAt(repeated.length - 1);
    }

    if ('é𐐷'.repeat(2) !== 'é𐐷é𐐷') return -1;
    return checksum;
}

function runStringPadASCII(): number {
    let checksum = 0;
    for (let index = 0; index < STRING_PAD_COUNT; index++) {
        const start = 'item-42'.padStart(256, '._');
        const end = 'item-42'.padEnd(256, '._');
        if (start.length !== 256 || end.length !== 256) return -1;
        checksum += start.length + start.charCodeAt(start.length - 1);
        checksum += end.length + end.charCodeAt(end.length - 1);
    }

    if ('x'.padStart(4, 'é') !== 'éééx') return -1;
    return checksum;
}

function runArrayToLocaleStringASCII(): number {
    let checksum = 0;
    for (let index = 0; index < ARRAY_LOCALE_STRING_COUNT; index++) {
        const converted = ARRAY_LOCALE_STRING_VALUES.toLocaleString();
        if (converted.length !== 259 || converted.slice(0, 2) !== 'aa') return -1;
        checksum += converted.length + converted.charCodeAt(converted.length - 1);
    }

    if (['é', '𐐷'].toLocaleString() !== 'é,𐐷') return -1;
    return checksum;
}

function runStringCaseASCII(): number {
    let checksum = 0;
    for (let index = 0; index < STRING_CASE_COUNT; index++) {
        const lower = 'STATIC HERMES STRING PATH 0123456789'.toLowerCase();
        const upper = 'static hermes string path 0123456789'.toUpperCase();
        if (lower !== 'static hermes string path 0123456789' || upper !== 'STATIC HERMES STRING PATH 0123456789') {
            return -1;
        }
        checksum += lower.length + upper.charCodeAt(0) + upper.charCodeAt(upper.length - 1);
    }

    return checksum;
}

function runTypedArrayJoinASCII(): number {
    let checksum = 0;
    for (let index = 0; index < TYPED_ARRAY_STRING_COUNT; index++) {
        const joined = TYPED_ARRAY_JOIN_VALUES.join('|');
        if (joined.length !== 86 || joined[0] !== '1' || !joined.endsWith('|32')) return -1;
        checksum += joined.length + joined.charCodeAt(joined.length - 1);
    }

    if (new Uint8Array([1, 2, 3]).join('λ') !== '1λ2λ3') return -1;
    return checksum;
}

function runTypedArrayLocaleASCII(): number {
    let checksum = 0;
    const originalToLocaleString = Number.prototype.toLocaleString;
    Number.prototype.toLocaleString = function () {
        return this.toString();
    };
    try {
        for (let index = 0; index < TYPED_ARRAY_STRING_COUNT; index++) {
            const converted = TYPED_ARRAY_LOCALE_VALUES.toLocaleString();
            if (converted !== '1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16') return -1;
            checksum += converted.length + converted.charCodeAt(converted.length - 1);
        }
    } finally {
        Number.prototype.toLocaleString = originalToLocaleString;
    }

    return checksum;
}

function runStringFromCharCodeASCII(): number {
    let checksum = 0;
    for (let index = 0; index < FROM_CHAR_CODE_COUNT; index++) {
        const text = String.fromCharCode(80, 85, 77, 80, 75, 73, 78);
        if (text !== 'PUMPKIN') return -1;
        checksum += text.length + text.charCodeAt(text.length - 1);
    }

    if (String.fromCharCode(65, 128) !== 'A\u0080') return -1;
    return checksum;
}

function runStringReplaceASCII(): number {
    let checksum = 0;
    for (let index = 0; index < STRING_REPLACE_COUNT; index++) {
        const once = 'prefix-fast-path-fast'.replace('fast', 'FAST');
        const all = 'prefix-fast-path-fast'.replaceAll('fast', 'FAST');
        if (once !== 'prefix-FAST-path-fast' || all !== 'prefix-FAST-path-FAST') return -1;
        checksum += once.length + all.length + once.charCodeAt(7) + all.charCodeAt(20);
    }

    if ('AλB'.replace('A', 'X') !== 'XλB') return -1;
    return checksum;
}

const RADIX_STRING_CASES: readonly [number, number, string][] = [
    [0, 36, '0'],
    [35, 36, 'z'],
    [36, 36, '10'],
    [1, 2, '1'],
    [2, 2, '10'],
    [4, 2, '100'],
    [8, 2, '1000'],
    [-35, 36, '-z'],
    [-36, 36, '-10'],
    [-Number.MAX_SAFE_INTEGER, 36, '-2gosa7pa2gv'],
    [Number.MAX_SAFE_INTEGER, 36, '2gosa7pa2gv'],
    [-0, 36, '0'],
    [0.5, 2, '0.1'],
    [10.5, 2, '1010.1'],
    [Number.MAX_SAFE_INTEGER + 1, 36, '2gosa7pa2gw'],
];

function buildStringParts(): string[] {
    const parts = new Array<string>(STRING_PART_COUNT);
    for (let index = 0; index < parts.length; index++) {
        parts[index] = `${index.toString(36)}:${String.fromCharCode(65 + (index % 26))}`;
    }
    return parts;
}

function runConfigValidation(): number {
    let checksum = 0;
    for (let index = 0; index < 1_000; index++) {
        const parsed: unknown = JSON.parse(CONFIG_SOURCE);
        if (
            !isRecord(parsed) ||
            !isRecord(parsed.cache) ||
            !Array.isArray(parsed.channels) ||
            !isRecord(parsed.aliases)
        ) {
            return -1;
        }

        const { cache, channels, aliases } = parsed;
        if (
            parsed.enabled !== true ||
            typeof cache.maxEntries !== 'number' ||
            cache.maxEntries < 1 ||
            typeof cache.ttlTicks !== 'number' ||
            cache.ttlTicks < 1 ||
            channels.some((channel) => typeof channel !== 'string')
        ) {
            return -1;
        }

        const channelNames = new Set(channels as string[]);
        const aliasEntries = Object.entries(aliases);
        if (aliasEntries.some(([, channel]) => typeof channel !== 'string' || !channelNames.has(channel))) return -1;
        checksum += channelNames.size + aliasEntries.length + cache.maxEntries + cache.ttlTicks;
    }
    return checksum;
}

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

interface PermissionGroup {
    contexts: ReadonlyMap<string, boolean>;
    parent?: string;
    permissions: ReadonlyMap<string, boolean>;
}

const PERMISSION_GROUPS = new Map<string, PermissionGroup>([
    [
        'default',
        {
            permissions: new Map([
                ['essentials.home', true],
                ['essentials.balance', true],
                ['worldguard.build', false],
            ]),
            contexts: new Map(),
        },
    ],
    [
        'member',
        {
            parent: 'default',
            permissions: new Map([
                ['essentials.warp', true],
                ['economy.pay', true],
            ]),
            contexts: new Map([['spawn:worldguard.build', true]]),
        },
    ],
    [
        'moderator',
        {
            parent: 'member',
            permissions: new Map([
                ['essentials.teleport', true],
                ['coreprotect.*', true],
            ]),
            contexts: new Map(),
        },
    ],
    [
        'admin',
        {
            parent: 'moderator',
            permissions: new Map([['*', true]]),
            contexts: new Map(),
        },
    ],
]);

const PERMISSION_NODES = [
    'essentials.home',
    'essentials.warp',
    'essentials.teleport',
    'essentials.balance',
    'essentials.message',
    'economy.pay',
    'worldguard.build',
    'worldguard.interact',
    'coreprotect.inspect',
    'minecraft.command.gamemode',
];

const PERMISSION_GROUP_NAMES = ['default', 'member', 'moderator', 'admin'];
const PERMISSION_WORLDS = ['survival', 'spawn', 'creative'];

function runPermissionResolution(): number {
    let checksum = 0;
    for (let index = 0; index < 12_000; index++) {
        const group = PERMISSION_GROUP_NAMES[index % PERMISSION_GROUP_NAMES.length];
        const permission = PERMISSION_NODES[index % PERMISSION_NODES.length];
        const world = PERMISSION_WORLDS[index % PERMISSION_WORLDS.length];
        if (hasPermission(group, permission, world)) checksum += permission.length + (index % 17);
    }
    return checksum;
}

function hasPermission(groupName: string, permission: string, world: string): boolean {
    let group = PERMISSION_GROUPS.get(groupName);
    while (group !== undefined) {
        const contextualPermission = group.contexts.get(`${world}:${permission}`);
        if (contextualPermission !== undefined) return contextualPermission;

        const exactPermission = group.permissions.get(permission);
        if (exactPermission !== undefined) return exactPermission;

        for (
            let separator = permission.lastIndexOf('.');
            separator >= 0;
            separator = permission.lastIndexOf('.', separator - 1)
        ) {
            const wildcardPermission = group.permissions.get(`${permission.slice(0, separator)}.*`);
            if (wildcardPermission !== undefined) return wildcardPermission;
        }

        const globalPermission = group.permissions.get('*');
        if (globalPermission !== undefined) return globalPermission;
        group = group.parent === undefined ? undefined : PERMISSION_GROUPS.get(group.parent);
    }
    return false;
}

interface PlayerProfile {
    balance: number;
    homes: readonly string[];
    name: string;
    uuid: string;
    world: string;
}

function runPlayerDirectory(): number {
    const byUuid = new Map<string, PlayerProfile>();
    const byName = new Map<string, PlayerProfile>();
    for (let id = 0; id < 6_000; id++) {
        const hexadecimalId = id.toString(16);
        const profile: PlayerProfile = {
            uuid: `00000000-0000-4000-8000-${'000000000000'.slice(hexadecimalId.length)}${hexadecimalId}`,
            name: `Player${id}`,
            world: PERMISSION_WORLDS[id % PERMISSION_WORLDS.length],
            balance: 1_000 + ((id * 97) % 90_000),
            homes: id % 3 === 0 ? ['home', 'farm'] : ['home'],
        };
        byUuid.set(profile.uuid, profile);
        byName.set(profile.name.toLowerCase(), profile);
    }

    let checksum = 0;
    for (let lookup = 0; lookup < 12_000; lookup++) {
        const id = lookup % 6_000;
        const profile =
            lookup % 2 === 0
                ? byName.get(`player${id}`)
                : byUuid.get(
                      `00000000-0000-4000-8000-${'000000000000'.slice(id.toString(16).length)}${id.toString(16)}`,
                  );
        if (profile !== undefined) checksum += profile.balance + profile.name.length + profile.homes.length;
    }
    return checksum;
}

function runEventCache(): number {
    const cache = new Map<string, { food: number; lastTick: number }>();
    for (let tick = 0; tick < 20_000; tick++) {
        const playerId = `player-${tick % 2_000}`;
        const current = cache.get(playerId);
        cache.set(playerId, { food: current ? (current.food + 1) % 21 : tick % 21, lastTick: tick });
        if (tick % 1_000 === 999) {
            for (const [id, entry] of cache) {
                if (tick - entry.lastTick > 1_000) cache.delete(id);
            }
        }
    }
    let checksum = 0;
    for (const [id, entry] of cache) checksum += id.length + entry.food + entry.lastTick;
    return checksum;
}

const CHAT_TEMPLATES = [
    '&a%player%&7: Hello from %world%',
    '&b%player%&7 paid %balance% coins for a shop item',
    '&c%player%&7 shared a fake scamlink in %world%',
];
const CHAT_FILTERS = ['badword', 'scamlink', 'discord.gg/fake'];

function runChatFormatting(): number {
    let checksum = 0;
    for (let index = 0; index < 3_000; index++) {
        const player = `Player${index % 1_500}`;
        const world = PERMISSION_WORLDS[index % PERMISSION_WORLDS.length];
        const balance = (index * 83) % 100_000;
        const rawMessage = CHAT_TEMPLATES[index % CHAT_TEMPLATES.length]
            .replace(/%player%/g, player)
            .replace(/%world%/g, world)
            .replace(/%balance%/g, balance.toString());
        const normalizedMessage = rawMessage.toLowerCase();
        const blocked = CHAT_FILTERS.some((term) => normalizedMessage.includes(term));
        const formattedMessage = rawMessage.replace(/&([0-9a-fk-or])/gi, '§$1');
        checksum += formattedMessage.length + (blocked ? 1 : 0);
    }
    return checksum;
}

function runScoreboardRendering(): number {
    const lines = ['&6%player%', '&7World: &f%world%', '&7Balance: &a$%balance%', '&7Online: &f%online%'];
    let checksum = 0;
    for (let playerId = 0; playerId < 3_000; playerId++) {
        const playerName = `Player${playerId}`;
        const world = PERMISSION_WORLDS[playerId % PERMISSION_WORLDS.length];
        const balance = ((playerId * 97) % 100_000).toString();
        for (const line of lines) {
            const rendered = line
                .replace(/%player%/g, playerName)
                .replace(/%world%/g, world)
                .replace(/%balance%/g, balance)
                .replace(/%online%/g, '3000')
                .replace(/&([0-9a-fk-or])/gi, '§$1');
            checksum += rendered.length;
        }
    }
    return checksum;
}

interface ProtectedRegion {
    allowPublicPlace: boolean;
    maximumX: number;
    maximumZ: number;
    minimumX: number;
    minimumZ: number;
    ownerId: number;
    trustedPlayers: ReadonlySet<number>;
    world: string;
}

function runRegionProtection(): number {
    const regionsByChunk = new Map<string, ProtectedRegion[]>();
    for (let worldIndex = 0; worldIndex < PERMISSION_WORLDS.length; worldIndex++) {
        const world = PERMISSION_WORLDS[worldIndex];
        for (let column = 0; column < 8; column++) {
            for (let row = 0; row < 4; row++) {
                const region: ProtectedRegion = {
                    world,
                    minimumX: -512 + column * 128,
                    maximumX: -449 + column * 128,
                    minimumZ: -256 + row * 128,
                    maximumZ: -193 + row * 128,
                    ownerId: (column * 11 + row * 7 + worldIndex) % 4_096,
                    trustedPlayers: new Set([(column * 17 + row * 13) % 4_096]),
                    allowPublicPlace: (column + row) % 5 === 0,
                };
                addRegionToChunkIndex(regionsByChunk, region);
            }
        }
    }

    let checksum = 0;
    for (let event = 0; event < 20_000; event++) {
        const world = PERMISSION_WORLDS[event % PERMISSION_WORLDS.length];
        const x = ((event * 73) % 1_024) - 512;
        const z = ((event * 43) % 1_024) - 512;
        const playerId = (event * 19) % 4_096;
        const action = event % 2 === 0 ? 'break' : 'place';
        const candidates = regionsByChunk.get(`${world}:${x >> 4}:${z >> 4}`) ?? [];
        let allowed = true;

        for (const region of candidates) {
            if (x < region.minimumX || x > region.maximumX || z < region.minimumZ || z > region.maximumZ) continue;
            allowed =
                playerId === region.ownerId ||
                region.trustedPlayers.has(playerId) ||
                (action === 'place' && region.allowPublicPlace);
            break;
        }
        checksum = (checksum + (allowed ? 1 : 0) + candidates.length) >>> 0;
    }
    return checksum;
}

function addRegionToChunkIndex(index: Map<string, ProtectedRegion[]>, region: ProtectedRegion): void {
    for (let chunkX = region.minimumX >> 4; chunkX <= region.maximumX >> 4; chunkX++) {
        for (let chunkZ = region.minimumZ >> 4; chunkZ <= region.maximumZ >> 4; chunkZ++) {
            const key = `${region.world}:${chunkX}:${chunkZ}`;
            const regions = index.get(key) ?? [];
            regions.push(region);
            index.set(key, regions);
        }
    }
}

interface BlockChange {
    after: number;
    before: number;
    x: number;
    y: number;
    z: number;
}

function runWorldEditPlan(): number {
    const changes: BlockChange[] = [];
    const palette = [1, 2, 3, 4, 5, 6, 7, 8];
    for (let x = 0; x < 48; x++) {
        for (let y = 0; y < 24; y++) {
            for (let z = 0; z < 48; z++) {
                const offsetX = x - 24;
                const offsetY = y - 12;
                const offsetZ = z - 24;
                if (offsetX * offsetX + offsetY * offsetY + offsetZ * offsetZ > 24 * 24) continue;

                const before = (x * 31 + y * 17 + z * 13) % 9;
                if (before === 0 || (x + z) % 5 === 0) continue;
                const after = palette[(x + y + z) % palette.length];
                if (before !== after) changes.push({ x, y, z, before, after });
            }
        }
    }

    let checksum = changes.length;
    for (const change of changes) {
        checksum = (checksum + change.x * 3 + change.y * 5 + change.z * 7 + change.before + change.after) >>> 0;
    }
    return checksum;
}

function runEconomyTransfers(): number {
    const balances = new Map<number, number>();
    for (let playerId = 0; playerId < 4_000; playerId++) balances.set(playerId, 50_000 + playerId * 5);

    const transactions: [number, number, number][] = [];
    for (let transactionId = 0; transactionId < 12_000; transactionId++) {
        const senderId = transactionId % 4_000;
        const recipientId = (transactionId * 17 + 29) % 4_000;
        const amount = ((transactionId * 97) % 350) + 1;
        const senderBalance = balances.get(senderId) ?? 0;
        if (senderBalance < amount || senderId === recipientId) continue;

        balances.set(senderId, senderBalance - amount);
        balances.set(recipientId, (balances.get(recipientId) ?? 0) + amount);
        transactions.push([senderId, recipientId, amount]);
    }

    let checksum = transactions.length;
    for (const [senderId, recipientId, amount] of transactions) {
        checksum += senderId + recipientId + amount;
    }
    for (const [playerId, balance] of balances) checksum += (playerId + 1) * balance;
    return checksum;
}

interface ItemStack {
    count: number;
    itemId: string;
}

function runInventoryStacking(): number {
    const inventory = new Array<ItemStack | undefined>(36).fill(undefined);
    for (let slot = 0; slot < 24; slot++)
        inventory[slot] = { itemId: `minecraft:item${slot % 48}`, count: 32 + (slot % 32) };

    let itemsAdded = 0;
    for (let grant = 0; grant < 2_500; grant++) {
        const itemId = `minecraft:item${grant % 48}`;
        const count = ((grant * 13) % 96) + 1;
        itemsAdded += addToInventory(inventory, itemId, count);
    }

    let checksum = itemsAdded;
    for (let slot = 0; slot < inventory.length; slot++) {
        const stack = inventory[slot];
        if (stack !== undefined) checksum += (slot + 1) * stack.count + stack.itemId.length;
    }
    return checksum;
}

function addToInventory(inventory: Array<ItemStack | undefined>, itemId: string, count: number): number {
    let remaining = count;
    for (const stack of inventory) {
        if (stack?.itemId !== itemId || stack.count === 64) continue;
        const moved = Math.min(64 - stack.count, remaining);
        stack.count += moved;
        remaining -= moved;
        if (remaining === 0) return count;
    }

    while (remaining > 0) {
        const emptySlot = inventory.indexOf(undefined);
        if (emptySlot === -1) break;
        const moved = Math.min(64, remaining);
        inventory[emptySlot] = { itemId, count: moved };
        remaining -= moved;
    }
    return count - remaining;
}

function runCooldownRateLimit(): number {
    const lastAllowedTick = new Map<string, number>();
    const commandNames = ['home', 'warp', 'message', 'pay'];
    let allowed = 0;
    let blocked = 0;

    for (let attempt = 0; attempt < 20_000; attempt++) {
        const playerId = attempt % 64;
        const command = commandNames[Math.floor(attempt / 64) % commandNames.length];
        const tick = Math.floor(attempt / 4);
        const key = `${playerId}:${command}`;
        const previousTick = lastAllowedTick.get(key);
        if (previousTick === undefined || tick - previousTick >= 100) {
            lastAllowedTick.set(key, tick);
            allowed++;
        } else {
            blocked++;
        }
    }
    return allowed * 31 + blocked;
}

interface ScheduledTask {
    id: number;
    repeatEveryTicks: number;
}

function runTickScheduler(): number {
    const tasksByTick: ScheduledTask[][] = Array.from({ length: 1_200 }, () => []);
    for (let taskId = 0; taskId < 6_000; taskId++) {
        const dueTick = (taskId * 37) % 600;
        tasksByTick[dueTick].push({ id: taskId, repeatEveryTicks: taskId % 4 === 0 ? 20 + (taskId % 60) : 0 });
    }

    let callbacks = 0;
    let checksum = 0;
    for (let tick = 0; tick < tasksByTick.length; tick++) {
        for (const task of tasksByTick[tick]) {
            callbacks++;
            checksum = (checksum + task.id * (tick + 1)) >>> 0;
            const nextTick = tick + task.repeatEveryTicks;
            if (task.repeatEveryTicks > 0 && nextTick < tasksByTick.length) tasksByTick[nextTick].push(task);
        }
    }
    return checksum + callbacks;
}

interface AuditRecord {
    action: string;
    tick: number;
    world: string;
    x: number;
    z: number;
}

function runAuditHistory(): number {
    const eventsByPlayer = new Map<number, AuditRecord[]>();
    for (let eventId = 0; eventId < 12_000; eventId++) {
        const playerId = eventId % 2_048;
        const records = eventsByPlayer.get(playerId) ?? [];
        records.push({
            tick: eventId * 2,
            world: PERMISSION_WORLDS[eventId % PERMISSION_WORLDS.length],
            x: ((eventId * 31) % 2_000) - 1_000,
            z: ((eventId * 47) % 2_000) - 1_000,
            action: eventId % 2 === 0 ? 'block-break' : 'block-place',
        });
        eventsByPlayer.set(playerId, records);
    }

    let checksum = 0;
    for (let query = 0; query < 1_000; query++) {
        const playerId = query % 2_048;
        const minimumTick = query * 8;
        const maximumTick = minimumTick + 4_000;
        const world = PERMISSION_WORLDS[query % PERMISSION_WORLDS.length];
        for (const event of eventsByPlayer.get(playerId) ?? []) {
            if (
                event.tick >= minimumTick &&
                event.tick <= maximumTick &&
                event.world === world &&
                Math.abs(event.x) < 800 &&
                Math.abs(event.z) < 800
            ) {
                checksum += event.tick + event.action.length + event.x + event.z;
            }
        }
    }
    return checksum;
}

interface StoredPlayerState {
    balanceCents: number;
    homes: { name: string; world: string; x: number; y: number; z: number }[];
    name: string;
    preferences: { chat: boolean; privateMessages: boolean; scoreboard: boolean };
    uuid: string;
}

function runPlayerStatePersistence(): number {
    const players: StoredPlayerState[] = [];
    for (let playerId = 0; playerId < 1_200; playerId++) {
        players.push({
            uuid: `player-${playerId.toString(16)}`,
            name: `Player${playerId}`,
            balanceCents: playerId * 193,
            homes: [
                {
                    name: 'home',
                    world: PERMISSION_WORLDS[playerId % PERMISSION_WORLDS.length],
                    x: playerId,
                    y: 64,
                    z: -playerId,
                },
                { name: 'farm', world: 'survival', x: playerId * 2, y: 70, z: playerId * 3 },
            ],
            preferences: {
                chat: playerId % 5 !== 0,
                privateMessages: playerId % 7 !== 0,
                scoreboard: playerId % 3 !== 0,
            },
        });
    }

    const serialized = JSON.stringify({ schemaVersion: 2, players });
    const restored: unknown = JSON.parse(serialized);
    if (!isRecord(restored) || restored.schemaVersion !== 2 || !Array.isArray(restored.players)) return -1;

    let checksum = serialized.length;
    for (const player of restored.players as StoredPlayerState[]) {
        checksum += player.balanceCents + player.homes.length + player.name.length;
    }
    return checksum;
}

function runPacketEncoding(): number {
    const payload = new Uint8Array(256);
    const view = new DataView(payload.buffer);
    let checksum = 0;
    for (let packet = 0; packet < 256; packet++) {
        for (let field = 0; field < 64; field++) {
            view.setUint32(field * 4, (packet * 0x9e3779b1 + field) >>> 0, false);
        }
        for (let field = 0; field < 64; field++) checksum = (checksum + view.getUint32(field * 4, false)) >>> 0;
    }
    return checksum;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
