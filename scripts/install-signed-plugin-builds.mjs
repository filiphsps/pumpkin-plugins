// Replaces package build outputs with the verified signed copies from dist before CI uploads the
// artifacts used by integration tests. `dist` is also the source for release artifacts.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { discoverComponents } from '@pumpkin-plugins/docs/node';
import { verifyWasm } from '@pumpkin-plugins/signing';

const root = process.env.PUMPKIN_PLUGINS_ROOT ?? path.resolve(import.meta.dirname, '..');
const distDir = path.join(root, 'dist');
for (const { slug, directory: packageDir, metadataFile } of discoverComponents(root, 'packages')) {
    const pkg = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
    const output = pkg.pumpkinPlugin?.output;
    if (!output) throw new Error(`packages/${slug}/package.json has no pumpkinPlugin.output`);

    const artifact = path.join(distDir, `${slug}.wasm`);
    if (!fs.existsSync(artifact)) throw new Error(`Signed plugin artifact ${artifact} is missing`);
    const bytes = fs.readFileSync(artifact);
    const verification = verifyWasm(bytes);
    if (!verification.valid) {
        throw new Error(
            `Signed plugin artifact ${artifact} failed verification: ${verification.error ?? 'invalid signature'}`
        );
    }

    const build = path.resolve(packageDir, output);
    if (!fs.existsSync(build)) throw new Error(`Built plugin ${build} is missing; run \`pnpm build\` first`);
    fs.writeFileSync(build, bytes);
    console.log(`Installed verified signed ${artifact} at ${path.relative(root, build)}`);
}
