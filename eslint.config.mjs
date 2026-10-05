// Biome does the formatting and general linting. ESLint is only here because Biome has no rule
// for documentation: it checks that public code carries a JSDoc description.
import jsdoc from 'eslint-plugin-jsdoc';
import tseslint from 'typescript-eslint';

const EXPORT = ':matches(ExportNamedDeclaration, ExportDefaultDeclaration)';

/**
 * What must be documented: exported declarations and the public members of exported classes.
 * The export statement itself is selected (not the declaration inside it) because that is where
 * the comment sits.
 */
const REQUIRED = [
    `${EXPORT}:has(> FunctionDeclaration)`,
    `${EXPORT}:has(> ClassDeclaration)`,
    `${EXPORT}:has(> TSInterfaceDeclaration)`,
    `${EXPORT}:has(> TSTypeAliasDeclaration)`,
    `${EXPORT}:has(> TSEnumDeclaration)`,
    `${EXPORT}:has(> VariableDeclaration)`,
    `${EXPORT} > ClassDeclaration > ClassBody > MethodDefinition[accessibility!='private'][accessibility!='protected'][kind!='constructor']`
];

export default [
    {
        ignores: [
            '**/node_modules/**',
            'build/**',
            'packages/*/build/**',
            'tools/*/build/**',
            '**/dist/**',
            '**/.turbo/**',
            '**/.cache/**',
            'turbo/generators/templates/**'
        ]
    },
    {
        files: ['**/*.ts'],
        ignores: ['**/*.test.ts', '**/*.itest.ts', '**/test/**', '**/testing/**', '**/*.config.ts', '**/*.d.ts'],
        languageOptions: { parser: tseslint.parser },
        plugins: { jsdoc },
        settings: { jsdoc: { mode: 'typescript' } },
        rules: {
            // Only the selectors above apply, so the plugin's own defaults (every function) are turned off.
            'jsdoc/require-jsdoc': [
                'error',
                {
                    publicOnly: false,
                    require: {
                        FunctionDeclaration: false,
                        ClassDeclaration: false,
                        MethodDefinition: false,
                        ArrowFunctionExpression: false,
                        FunctionExpression: false
                    },
                    contexts: REQUIRED
                }
            ],
            // A block with only tags is as bad as no block. Types come from TypeScript, so tags need no `{type}`.
            'jsdoc/require-description': ['error', { contexts: ['any'], exemptedBy: ['inheritdoc'] }],
            'jsdoc/no-types': 'error',
            'jsdoc/check-tag-names': 'error',
            // Parameters don't have to be documented, but a documented one has to exist.
            'jsdoc/check-param-names': ['error', { disableMissingParamChecks: true, checkDestructured: false }]
        }
    }
];
