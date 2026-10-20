import * as fs from 'node:fs';
import * as path from 'node:path';
import { type EngineResult, validateMatchingResults } from '../src/benchmark-results.ts';
import { formatReport } from '../src/engine-comparison-report.ts';
import { createEngineVariants } from '../src/engine-variants.ts';

const resultDirectory = process.env.ENGINE_COMPARISON_RESULT_DIR;
const reportDirectory = process.env.ENGINE_COMPARISON_REPORT_DIR;
if (!resultDirectory || !reportDirectory) {
    throw new Error('ENGINE_COMPARISON_RESULT_DIR and ENGINE_COMPARISON_REPORT_DIR are required');
}

const variants = createEngineVariants();
const results = variants.map((variant) => {
    const resultPath = path.join(resultDirectory, `${variant.id}.json`);
    if (!fs.existsSync(resultPath)) throw new Error(`Missing matrix result for ${variant.id}: ${resultPath}`);
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as EngineResult;
    if (result.id !== variant.id || result.label !== variant.label) {
        throw new Error(`Matrix result ${resultPath} does not match ${variant.label}`);
    }
    if (result.binarySizeBytes <= 0) throw new Error(`${variant.label} produced an empty component`);
    return result;
});

validateMatchingResults(results);
const report = formatReport(results, 'quickjs');
fs.mkdirSync(reportDirectory, { recursive: true });
fs.writeFileSync(path.join(reportDirectory, 'engine-comparison-results.json'), `${JSON.stringify(results, null, 2)}\n`);
fs.writeFileSync(path.join(reportDirectory, 'report.md'), `${report}\n`);

const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath) {
    fs.appendFileSync(
        summaryPath,
        `${report}\n\n[Download the complete benchmark data and report](https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}/artifacts)\n`,
    );
}

process.stdout.write(`Collected ${results.length} engine benchmark results into ${reportDirectory}\n`);
