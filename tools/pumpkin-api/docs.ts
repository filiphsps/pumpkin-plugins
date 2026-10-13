import { readdirSync, readFileSync } from 'node:fs';
import { code, table } from '@pumpkin-plugins/docs/markdown';
import type { DocumentSpec } from '@pumpkin-plugins/docs/node';

interface CompatibilityDefinition {
    baseline: {
        package: string;
        version: string;
        pumpkinRelease: string | string[];
    };
    inventory: {
        interfaces: number;
        types: number;
        operations: number;
    };
    runtimeExports: unknown[];
    publicTypes: unknown[];
}

const compatibilityDirectory = new URL('./compatibility/', import.meta.url);
const compatibilityFiles = readdirSync(compatibilityDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort();

if (compatibilityFiles.length === 0) {
    throw new Error('tools/pumpkin-api/compatibility must contain at least one compatibility definition');
}

const compatibilityRows = compatibilityFiles.map((file) => {
    const definition = JSON.parse(
        readFileSync(new URL(`./compatibility/${file}`, import.meta.url), 'utf8')
    ) as CompatibilityDefinition;
    const pumpkinReleases = Array.isArray(definition.baseline.pumpkinRelease)
        ? definition.baseline.pumpkinRelease
        : [definition.baseline.pumpkinRelease];
    const surface = [
        `${definition.runtimeExports.length} runtime exports`,
        `${definition.publicTypes.length} public TypeScript types`,
        `${definition.inventory.interfaces} WIT interfaces`,
        `${definition.inventory.types} WIT types`,
        `${definition.inventory.operations} operations`
    ].join('; ');

    return [
        `${code(definition.baseline.package)} ${code(`v${definition.baseline.version}`)}`,
        pumpkinReleases.map(code).join(', '),
        surface,
        `[Item-level decisions](../compatibility/${file})`
    ];
});

/** Generated compatibility choices shown by the API migration guide. */
export const documents = [
    {
        file: 'docs/migration.md',
        blocks: {
            'compatibility-matrix': table(
                ['Source baseline', 'Pumpkin release', 'Audited API surface', 'Details'],
                compatibilityRows
            )
        },
        note: '<!-- Generated from compatibility/*.json. Run `pnpm readme`. -->'
    }
] satisfies DocumentSpec[];
