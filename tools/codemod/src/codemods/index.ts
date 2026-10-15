import type { CodemodDefinition } from '../types.js';
import { migratePumpkinApiTs } from './migrate-pumpkin-api.ts';

/** Codemods bundled with the Pumpkin codemod CLI. */
export const codemods: readonly CodemodDefinition[] = [migratePumpkinApiTs];
