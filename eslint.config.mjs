import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
	{
		// Build output, dependencies and packaged artifacts are never linted.
		ignores: [
			'**/node_modules/**',
			'dist/**',
			'**/*.vsix',
			'**/*.tsbuildinfo'
		]
	},

	// The extension itself: client and server TypeScript.
	{
		files: ['client/src/**/*.ts', 'server/src/**/*.ts'],
		extends: [js.configs.recommended, ...tseslint.configs.recommended],
		languageOptions: {
			parserOptions: {
				project: './tsconfig.json',
				tsconfigRootDir: import.meta.dirname
			},
			globals: {
				...globals.node
			}
		},
		rules: {
			// The language server is written as `const fn = (...) => {...}`
			// throughout, with explicit return types on anything non-obvious.
			'@typescript-eslint/explicit-module-boundary-types': 'off',
			'@typescript-eslint/no-explicit-any': 'error',
			'@typescript-eslint/no-unused-vars': ['error', {
				argsIgnorePattern: '^_',
				varsIgnorePattern: '^_'
			}],
			eqeqeq: ['error', 'always'],
			'no-var': 'error',
			'prefer-const': 'error',
			curly: 'error',
			semi: ['error', 'always'],
			'no-throw-literal': 'error'
		}
	},

	// The test harnesses are dependency-free Node ESM that talk LSP over stdio.
	{
		files: ['test/**/*.mjs'],
		extends: [js.configs.recommended],
		languageOptions: {
			ecmaVersion: 2022,
			sourceType: 'module',
			globals: {
				...globals.node
			}
		},
		rules: {
			eqeqeq: ['error', 'always'],
			'no-var': 'error',
			'prefer-const': 'error',
			curly: ['error', 'multi-line'],
			semi: ['error', 'always']
		}
	}
);
