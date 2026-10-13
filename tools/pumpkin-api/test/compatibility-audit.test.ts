import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
    archiveCompatibilityMatrix,
    type CompatibilityMatrix,
    diffCompatibilityMatrices,
    hasSameWitRevision,
    reconcileCompatibilityMatrix
} from '../src/compatibility-audit.ts';

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

it('reports same-release WIT additions, removals, and signature changes as explicit review items', () => {
    const previous = compatibilityMatrix([
        { id: 'world.read', kind: 'function', signature: 'world.read() -> u32' },
        { id: 'world.delete', kind: 'function', signature: 'world.delete() -> unit' }
    ]);
    const current = compatibilityMatrix([
        { id: 'world.read', kind: 'function', signature: 'world.read() -> u64' },
        { id: 'world.create', kind: 'function', signature: 'world.create() -> unit' }
    ]);
    previous.interfaces[0].types = [
        { name: 'position', kind: 'record', signature: '{"fields":[{"name":"x","type":"u32"}]}' }
    ];
    current.interfaces[0].types = [
        { name: 'position', kind: 'record', signature: '{"fields":[{"name":"x","type":"u64"}]}' }
    ];

    const changes = diffCompatibilityMatrices(previous, current);

    expect(changes).toEqual([
        {
            id: 'operation:world.create',
            change: 'added',
            previousSignature: null,
            currentSignature: 'function:world.create() -> unit:[]',
            impact: 'additive',
            decision: 'review-required',
            migration: ''
        },
        {
            id: 'operation:world.delete',
            change: 'removed',
            previousSignature: 'function:world.delete() -> unit:[]',
            currentSignature: null,
            impact: 'breaking',
            decision: 'review-required',
            migration: ''
        },
        {
            id: 'operation:world.read',
            change: 'changed',
            previousSignature: 'function:world.read() -> u32:[]',
            currentSignature: 'function:world.read() -> u64:[]',
            impact: 'breaking',
            decision: 'review-required',
            migration: ''
        },
        {
            id: 'type:world.position',
            change: 'changed',
            previousSignature: 'record:{"fields":[{"name":"x","type":"u32"}]}',
            currentSignature: 'record:{"fields":[{"name":"x","type":"u64"}]}',
            impact: 'breaking',
            decision: 'review-required',
            migration: ''
        }
    ]);
});

it('preserves reviewed decisions for unchanged items and requires review for changed items', () => {
    const previous = compatibilityMatrix([
        {
            id: 'world.read',
            kind: 'function',
            signature: 'world.read() -> u32',
            decision: 'improved',
            migration: 'Existing note.'
        }
    ]);
    const candidate = compatibilityMatrix([
        { id: 'world.read', kind: 'function', signature: 'world.read() -> u64' },
        { id: 'world.create', kind: 'function', signature: 'world.create() -> unit' }
    ]);
    const changes = diffCompatibilityMatrices(previous, candidate);

    const updated = reconcileCompatibilityMatrix(previous, candidate, changes, false);

    expect(updated.interfaces[0].operations).toEqual([
        {
            id: 'world.read',
            kind: 'function',
            signature: 'world.read() -> u64',
            decision: 'review-required',
            migration: ''
        },
        {
            id: 'world.create',
            kind: 'function',
            signature: 'world.create() -> unit',
            decision: 'review-required',
            migration: ''
        }
    ]);
    expect(updated.sourceChanges).toEqual(changes);
});

it('keeps reviewed revision notes when regenerating the same WIT audit', () => {
    const previous = compatibilityMatrix([
        { id: 'world.create', kind: 'function', signature: 'world.create() -> unit' }
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
            migration: 'New operation; existing call sites do not change.'
        }
    ];
    const candidate = compatibilityMatrix([
        { id: 'world.create', kind: 'function', signature: 'world.create() -> unit' }
    ]);

    const updated = reconcileCompatibilityMatrix(previous, candidate, [], true);

    expect(updated.sourceChanges).toEqual(previous.sourceChanges);
    expect(firstOperation(updated)).toMatchObject({
        decision: 'retained',
        migration: 'Existing note.'
    });
});

it('treats repository, branch, subdirectory, commit, and content digest as WIT revision provenance', () => {
    const matrix = compatibilityMatrix([]);
    const samePin = {
        sourceWit: matrix.sourceWit,
        sourceWitSha256: matrix.sourceWitSha256
    };

    expect(hasSameWitRevision(matrix, samePin)).toBe(true);
    const legacyMatrix = structuredClone(matrix);
    legacyMatrix.sourceWit.subdirectory = undefined;
    expect(hasSameWitRevision(legacyMatrix, samePin)).toBe(true);
    expect(
        hasSameWitRevision(matrix, {
            ...samePin,
            sourceWit: { ...samePin.sourceWit, repository: 'https://example.com/other.git' }
        })
    ).toBe(false);
    expect(
        hasSameWitRevision(matrix, {
            ...samePin,
            sourceWit: { ...samePin.sourceWit, branch: 'release' }
        })
    ).toBe(false);
    expect(
        hasSameWitRevision(matrix, {
            ...samePin,
            sourceWit: { ...samePin.sourceWit, subdirectory: 'v0.2' }
        })
    ).toBe(false);
    expect(
        hasSameWitRevision(matrix, {
            ...samePin,
            sourceWit: { ...samePin.sourceWit, commit: '5d7a501943bb99f0f02a339128833f58ed37d0cc' }
        })
    ).toBe(false);
    expect(hasSameWitRevision(matrix, { ...samePin, sourceWitSha256: '2'.repeat(64) })).toBe(false);
});

it('archives each release and WIT revision without overwriting a different audit', () => {
    const matrix = compatibilityMatrix([]);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pumpkin-compatibility-history-'));
    temporaryDirectories.push(directory);

    const archivePath = archiveCompatibilityMatrix(directory, matrix);

    expect(path.relative(directory, archivePath)).toBe(
        'history/0.2.0+26.3-26.51/v0.1/4d7a501943bb99f0f02a339128833f58ed37d0cc-111dab16b0475551f23422d5bf734b7900f3030a0f8b33cefde70af10f3ea825.json'
    );
    expect(fs.readFileSync(archivePath, 'utf8')).toBe(`${JSON.stringify(matrix, null, 4)}\n`);
    expect(archiveCompatibilityMatrix(directory, matrix)).toBe(archivePath);

    expect(() => archiveCompatibilityMatrix(directory, { ...matrix, defaultExport: true })).toThrow(
        /refusing to overwrite compatibility history/
    );
});

it('records the legacy v0.1 source directory when archiving an older matrix without a subdirectory field', () => {
    const matrix = compatibilityMatrix([]);
    matrix.sourceWit = {
        repository: 'https://github.com/Pumpkin-MC/pumpkin-plugin-wit',
        branch: 'master',
        commit: '4d7a501943bb99f0f02a339128833f58ed37d0cc'
    } as never;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pumpkin-compatibility-history-'));
    temporaryDirectories.push(directory);

    const archivePath = archiveCompatibilityMatrix(directory, matrix);

    expect(path.relative(directory, archivePath)).toContain(path.join('history', '0.2.0+26.3-26.51', 'v0.1'));
    expect(JSON.parse(fs.readFileSync(archivePath, 'utf8')).sourceWit.subdirectory).toBe('v0.1');
});

it('refuses to archive a compatibility audit that still needs review', () => {
    const matrix = compatibilityMatrix([
        {
            id: 'world.read',
            kind: 'function',
            signature: 'world.read() -> u32',
            decision: 'review-required',
            migration: ''
        }
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
            decision: 'maybe',
            migration: 'This decision is not part of the compatibility vocabulary.'
        }
    ]);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pumpkin-compatibility-history-'));
    temporaryDirectories.push(directory);

    expect(() => archiveCompatibilityMatrix(directory, matrix)).toThrow(/unresolved compatibility review/);
});

function compatibilityMatrix(operations: Record<string, string>[]): CompatibilityMatrix {
    return {
        baseline: { package: '@pumpkinmc/pumpkin-api-ts', version: '0.1.1', pumpkinRelease: '0.2.0+26.3-26.51' },
        sourceWit: {
            repository: 'https://github.com/Pumpkin-MC/pumpkin-plugin-wit',
            branch: 'master',
            commit: '4d7a501943bb99f0f02a339128833f58ed37d0cc',
            subdirectory: 'v0.1'
        },
        sourceWitSha256: '111dab16b0475551f23422d5bf734b7900f3030a0f8b33cefde70af10f3ea825',
        interfaces: [
            {
                name: 'world',
                specifier: 'pumpkin:plugin/world@0.1.0',
                decision: 'retained',
                migration: 'The interface is unchanged.',
                operations: operations.map((operation) => ({
                    decision: 'retained',
                    migration: 'The operation is unchanged.',
                    ...operation
                }))
            }
        ]
    };
}

function firstOperation(matrix: CompatibilityMatrix) {
    const operation = matrix.interfaces[0]?.operations?.[0];
    if (!operation) throw new Error('expected the compatibility matrix to contain an operation');
    return operation;
}
