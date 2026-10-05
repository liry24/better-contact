import { defineConfig } from 'vite-plus'

export default defineConfig({
    fmt: {
        printWidth: 120,
        semi: false,
        singleQuote: true,
        tabWidth: 4,
        trailingComma: 'all',
        sortImports: true,
        sortPackageJson: true,
        ignorePatterns: ['**/*.md', '**/dist/**', '**/node_modules/**', '**/.contract-*/**', 'test/generated/**'],
    },
    lint: {
        categories: { correctness: 'error', perf: 'warn', suspicious: 'error' },
        env: { browser: true, node: true },
        ignorePatterns: ['**/dist/**', '**/node_modules/**', '**/.contract-*/**', 'test/generated/**'],
        options: { typeAware: true, typeCheck: true },
        plugins: ['import', 'typescript', 'unicorn', 'vitest'],
        rules: { 'import/no-cycle': 'error', 'no-console': 'warn', 'typescript/no-floating-promises': 'error' },
        overrides: [
            {
                files: ['test/**/*.ts'],
                rules: {
                    'typescript/no-explicit-any': 'off',
                    'typescript/no-unsafe-type-assertion': 'off',
                    'no-await-in-loop': 'off',
                },
            },
        ],
    },
    tsconfig: 'test/tsconfig.json',
    test: {
        include: ['test/**/*.test.ts'],
        fileParallelism: false,
        maxWorkers: 1,
        hookTimeout: 300_000,
        testTimeout: 300_000,
    },
})
