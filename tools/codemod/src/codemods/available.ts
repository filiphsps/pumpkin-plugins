import { codemods } from './index.ts';

/** Codemod commands shown in the CLI and package documentation. */
export const availableCodemods = [
    ...codemods.map(({ id, description }) => ({ id, description })),
    {
        id: 'update-build',
        description: 'Update @pumpkin-plugins/build and apply its release migrations.',
    },
];
