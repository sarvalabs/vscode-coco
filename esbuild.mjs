#!/usr/bin/env node

// Bundler for the extension.
//
// Produces the two files the .vsix actually ships:
//
//   dist/extension.js   the client, loaded by VS Code (`main` in package.json)
//   dist/server.js      the language server, spawned by the client over IPC
//
// Everything the two import — the vscode-languageclient / vscode-languageserver
// libraries and their dependencies — is inlined, so the package carries no
// node_modules at all. `vscode` itself is the exception: it is provided by the
// extension host at runtime and must stay external.
//
// Type checking is a separate step (`npm run typecheck`); esbuild only transpiles.
//
// Usage:
//   node esbuild.mjs [--production] [--watch]

import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// Reports failures in a form VS Code's $esbuild-watch problem matcher understands.
const problemReporter = {
	name: 'problem-reporter',
	setup(build) {
		build.onStart(() => {
			if (watch) {
				console.log('[watch] build started');
			}
		});
		build.onEnd((result) => {
			for (const { text, location } of result.errors) {
				console.error(`✘ [ERROR] ${text}`);
				if (location) {
					console.error(`    ${location.file}:${location.line}:${location.column}:`);
				}
			}
			if (watch) {
				console.log('[watch] build finished');
			}
		});
	}
};

/** @type {import('esbuild').BuildOptions} */
const shared = {
	bundle: true,
	format: 'cjs',
	platform: 'node',
	// VS Code 1.91 embeds Node 20.
	target: 'node20',
	minify: production,
	sourcemap: !production,
	sourcesContent: false,
	logLevel: 'silent',
	plugins: [problemReporter]
};

const builds = [
	{ ...shared, entryPoints: ['client/src/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] },
	{ ...shared, entryPoints: ['server/src/server.ts'], outfile: 'dist/server.js', external: ['vscode'] }
];

const main = async () => {
	if (watch) {
		const contexts = await Promise.all(builds.map(options => esbuild.context(options)));
		await Promise.all(contexts.map(context => context.watch()));
		return;
	}

	await Promise.all(builds.map(options => esbuild.build(options)));
	console.log(`Bundled dist/extension.js and dist/server.js${production ? ' (production)' : ''}.`);
};

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
