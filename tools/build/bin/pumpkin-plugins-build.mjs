#!/usr/bin/env node
// Builds the plugin in the current directory into a Pumpkin .wasm component, or with --types-only
// just the type declarations for the modules it imports. See docs/building.md.
import { main } from '../src/cli.ts';

await main(process.argv.slice(2), process.cwd());
