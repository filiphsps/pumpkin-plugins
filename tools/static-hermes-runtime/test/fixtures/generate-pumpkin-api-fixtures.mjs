import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestWitDirectory, ensurePumpkinWit, parsePumpkinWitPin } from '@pumpkin-plugins/pumpkin-api/wit';
import {
    archiveCompatibilityMatrix,
    diffCompatibilityMatrices,
    hasSameWitRevision,
    reconcileCompatibilityMatrix,
} from '../../../pumpkin-api/src/compatibility-audit.ts';
import {
    COMPATIBILITY_SCHEMA_URL,
    validateCompatibilityMatrix,
} from '../../../pumpkin-api/src/compatibility-schema.ts';
import { PUMPKIN_RELEASE } from '../../../test-harness/src/pumpkin-version.ts';
import { readWitPackage } from '../oracles/wit-api.mjs';

const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repositoryRoot = path.resolve(runtimeRoot, '../..');
const apiRoot = path.join(repositoryRoot, 'tools/pumpkin-api');
const compatibilityDirectory = path.join(apiRoot, 'compatibility');
const compatibilityPath = path.join(compatibilityDirectory, 'v0.1.1.json');
const previousMatrix = fs.existsSync(compatibilityPath)
    ? JSON.parse(fs.readFileSync(compatibilityPath, 'utf8'))
    : undefined;
if (previousMatrix) validateCompatibilityMatrix(previousMatrix, compatibilityPath);
const witLockFile = path.join(apiRoot, 'wit.lock.json');
const sourceWit = parsePumpkinWitPin(fs.readFileSync(witLockFile, 'utf8'), witLockFile);
const apiWitDir = ensurePumpkinWit({
    lockFile: witLockFile,
    cacheRoot: process.env.PUMPKIN_PLUGINS_CACHE_DIR || path.join(repositoryRoot, '.cache'),
});
const api = readWitPackage(apiWitDir);

if (api.packageName !== 'pumpkin:plugin') {
    throw new Error(`Expected the pumpkin:plugin WIT package, got ${api.packageName}@${api.version}`);
}

const actualWitDigest = digestWitDirectory(apiWitDir);
const apiPackage = JSON.parse(fs.readFileSync(path.join(apiRoot, 'package.json'), 'utf8'));

const runtimeExports = [
    'Plugin',
    'registerPlugin',
    'initPlugin',
    'onLoad',
    'onUnload',
    'handleEvent',
    'handleCommand',
    'handleCommandSuggestion',
    'handleTask',
    'handleIpcMessage',
    'handleAiGoalCanStart',
    'handleAiGoalShouldContinue',
    'handleAiGoalStart',
    'handleAiGoalTick',
    'handleAiGoalStop',
    'handleGeneratePhase',
    'metadata',
    'common',
].map((name) => {
    const behaviorChange = {
        Plugin: {
            migration:
                'Event handlers passed to registerEvent are now checked against the payload of the registered event type, so a handler typed for another payload needs a matching annotation. The default IPC handler now throws a descriptive Error instead of a string, failed event/command registration releases its callback, scheduled task helpers reject runtime tick values other than numbers or bigints, and the new cancelTask helper releases a scheduled callback.',
        },
        handleCommandSuggestion: {
            migration:
                'No call-site change. Missing-handler errors now print the requested handler ID instead of `undefined`.',
        },
        handleIpcMessage: {
            migration:
                "No call-site change. Calling before a plugin is registered now throws `Error('Cannot handle IPC messages before a plugin is registered')` instead of `Error('No plugin instance available?')`.",
        },
        onUnload: {
            migration:
                'No call-site change. Event, command, suggestion, AI-goal, chunk-generator and scheduled-task callbacks are released after unload, even when the plugin hook throws. The old package released none of them.',
        },
        metadata: {
            migration:
                'No call-site change for plugins that call registerPlugin(). getMetadata now throws when registerPlugin() was not called, so Pumpkin rejects the plugin instead of loading it as `unknown`.',
        },
    }[name];

    return {
        name,
        decision: behaviorChange ? 'improved' : 'retained',
        migration:
            behaviorChange?.migration ?? 'No call-site change; the runtime export name and signature are retained.',
    };
});

const publicTypes = [
    'EventHandler',
    'EventPayload',
    'CommandHandler',
    'CommandSuggestionHandler',
    'TaskHandler',
    'AiGoal',
    'ChunkGenerator',
].map(
    (name) =>
        ({
            EventHandler: {
                name,
                decision: 'improved',
                migration:
                    "The default payload type is now the union of event payloads instead of `any`, and the return type is `T | undefined` instead of `T | void`. Give handlers that relied on `any` a payload type such as `EventPayload<'player-join-event'>`, and remove `: void` return annotations from event handlers.",
            },
            EventPayload: {
                name,
                decision: 'added',
                migration: 'New type; existing code does not change. Use it to name the payload of one event type.',
            },
        })[name] ?? {
            name,
            decision: 'retained',
            migration: 'No call-site change; the public TypeScript signature is retained.',
        },
);

const interfaces = api.interfaces.map((apiInterface) => {
    const types = [
        ...apiInterface.records.map((declaration) => typeDeclaration(declaration, 'record')),
        ...apiInterface.variants.map((declaration) => typeDeclaration(declaration, 'variant')),
        ...apiInterface.enums.map((declaration) => typeDeclaration(declaration, 'enum')),
        ...apiInterface.flags.map((declaration) => typeDeclaration(declaration, 'flags')),
        ...apiInterface.types.map((declaration) => typeDeclaration(declaration, 'type')),
    ]
        .map((declaration) => ({
            ...declaration,
            decision: 'review-required',
            migration: '',
        }))
        .sort((left, right) => left.name.localeCompare(right.name) || left.kind.localeCompare(right.kind));

    const operations = operationsForInterface(apiInterface).map(({ operation, operationId, _resource, kind }) => ({
        id: operationId,
        kind,
        signature: `${operationId}(${operation.parameters.map(({ name, type }) => `${name}: ${type}`).join(', ')}) -> ${operation.result || 'unit'}`,
        features: operation.features ?? [],
        decision: 'review-required',
        migration: '',
    }));

    return {
        name: apiInterface.name,
        specifier: apiInterface.specifier,
        decision: 'review-required',
        migration: '',
        types,
        operations,
    };
});

const operationRows = api.interfaces.flatMap((apiInterface) =>
    operationsForInterface(apiInterface).map(({ operation, operationId, kind }) => ({
        operationId,
        kind,
        signature: `${operationId}(${operation.parameters
            .map(({ name, type }) => `${name}: ${type}`)
            .join(', ')}) -> ${operation.result || 'unit'}`,
        features: operation.features ?? [],
    })),
);

const candidateMatrix = {
    $schema: COMPATIBILITY_SCHEMA_URL,
    baseline: {
        ...(previousMatrix?.baseline ?? {
            package: '@pumpkinmc/pumpkin-api-ts',
            version: '0.1.1',
            archive:
                'https://github.com/Pumpkin-MC/pumpkin-api-ts/releases/download/v0.1.1/pumpkinmc-pumpkin-api-ts-0.1.1.tgz',
            integrity:
                'sha512-FpJjXx05AvLQGVguOnWN6wPfb0mZVfRNiWxYHgiaIYFRQoiRyhqsqemriWsBBmlUlpMqihhd4uJJLpye7rMlpQ==',
            license: 'MIT OR Apache-2.0',
        }),
        pumpkinRelease: PUMPKIN_RELEASE,
    },
    replacement: {
        package: apiPackage.name,
        version: apiPackage.version,
        witPackage: `${api.packageName}@${api.version}`,
        license: apiPackage.license,
    },
    sourceWit,
    sourceWitSha256: actualWitDigest,
    defaultExport: previousMatrix?.defaultExport ?? false,
    runtimeExports,
    publicTypes,
    inventory: {
        interfaces: interfaces.length,
        types: interfaces.reduce((sum, apiInterface) => sum + apiInterface.types.length, 0),
        operations: interfaces.reduce((sum, apiInterface) => sum + apiInterface.operations.length, 0),
    },
    interfaces,
    deviations: previousMatrix?.deviations ?? [
        {
            item: 'handleCommandSuggestion missing-handler diagnostic',
            decision: 'improved',
            rationale:
                'The old implementation interpolated the undefined callback variable instead of the supplied handler ID.',
            migration: 'No source migration. Update tests that asserted the old malformed diagnostic.',
        },
        {
            item: 'Plugin.handleIpcMessage default rejection',
            decision: 'improved',
            rationale:
                'The default implementation now rejects with an Error and a descriptive message instead of throwing a string.',
            migration:
                'No source migration for plugins that override the handler. Update tests that asserted the old thrown string or message.',
        },
        {
            item: 'handleIpcMessage before plugin registration',
            decision: 'improved',
            rationale:
                'The exported handler now reports that registration is required instead of using a vague error message.',
            migration: 'No source migration. Update tests that asserted the old pre-registration error message.',
        },
        {
            item: 'callback cleanup after unload',
            decision: 'improved',
            rationale:
                'Unload now releases event, command, suggestion, AI-goal, chunk-generator and scheduled-task callbacks in a finally block, including when the plugin hook throws.',
            migration: 'No source migration. Register callbacks again during a later onLoad.',
        },
        {
            item: 'callback cleanup after failed registration',
            decision: 'improved',
            rationale:
                'Event and command callback registrations are removed from the dispatch registry when host registration fails.',
            migration: 'No source migration. The original registration error is rethrown.',
        },
        {
            item: 'runtime scheduled-task tick validation',
            decision: 'improved',
            rationale:
                'Scheduling helpers reject non-number and non-bigint runtime values before coercion, while preserving the declared tick range checks.',
            migration:
                'JavaScript callers must pass a number or bigint. TypeScript callers using the declared parameter types need no source migration.',
        },
        {
            item: 'typed event handlers',
            decision: 'improved',
            rationale:
                'registerEvent infers the handler payload from the event type, EventHandler defaults to the union of event payloads instead of `any`, and handlers return `T | undefined` instead of `T | void`.',
            migration:
                'Annotate handlers that relied on `any` with `EventPayload<...>` or let registerEvent infer the payload, and remove `: void` return annotations from event handlers.',
        },
        {
            item: 'Plugin.cancelTask',
            decision: 'added',
            rationale:
                'Plugins can cancel a task scheduled through the facade and release its callback at once; the old package had no cancellation helper.',
            migration:
                'No source migration. Call this.cancelTask instead of the raw scheduler to release the callback when the task is cancelled.',
        },
        {
            item: 'metadata before plugin registration',
            decision: 'improved',
            rationale:
                'getMetadata throws when registerPlugin() was not called, as the Rust guest does, instead of returning metadata for a plugin named `unknown`.',
            migration: 'Call registerPlugin() in the plugin entry point. Plugins that already do need no change.',
        },
    ],
};

const sameRevision =
    previousMatrix?.baseline?.pumpkinRelease === PUMPKIN_RELEASE &&
    hasSameWitRevision(previousMatrix, { sourceWit, sourceWitSha256: actualWitDigest });
const sourceChanges = previousMatrix && !sameRevision ? diffCompatibilityMatrices(previousMatrix, candidateMatrix) : [];
const compatibilityMatrix = reconcileCompatibilityMatrix(previousMatrix, candidateMatrix, sourceChanges, sameRevision);
validateCompatibilityMatrix(compatibilityMatrix, compatibilityPath);

if (previousMatrix && !sameRevision) archiveCompatibilityMatrix(compatibilityDirectory, previousMatrix);

const operationInventory = {
    apiPackage: compatibilityMatrix.replacement.package,
    witPackage: compatibilityMatrix.replacement.witPackage,
    sourceWit: compatibilityMatrix.sourceWit,
    sourceWitSha256: compatibilityMatrix.sourceWitSha256,
    pumpkinRelease: compatibilityMatrix.baseline.pumpkinRelease,
    operationCount: operationRows.length,
    operations: operationRows,
};

writeJson(compatibilityPath, compatibilityMatrix);
writeJson(path.join(runtimeRoot, 'test/fixtures/pumpkin-api-operation-inventory.json'), operationInventory);

function operationsForInterface(apiInterface) {
    return [
        ...apiInterface.functions.map((operation) => ({
            operation,
            operationId: `${apiInterface.name}.${operation.name}`,
            kind: 'function',
        })),
        ...apiInterface.resources.flatMap((resource) =>
            resource.functions.map((operation) => ({
                operation,
                resource,
                operationId: `${apiInterface.name}.${resource.name}.${operation.name}`,
                kind:
                    operation.name === 'constructor'
                        ? 'resource-constructor'
                        : operation.isStatic
                          ? 'resource-static-method'
                          : 'resource-method',
            })),
        ),
    ];
}

function typeDeclaration(declaration, kind) {
    const { name, ...shape } = declaration;
    return { name, kind, signature: JSON.stringify(shape) };
}

function writeJson(filename, value) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, `${JSON.stringify(value, null, 4)}\n`);
}
