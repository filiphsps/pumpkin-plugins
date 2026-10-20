import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import type { CompatibilityItem, CompatibilityMatrix } from '../src/compatibility-audit.ts';
import { validateCompatibilityMatrix } from '../src/compatibility-schema.ts';
import { parsePumpkinWitPin } from '../src/wit.mjs';

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

type ReviewedItem = Pick<CompatibilityItem, 'decision' | 'migration'> & { id: string };

it('discovers at least one compatibility definition', () => {
    expect(matrixFiles.length).toBeGreaterThan(0);
});

it('uses the published schema URL in matrices', () => {
    const schemaUrl =
        'https://raw.githubusercontent.com/filiphsps/pumpkin-plugins/master/tools/pumpkin-api/schemas/pumpkin-api-compatibility.schema.json';

    const matrixPaths = [...matrixFiles.map((file) => path.join(compatibilityDirectory, file)), ...historyFiles];
    for (const matrixPath of matrixPaths) {
        const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
        expect(matrix.$schema).toBe(schemaUrl);
    }

    const schema = JSON.parse(
        fs.readFileSync(path.join(apiRoot, 'schemas/pumpkin-api-compatibility.schema.json'), 'utf8'),
    );
    expect(schema.$id).toBe(schemaUrl);
    expect(schema.properties.$schema.const).toBe(schemaUrl);
});

it('rejects compatibility matrices that omit schema-required fields', () => {
    const matrixPath = path.join(compatibilityDirectory, matrixFiles[0]);
    const matrix = Object.fromEntries(
        Object.entries(JSON.parse(fs.readFileSync(matrixPath, 'utf8'))).filter(([key]) => key !== 'inventory'),
    );

    expect(() => validateCompatibilityMatrix(matrix, matrixPath)).toThrow(/inventory/);
});

for (const file of matrixFiles) {
    it(`records compatibility decisions for every API item in ${file}`, () => {
        const matrixPath = path.join(compatibilityDirectory, file);
        const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8')) as CompatibilityMatrix;
        validateCompatibilityMatrix(matrix, matrixPath);
        const { package: baselinePackage, version, archive } = matrix.baseline;
        const tarball = `${baselinePackage.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
        const interfaceTypes = matrix.interfaces.flatMap((apiInterface) => apiInterface.types);
        const interfaceOperations = matrix.interfaces.flatMap((apiInterface) => apiInterface.operations);

        expect(file).toBe(`v${version}.json`);
        expect(path.posix.basename(new URL(archive).pathname)).toBe(tarball);
        expect(matrix.sourceWit).toEqual(witPin);
        expect(matrix.inventory).toEqual({
            interfaces: matrix.interfaces.length,
            types: interfaceTypes.length,
            operations: interfaceOperations.length,
        });

        const symbols = [
            ...matrix.runtimeExports.map(({ name }) => `runtime:${name}`),
            ...matrix.publicTypes.map(({ name }) => `type:${name}`),
            ...matrix.interfaces.map(({ name }) => `interface:${name}`),
            ...matrix.interfaces.flatMap((apiInterface) =>
                apiInterface.types.map(({ name }) => `type:${apiInterface.name}.${name}`),
            ),
            ...interfaceOperations.map(({ id }) => `operation:${id}`),
        ];
        expect(symbols.filter((symbol, index) => symbols.indexOf(symbol) !== index)).toEqual([]);
        expect(unreviewedItems(matrix)).toEqual([]);
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
            path.join(expectedReleaseDirectory, ...matrix.sourceWit.subdirectory.split('/'), expectedFilename),
        );
        expect(matrix.sourceWit.repository).toBeTruthy();
        expect(matrix.sourceWit.branch).toBeTruthy();
        expect(matrix.sourceWit.commit).toMatch(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
        expect(matrix.sourceWitSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(unreviewedItems(matrix)).toEqual([]);
    });
}

function unreviewedItems(matrix: CompatibilityMatrix): string[] {
    const items: ReviewedItem[] = [
        ...matrix.runtimeExports.map((item) => ({ ...item, id: `runtime:${item.name}` })),
        ...matrix.publicTypes.map((item) => ({ ...item, id: `public:${item.name}` })),
        ...matrix.interfaces.flatMap((apiInterface) => [
            { ...apiInterface, id: `interface:${apiInterface.name}` },
            ...apiInterface.types.map((type) => ({ ...type, id: `type:${apiInterface.name}.${type.name}` })),
            ...apiInterface.operations.map((operation) => ({ ...operation, id: `operation:${operation.id}` })),
        ]),
        ...matrix.deviations.map((deviation) => ({ ...deviation, id: `deviation:${deviation.item}` })),
        ...matrix.sourceChanges.map((change) => ({ ...change, id: `change:${change.id}` })),
    ];
    return items
        .filter(({ decision, migration }) => !decisions.includes(decision) || migration.length === 0)
        .map(({ id }) => id);
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
