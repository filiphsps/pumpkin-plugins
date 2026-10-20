import * as fs from 'node:fs';
import * as path from 'node:path';
import { COMPATIBILITY_SCHEMA_URL, validateCompatibilityMatrix } from './compatibility-schema.ts';

const reviewedDecisions = new Set(['retained', 'improved', 'replaced', 'removed', 'added']);

/** A compatibility decision; `review-required` marks an item that still needs one. */
export type CompatibilityDecision = 'retained' | 'improved' | 'replaced' | 'removed' | 'added' | 'review-required';

/** A WIT declaration that was added, changed or removed between two audited revisions. */
export interface CompatibilityChange {
    change: 'added' | 'changed' | 'removed';
    currentSignature: string | null;
    decision: CompatibilityDecision;
    id: string;
    impact: 'additive' | 'breaking';
    migration: string;
    previousSignature: string | null;
}

/** The compatibility data needed to compare and preserve one WIT audit. */
export interface CompatibilityMatrix {
    $schema: string;
    baseline: {
        package: string;
        version: string;
        archive: string;
        integrity: string;
        pumpkinRelease: string | string[];
        license: string;
    };
    defaultExport: boolean;
    deviations: CompatibilityDeviation[];
    interfaces: CompatibilityInterface[];
    inventory: { interfaces: number; types: number; operations: number };
    publicTypes: CompatibilityItem[];
    replacement: { package: string; version: string; witPackage: string; license: string };
    runtimeExports: CompatibilityItem[];
    sourceChanges: CompatibilityChange[];
    sourceWit: { repository: string; branch: string; commit: string; subdirectory: string };
    sourceWitSha256: string;
}

/** A runtime export or public TypeScript type with an explicit compatibility decision. */
export interface CompatibilityItem {
    decision: CompatibilityDecision;
    migration: string;
    name: string;
}

/** A WIT interface and its declarations in a compatibility matrix. */
export interface CompatibilityInterface {
    decision: CompatibilityDecision;
    migration: string;
    name: string;
    operations: CompatibilityOperation[];
    specifier: string;
    types: CompatibilityType[];
}

/** A WIT type declared by an audited interface. */
export interface CompatibilityType {
    decision: CompatibilityDecision;
    kind: 'type' | 'record' | 'variant' | 'flags' | 'enum';
    migration: string;
    name: string;
    signature: string;
}

/** A WIT function or resource method declared by an audited interface. */
export interface CompatibilityOperation {
    decision: CompatibilityDecision;
    features: string[];
    id: string;
    kind: 'function' | 'resource-constructor' | 'resource-method' | 'resource-static-method';
    migration: string;
    signature: string;
}

/** A facade behavior change that is not tied to one export or WIT declaration. */
export interface CompatibilityDeviation {
    decision: CompatibilityDecision;
    item: string;
    migration: string;
    rationale: string;
}

type ReviewedItem = { decision: CompatibilityDecision; migration: string };

/** Compare the complete lock provenance and fetched WIT digest for two revisions. */
export function hasSameWitRevision(
    previous: CompatibilityMatrix | undefined,
    current: Pick<CompatibilityMatrix, 'sourceWit' | 'sourceWitSha256'>,
): boolean {
    if (!previous) return false;

    return (
        previous.sourceWit.repository === current.sourceWit.repository &&
        previous.sourceWit.branch === current.sourceWit.branch &&
        previous.sourceWit.commit.toLowerCase() === current.sourceWit.commit.toLowerCase() &&
        previous.sourceWit.subdirectory === current.sourceWit.subdirectory &&
        previous.sourceWitSha256.toLowerCase() === current.sourceWitSha256.toLowerCase()
    );
}

/** Find upstream WIT declarations added, changed, or removed between two audits. */
export function diffCompatibilityMatrices(
    previous: CompatibilityMatrix,
    current: CompatibilityMatrix,
): CompatibilityChange[] {
    const previousItems = collectWitItems(previous);
    const currentItems = collectWitItems(current);
    const changes: CompatibilityChange[] = [];

    for (const id of [...new Set([...previousItems.keys(), ...currentItems.keys()])].sort()) {
        const previousItem = previousItems.get(id);
        const currentItem = currentItems.get(id);
        if (previousItem?.signature === currentItem?.signature) continue;

        const change = !previousItem ? 'added' : !currentItem ? 'removed' : 'changed';
        changes.push({
            id,
            change,
            previousSignature: previousItem?.signature ?? null,
            currentSignature: currentItem?.signature ?? null,
            impact: change === 'added' ? 'additive' : 'breaking',
            decision: 'review-required',
            migration: '',
        });
    }

    return changes;
}

/** Carry reviewed decisions forward and mark declarations changed by a new WIT revision for review. */
export function reconcileCompatibilityMatrix(
    previous: CompatibilityMatrix | undefined,
    candidate: CompatibilityMatrix,
    changes: CompatibilityChange[],
    sameRevision: boolean,
): CompatibilityMatrix {
    const result = structuredClone(candidate);
    const previousItems = previous ? collectMatrixItems(previous) : new Map<string, ReviewedItem>();
    const changedIds = new Set(changes.map(({ id }) => id));

    const reconcileItem = (id: string, item: ReviewedItem) => {
        const prior = previousItems.get(id);
        const preservePriorDecision = prior && (sameRevision || !changedIds.has(id));
        if (preservePriorDecision) {
            item.decision = prior.decision;
            item.migration = prior.migration;
        } else {
            item.decision = 'review-required';
            item.migration = '';
        }
    };

    for (const item of result.runtimeExports) reconcileItem(`runtime:${item.name}`, item);
    for (const item of result.publicTypes) reconcileItem(`public:${item.name}`, item);
    for (const apiInterface of result.interfaces) {
        const interfaceId = `interface:${apiInterface.name}`;
        reconcileItem(interfaceId, apiInterface);
        for (const type of apiInterface.types) reconcileItem(`type:${apiInterface.name}.${type.name}`, type);
        for (const operation of apiInterface.operations) {
            reconcileItem(`operation:${qualifyOperationId(apiInterface.name, operation.id)}`, operation);
        }
    }

    result.sourceChanges = sameRevision && previous ? structuredClone(previous.sourceChanges) : changes;
    return result;
}

/** Archive a compatibility matrix under its Pumpkin release and immutable WIT revision. */
export function archiveCompatibilityMatrix(compatibilityDirectory: string, matrix: CompatibilityMatrix): string {
    const unresolvedItem = [...collectMatrixItems(matrix)].find(
        ([, item]) => !reviewedDecisions.has(item.decision) || !item.migration,
    );
    const unresolvedChange = matrix.sourceChanges.find(
        ({ decision, migration }) => !reviewedDecisions.has(decision) || !migration,
    );
    if (unresolvedItem || unresolvedChange) {
        const itemId = unresolvedItem?.[0] ?? unresolvedChange?.id;
        throw new Error(`cannot archive compatibility audit with unresolved compatibility review: ${itemId}`);
    }

    const release = Array.isArray(matrix.baseline.pumpkinRelease)
        ? matrix.baseline.pumpkinRelease.join(',')
        : matrix.baseline.pumpkinRelease;
    const releaseDirectory = safePathSegment(release);
    const commit = matrix.sourceWit.commit.toLowerCase();
    const digest = matrix.sourceWitSha256.toLowerCase();
    const subdirectory = matrix.sourceWit.subdirectory;
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) {
        throw new Error(`cannot archive compatibility matrix with invalid WIT commit: ${matrix.sourceWit.commit}`);
    }
    if (!/^[a-f0-9]{64}$/.test(digest)) {
        throw new Error(`cannot archive compatibility matrix with invalid WIT SHA-256: ${matrix.sourceWitSha256}`);
    }

    const historyDirectory = path.join(compatibilityDirectory, 'history', releaseDirectory);
    const sourceDirectory = subdirectory.split('/').map(safePathSegment);
    const archivePath = path.join(historyDirectory, ...sourceDirectory, `${commit}-${digest}.json`);
    const archivedMatrix = { ...matrix, $schema: COMPATIBILITY_SCHEMA_URL };
    validateCompatibilityMatrix(archivedMatrix, archivePath);
    const serialized = `${JSON.stringify(archivedMatrix, null, 4)}\n`;
    fs.mkdirSync(path.dirname(archivePath), { recursive: true });

    try {
        fs.writeFileSync(archivePath, serialized, { flag: 'wx' });
    } catch (error) {
        if (!isAlreadyExistsError(error)) throw error;
        if (fs.readFileSync(archivePath, 'utf8') !== serialized) {
            throw new Error(`refusing to overwrite compatibility history: ${archivePath}`);
        }
    }

    return archivePath;
}

function collectWitItems(matrix: CompatibilityMatrix) {
    const items = new Map<string, { signature: string }>();
    for (const apiInterface of matrix.interfaces) {
        items.set(`interface:${apiInterface.name}`, { signature: apiInterface.specifier });
        for (const type of apiInterface.types) {
            items.set(`type:${apiInterface.name}.${type.name}`, { signature: `${type.kind}:${type.signature}` });
        }
        for (const operation of apiInterface.operations) {
            items.set(`operation:${qualifyOperationId(apiInterface.name, operation.id)}`, {
                signature: `${operation.kind}:${operation.signature}:${JSON.stringify(operation.features)}`,
            });
        }
    }
    return items;
}

function collectMatrixItems(matrix: CompatibilityMatrix) {
    const items = new Map<string, ReviewedItem>();
    for (const item of matrix.runtimeExports) items.set(`runtime:${item.name}`, item);
    for (const item of matrix.publicTypes) items.set(`public:${item.name}`, item);
    for (const apiInterface of matrix.interfaces) {
        items.set(`interface:${apiInterface.name}`, apiInterface);
        for (const type of apiInterface.types) items.set(`type:${apiInterface.name}.${type.name}`, type);
        for (const operation of apiInterface.operations) {
            items.set(`operation:${qualifyOperationId(apiInterface.name, operation.id)}`, operation);
        }
    }
    return items;
}

function safePathSegment(value: string) {
    const segment = value.replace(/[^a-zA-Z0-9.+_-]/g, '_');
    if (!segment || segment === '.' || segment === '..')
        throw new Error('invalid Pumpkin release for compatibility history');
    return segment;
}

function qualifyOperationId(interfaceName: string, operationId: string) {
    return operationId.startsWith(`${interfaceName}.`) ? operationId : `${interfaceName}.${operationId}`;
}

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}
