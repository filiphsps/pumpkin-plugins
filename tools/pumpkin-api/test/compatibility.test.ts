import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { validateCompatibilityMatrix } from '../src/compatibility-schema.ts';
import { parsePumpkinWitPin } from '../src/wit.mjs';

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(apiRoot, '../..');
const compatibilityDirectory = path.join(apiRoot, 'compatibility');
const witLockFile = path.join(apiRoot, 'wit.lock.json');
const witPin = parsePumpkinWitPin(fs.readFileSync(witLockFile, 'utf8'), witLockFile);
const matrixFiles = fs
    .readdirSync(compatibilityDirectory)
    .filter((file) => fs.statSync(path.join(compatibilityDirectory, file)).isFile() && file.endsWith('.json'))
    .sort();
const historyDirectory = path.join(compatibilityDirectory, 'history');
const historyFiles = fs.existsSync(historyDirectory) ? jsonFilesUnder(historyDirectory) : [];
const decisions = ['retained', 'improved', 'replaced', 'removed', 'added'];

interface MatrixItem {
    name?: string;
    id?: string;
    kind?: string;
    signature?: string;
    decision: string;
    migration: string;
}

interface SourceChange {
    id: string;
    change: 'added' | 'changed' | 'removed';
    previousSignature: string | null;
    currentSignature: string | null;
    impact: 'additive' | 'breaking';
    decision: string;
    migration: string;
}

interface CompatibilityMatrix {
    baseline: {
        package: string;
        version: string;
        archive: string;
        integrity: string;
        pumpkinRelease: string | string[];
    };
    inventory: { interfaces: number; types: number; operations: number };
    sourceWit: { repository: string; branch: string; commit: string; subdirectory: string };
    sourceWitSha256: string;
    defaultExport: boolean;
    runtimeExports: MatrixItem[];
    publicTypes: MatrixItem[];
    interfaces: Array<{
        name: string;
        decision: string;
        migration: string;
        types: Array<MatrixItem & { kind: string; signature: string }>;
        operations: Array<MatrixItem & { id: string; signature: string }>;
    }>;
    sourceChanges: SourceChange[];
    deviations: unknown[];
}

it('discovers at least one compatibility definition', () => {
    expect(matrixFiles.length).toBeGreaterThan(0);
});

it('uses the published schema URL in matrices and VS Code settings', () => {
    const schemaUrl =
        'https://raw.githubusercontent.com/filiphsps/pumpkin-plugins/master/schemas/pumpkin-api-compatibility.schema.json';

    const matrixPaths = [...matrixFiles.map((file) => path.join(compatibilityDirectory, file)), ...historyFiles];
    for (const matrixPath of matrixPaths) {
        const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
        expect(matrix.$schema).toBe(schemaUrl);
    }

    const schema = JSON.parse(
        fs.readFileSync(path.join(repoRoot, 'schemas/pumpkin-api-compatibility.schema.json'), 'utf8')
    );
    expect(schema.$id).toBe(schemaUrl);
    expect(schema.properties.$schema.const).toBe(schemaUrl);

    const settings = JSON.parse(fs.readFileSync(path.join(repoRoot, '.vscode/settings.json'), 'utf8'));
    expect(settings['json.schemas']).toContainEqual({
        fileMatch: ['tools/pumpkin-api/compatibility/**/*.json'],
        url: schemaUrl
    });
});

it('rejects compatibility matrices that omit schema-required fields', () => {
    const matrixPath = path.join(compatibilityDirectory, matrixFiles[0]);
    const matrix = Object.fromEntries(
        Object.entries(JSON.parse(fs.readFileSync(matrixPath, 'utf8'))).filter(([key]) => key !== 'inventory')
    );

    expect(() => validateCompatibilityMatrix(matrix, matrixPath)).toThrow(/inventory/);
});

for (const file of matrixFiles) {
    it(`records compatibility decisions for every API item in ${file}`, () => {
        const matrixPath = path.join(compatibilityDirectory, file);
        const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8')) as CompatibilityMatrix;
        validateCompatibilityMatrix(matrix, matrixPath);
        const pumpkinReleases = Array.isArray(matrix.baseline.pumpkinRelease)
            ? matrix.baseline.pumpkinRelease
            : [matrix.baseline.pumpkinRelease];
        const interfaceTypes = matrix.interfaces.flatMap((apiInterface) => apiInterface.types);
        const interfaceOperations = matrix.interfaces.flatMap((apiInterface) => apiInterface.operations);
        expect(matrix.baseline).toMatchObject({
            package: '@pumpkinmc/pumpkin-api-ts',
            version: '0.1.1',
            archive:
                'https://github.com/Pumpkin-MC/pumpkin-api-ts/releases/download/v0.1.1/pumpkinmc-pumpkin-api-ts-0.1.1.tgz'
        });
        expect(matrix.baseline.integrity).toMatch(/^sha512-/);
        expect(pumpkinReleases.length).toBeGreaterThan(0);
        expect(pumpkinReleases.every((release) => release.length > 0)).toBe(true);
        expect(matrix.sourceWit).toEqual(witPin);
        expect(typeof matrix.defaultExport).toBe('boolean');
        expect(matrix.inventory.interfaces).toBe(matrix.interfaces.length);
        expect(matrix.inventory.types).toBe(interfaceTypes.length);
        expect(matrix.inventory.operations).toBe(interfaceOperations.length);
        expect(Array.isArray(matrix.deviations)).toBe(true);

        const symbols = [
            ...matrix.runtimeExports.map(({ name }) => `runtime:${name}`),
            ...matrix.publicTypes.map(({ name }) => `type:${name}`),
            ...matrix.interfaces.map(({ name }) => `interface:${name}`),
            ...matrix.interfaces.flatMap((apiInterface) =>
                apiInterface.types.map(({ name }) => `type:${apiInterface.name}.${name}`)
            ),
            ...interfaceOperations.map(({ id }) => `operation:${id}`)
        ];
        expect(new Set(symbols).size).toBe(symbols.length);

        const everyDecisionHasMigration = (item: MatrixItem) =>
            decisions.includes(item.decision) && item.migration.length > 0;
        expect(matrix.runtimeExports.every(everyDecisionHasMigration)).toBe(true);
        expect(matrix.publicTypes.every(everyDecisionHasMigration)).toBe(true);
        expect(matrix.interfaces.every(everyDecisionHasMigration)).toBe(true);
        expect(interfaceTypes.every(everyDecisionHasMigration)).toBe(true);
        expect(interfaceOperations.every(everyDecisionHasMigration)).toBe(true);
        expect(Array.isArray(matrix.sourceChanges)).toBe(true);
        expect(
            matrix.sourceChanges.every(
                ({ id, change, impact, decision, migration }) =>
                    id.length > 0 &&
                    (change === 'added' || change === 'changed' || change === 'removed') &&
                    impact === (change === 'added' ? 'additive' : 'breaking') &&
                    everyDecisionHasMigration({ decision, migration })
            )
        ).toBe(true);
    });
}

for (const file of historyFiles) {
    it(`preserves a reviewed historical compatibility audit in ${path.relative(compatibilityDirectory, file)}`, () => {
        const matrix = JSON.parse(fs.readFileSync(file, 'utf8')) as CompatibilityMatrix;
        validateCompatibilityMatrix(matrix, file);
        const expectedFilename = `${matrix.sourceWit.commit}-${matrix.sourceWitSha256}.json`;
        const pumpkinRelease = Array.isArray(matrix.baseline.pumpkinRelease)
            ? matrix.baseline.pumpkinRelease.join(',')
            : matrix.baseline.pumpkinRelease;
        const expectedReleaseDirectory = pumpkinRelease.replace(/[^a-zA-Z0-9.+_-]/g, '_');
        expect(path.basename(file)).toBe(expectedFilename);
        expect(path.relative(historyDirectory, file)).toBe(
            path.join(expectedReleaseDirectory, ...matrix.sourceWit.subdirectory.split('/'), expectedFilename)
        );
        expect(matrix.sourceWit.repository).toBeTruthy();
        expect(matrix.sourceWit.branch).toBeTruthy();
        expect(matrix.sourceWit.commit).toMatch(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
        expect(matrix.sourceWitSha256).toMatch(/^[a-f0-9]{64}$/);
        expectReviewed(matrix);
    });
}

function expectReviewed(matrix: CompatibilityMatrix) {
    const items = [
        ...matrix.runtimeExports,
        ...matrix.publicTypes,
        ...matrix.interfaces,
        ...matrix.interfaces.flatMap((apiInterface) => [...apiInterface.types, ...apiInterface.operations])
    ];
    expect(items.every(({ decision, migration }) => decisions.includes(decision) && migration.length > 0)).toBe(true);
    expect(
        matrix.sourceChanges.every(
            ({ change, impact, decision, migration }) =>
                impact === (change === 'added' ? 'additive' : 'breaking') &&
                decisions.includes(decision) &&
                migration.length > 0
        )
    ).toBe(true);
}

function jsonFilesUnder(directory: string): string[] {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const entryPath = path.join(directory, entry.name);
        return entry.isDirectory()
            ? jsonFilesUnder(entryPath)
            : entry.isFile() && entry.name.endsWith('.json')
              ? [entryPath]
              : [];
    });
}
