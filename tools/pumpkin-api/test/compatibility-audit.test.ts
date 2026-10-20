import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
    archiveCompatibilityMatrix,
    type CompatibilityMatrix,
    type CompatibilityOperation,
    type CompatibilityType,
    diffCompatibilityMatrices,
    hasSameWitRevision,
    reconcileCompatibilityMatrix,
} from '../src/compatibility-audit.ts';

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

it('reports same-release WIT additions, removals, and signature changes as explicit review items', () => {
    const previous = compatibilityMatrix([
        { id: 'world.read', kind: 'function', signature: 'world.read() -> u32' },
        { id: 'world.delete', kind: 'function', signature: 'world.delete() -> unit' },
    ]);
    const current = compatibilityMatrix([
        { id: 'world.read', kind: 'function', signature: 'world.read() -> u64' },
        { id: 'world.create', kind: 'function', signature: 'world.create() -> unit' },
    ]);
    previous.interfaces[0].types = [recordType('{"fields":[{"name":"x","type":"u32"}]}')];
    current.interfaces[0].types = [recordType('{"fields":[{"name":"x","type":"u64"}]}')];

    const changes = diffCompatibilityMatrices(previous, current);

    expect(changes).toEqual([
        {
            id: 'operation:world.create',
            change: 'added',
            previousSignature: null,
            currentSignature: 'function:world.create() -> unit:[]',
            impact: 'additive',
            decision: 'review-required',
            migration: '',
        },
        {
            id: 'operation:world.delete',
            change: 'removed',
            previousSignature: 'function:world.delete() -> unit:[]',
            currentSignature: null,
            impact: 'breaking',
            decision: 'review-required',
            migration: '',
        },
        {
            id: 'operation:world.read',
            change: 'changed',
            previousSignature: 'function:world.read() -> u32:[]',
            currentSignature: 'function:world.read() -> u64:[]',
            impact: 'breaking',
            decision: 'review-required',
            migration: '',
        },
        {
            id: 'type:world.position',
            change: 'changed',
            previousSignature: 'record:{"fields":[{"name":"x","type":"u32"}]}',
            currentSignature: 'record:{"fields":[{"name":"x","type":"u64"}]}',
            impact: 'breaking',
            decision: 'review-required',
            migration: '',
        },
    ]);
});

it('preserves reviewed decisions for unchanged items and requires review for changed items', () => {
    const previous = compatibilityMatrix([
        {
            id: 'world.read',
            kind: 'function',
            signature: 'world.read() -> u32',
            decision: 'improved',
            migration: 'Existing note.',
        },
    ]);
    const candidate = compatibilityMatrix([
        { id: 'world.read', kind: 'function', signature: 'world.read() -> u64' },
        { id: 'world.create', kind: 'function', signature: 'world.create() -> unit' },
    ]);
    const changes = diffCompatibilityMatrices(previous, candidate);

    const updated = reconcileCompatibilityMatrix(previous, candidate, changes, false);

    expect(updated.interfaces[0].operations).toEqual([
        {
            id: 'world.read',
            kind: 'function',
            signature: 'world.read() -> u64',
            features: [],
            decision: 'review-required',
            migration: '',
        },
        {
            id: 'world.create',
            kind: 'function',
            signature: 'world.create() -> unit',
            features: [],
            decision: 'review-required',
            migration: '',
        },
    ]);
    expect(updated.sourceChanges).toEqual(changes);
});

it('keeps reviewed revision notes when regenerating the same WIT audit', () => {
    const previous = compatibilityMatrix([
        { id: 'world.create', kind: 'function', signature: 'world.create() -> unit' },
    ]);
    firstOperation(previous).migration = 'Existing note.';
    previous.sourceChanges = [
        {
            id: 'operation:world.create',
            change: 'added',
            previousSignature: null,
            currentSignature: 'function:world.create() -> unit:[]',
            impact: 'additive',
            decision: 'added',
            migration: 'New operation; existing call sites do not change.',
        },
    ];
    const candidate = compatibilityMatrix([
        { id: 'world.create', kind: 'function', signature: 'world.create() -> unit' },
    ]);

    const updated = reconcileCompatibilityMatrix(previous, candidate, [], true);

    expect(updated.sourceChanges).toEqual(previous.sourceChanges);
    expect(firstOperation(updated)).toMatchObject({
        decision: 'retained',
        migration: 'Existing note.',
    });
});

it('treats repository, branch, subdirectory, commit, and content digest as WIT revision provenance', () => {
    const matrix = compatibilityMatrix([]);
    const samePin = {
        sourceWit: matrix.sourceWit,
        sourceWitSha256: matrix.sourceWitSha256,
    };

    expect(hasSameWitRevision(matrix, samePin)).toBe(true);
    expect(
        hasSameWitRevision(matrix, {
            ...samePin,
            sourceWit: { ...samePin.sourceWit, repository: 'https://example.com/other.git' },
        }),
    ).toBe(false);
    expect(
        hasSameWitRevision(matrix, {
            ...samePin,
            sourceWit: { ...samePin.sourceWit, branch: 'release' },
        }),
    ).toBe(false);
    expect(
        hasSameWitRevision(matrix, {
            ...samePin,
            sourceWit: { ...samePin.sourceWit, subdirectory: 'v0.2' },
        }),
    ).toBe(false);
    expect(
        hasSameWitRevision(matrix, {
            ...samePin,
            sourceWit: { ...samePin.sourceWit, commit: '5d7a501943bb99f0f02a339128833f58ed37d0cc' },
        }),
    ).toBe(false);
    expect(hasSameWitRevision(matrix, { ...samePin, sourceWitSha256: '2'.repeat(64) })).toBe(false);
});

it('archives each release and WIT revision without overwriting a different audit', () => {
    const matrix = compatibilityMatrix([]);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pumpkin-compatibility-history-'));
    temporaryDirectories.push(directory);

    const archivePath = archiveCompatibilityMatrix(directory, matrix);

    expect(path.relative(directory, archivePath)).toBe(
        'history/0.2.0+26.3-26.51/v0.1/4d7a501943bb99f0f02a339128833f58ed37d0cc-111dab16b0475551f23422d5bf734b7900f3030a0f8b33cefde70af10f3ea825.json',
    );
    const archiveContents = fs.readFileSync(archivePath, 'utf8');
    const archivedMatrix = JSON.parse(archiveContents);
    expect(archivedMatrix.$schema).toBe(
        'https://raw.githubusercontent.com/filiphsps/pumpkin-plugins/master/tools/pumpkin-api/schemas/pumpkin-api-compatibility.schema.json',
    );
    expect(archivedMatrix.sourceWit.subdirectory).toBe('v0.1');
    expect(archiveCompatibilityMatrix(directory, matrix)).toBe(archivePath);
    expect(fs.readFileSync(archivePath, 'utf8')).toBe(archiveContents);

    expect(() => archiveCompatibilityMatrix(directory, { ...matrix, defaultExport: true })).toThrow(
        /refusing to overwrite compatibility history/,
    );
});

it('refuses to archive a matrix that does not match the compatibility schema', () => {
    const matrix = compatibilityMatrix([]);
    const invalidMatrix = Object.fromEntries(Object.entries(matrix).filter(([key]) => key !== 'inventory'));
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pumpkin-compatibility-history-'));
    temporaryDirectories.push(directory);

    expect(() => archiveCompatibilityMatrix(directory, invalidMatrix as unknown as CompatibilityMatrix)).toThrow(
        /invalid Pumpkin API compatibility matrix/,
    );
});

it('refuses to archive a compatibility audit that still needs review', () => {
    const matrix = compatibilityMatrix([
        {
            id: 'world.read',
            kind: 'function',
            signature: 'world.read() -> u32',
            decision: 'review-required',
            migration: '',
        },
    ]);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pumpkin-compatibility-history-'));
    temporaryDirectories.push(directory);

    expect(() => archiveCompatibilityMatrix(directory, matrix)).toThrow(/unresolved compatibility review/);
});

it('refuses to archive a compatibility audit with an unsupported decision', () => {
    const matrix = compatibilityMatrix([
        {
            id: 'world.read',
            kind: 'function',
            signature: 'world.read() -> u32',
            decision: 'maybe' as CompatibilityOperation['decision'],
            migration: 'This decision is not part of the compatibility vocabulary.',
        },
    ]);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pumpkin-compatibility-history-'));
    temporaryDirectories.push(directory);

    expect(() => archiveCompatibilityMatrix(directory, matrix)).toThrow(/unresolved compatibility review/);
});

function compatibilityMatrix(
    operations: Array<Pick<CompatibilityOperation, 'id' | 'kind' | 'signature'> & Partial<CompatibilityOperation>>,
): CompatibilityMatrix {
    return {
        $schema:
            'https://raw.githubusercontent.com/filiphsps/pumpkin-plugins/master/tools/pumpkin-api/schemas/pumpkin-api-compatibility.schema.json',
        baseline: {
            package: '@pumpkinmc/pumpkin-api-ts',
            version: '0.1.1',
            archive:
                'https://github.com/Pumpkin-MC/pumpkin-api-ts/releases/download/v0.1.1/pumpkinmc-pumpkin-api-ts-0.1.1.tgz',
            integrity:
                'sha512-FpJjXx05AvLQGVguOnWN6wPfb0mZVfRNiWxYHgiaIYFRQoiRyhqsqemriWsBBmlUlpMqihhd4uJJLpye7rMlpQ==',
            pumpkinRelease: '0.2.0+26.3-26.51',
            license: 'MIT OR Apache-2.0',
        },
        replacement: {
            package: '@pumpkin-plugins/pumpkin-api',
            version: '0.1.0',
            witPackage: 'pumpkin:plugin@0.1.0',
            license: 'MIT',
        },
        sourceWit: {
            repository: 'https://github.com/Pumpkin-MC/pumpkin-plugin-wit',
            branch: 'master',
            commit: '4d7a501943bb99f0f02a339128833f58ed37d0cc',
            subdirectory: 'v0.1',
        },
        sourceWitSha256: '111dab16b0475551f23422d5bf734b7900f3030a0f8b33cefde70af10f3ea825',
        defaultExport: false,
        runtimeExports: [],
        publicTypes: [],
        inventory: { interfaces: 1, types: 0, operations: operations.length },
        interfaces: [
            {
                name: 'world',
                specifier: 'pumpkin:plugin/world@0.1.0',
                decision: 'retained',
                migration: 'The interface is unchanged.',
                types: [],
                operations: operations.map((operation) => ({
                    decision: 'retained',
                    migration: 'The operation is unchanged.',
                    features: [],
                    ...operation,
                })),
            },
        ],
        deviations: [],
        sourceChanges: [],
    };
}

function recordType(signature: string): CompatibilityType {
    return { name: 'position', kind: 'record', signature, decision: 'retained', migration: 'The type is unchanged.' };
}

function firstOperation(matrix: CompatibilityMatrix) {
    const operation = matrix.interfaces[0]?.operations?.[0];
    if (!operation) throw new Error('expected the compatibility matrix to contain an operation');
    return operation;
}
