import * as path from 'node:path';
import { syncStarterToolDependencies } from './utils/tool-packages.mjs';

const root = process.env.PUMPKIN_PLUGINS_ROOT ?? path.resolve(import.meta.dirname, '..');
const changed = syncStarterToolDependencies(root);
console.log(changed ? 'Updated starter API and builder dependency ranges.' : 'Starter dependency ranges are current.');
