import * as path from 'node:path';
import type { CodemodDefinition } from '../types.js';
import { SOURCE_EXTENSIONS } from './pumpkin-api/constants.ts';
import { migratePackageJson } from './pumpkin-api/package-json.ts';
import { migrateSource } from './pumpkin-api/source.ts';
import { migrateTsconfig } from './pumpkin-api/tsconfig.ts';

/** Migrates `@pumpkinmc/pumpkin-api-ts` imports and project configuration to the Pumpkin API package. */
export const migratePumpkinApiTs: CodemodDefinition = {
    id: 'migrate-pumpkin-api-ts',
    description: 'Migrate a plugin from @pumpkinmc/pumpkin-api-ts to @pumpkin-plugins/pumpkin-api.',
    matchesFile: matchesMigrationFile,
    transform(context) {
        const basename = path.basename(context.relativePath);
        if (basename === 'package.json') return migratePackageJson(context.source);
        if (basename === 'tsconfig.json') return migrateTsconfig(context.source, context.absolutePath);
        return migrateSource(context);
    },
};

/** Selects source and project configuration files supported by the migration. */
function matchesMigrationFile(relativePath: string): boolean {
    const basename = path.basename(relativePath);
    return basename === 'package.json' || basename === 'tsconfig.json' || SOURCE_EXTENSIONS.has(path.extname(basename));
}
