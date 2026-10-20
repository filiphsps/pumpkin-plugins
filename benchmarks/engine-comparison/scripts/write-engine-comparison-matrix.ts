import * as fs from 'node:fs';
import { createEngineComparisonMatrix } from '../src/engine-variants.ts';

const outputPath = process.env.GITHUB_OUTPUT;
if (!outputPath) throw new Error('GITHUB_OUTPUT is required to publish the engine comparison matrix');

const matrix = { include: createEngineComparisonMatrix() };
fs.appendFileSync(outputPath, `jobs=${JSON.stringify(matrix)}\n`);
