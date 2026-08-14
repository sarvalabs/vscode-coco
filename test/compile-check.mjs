#!/usr/bin/env node

// Compiler Cross-Check for the Cocolang VS Code Extension
//
// The language server re-implements a slice of the Coco compiler's checks by
// hand, so the fixtures it is expected to stay silent on had better be sources
// the compiler actually accepts. This runs `coco compile` in every fixture
// directory that is supposed to build, and fails if any of them does not.
//
// Pair it with `npm test`: together they say "these modules compile, and the
// language server reports nothing about them".
//
// Requires the `coco` binary on PATH. Without it the script skips, so it can sit
// in a pipeline that does not install the toolchain.
//
// Usage:
//   node test/compile-check.mjs

import { spawn } from 'child_process';
import { readdir, access } from 'fs/promises';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(SCRIPT_DIR, 'fixtures');
const REPO_DIR = join(SCRIPT_DIR, '..');

// Groups whose modules must compile. `invalid` and `legacy` are deliberately
// broken, so they are not built here.
const BUILDABLE_GROUPS = ['valid', 'corpus'];

const run = (command, args, cwd) => new Promise((resolve) => {
	const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
	let output = '';
	child.stdout.on('data', (chunk) => { output += chunk; });
	child.stderr.on('data', (chunk) => { output += chunk; });
	child.on('error', () => resolve({ code: -1, output: `failed to run ${command}` }));
	child.on('close', (code) => resolve({ code, output }));
});

// findProjects returns every directory under `dir` that carries a coco.nut.
const findProjects = async (dir) => {
	const projects = [];
	try {
		await access(join(dir, 'coco.nut'));
		projects.push(dir);
	} catch { /* not a project root itself */ }

	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return projects;
	}

	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.isDirectory()) {
			projects.push(...await findProjects(join(dir, entry.name)));
		}
	}
	return projects;
};

const main = async () => {
	console.log('Cocolang Fixture Compiler Cross-Check');
	console.log('=====================================');

	const version = await run('coco', ['version'], REPO_DIR);
	if (version.code !== 0) {
		console.log('`coco` is not on PATH — skipping the compiler cross-check.');
		process.exit(0);
	}
	const versionLines = version.output.split('\n').filter(line => /^(build|PISA|Coco) /.test(line));
	console.log(versionLines.join('\n') || 'coco (version unknown)');
	console.log();

	let failures = 0;
	let checked = 0;
	for (const group of BUILDABLE_GROUPS) {
		for (const project of await findProjects(join(FIXTURES_DIR, group))) {
			const label = relative(FIXTURES_DIR, project);
			const result = await run('coco', ['compile', '.'], project);
			checked++;
			if (result.code === 0) {
				console.log(`  \x1b[32m✓\x1b[0m ${label}`);
				continue;
			}
			failures++;
			console.log(`  \x1b[31m✗\x1b[0m ${label}`);
			for (const line of result.output.split('\n')) {
				if (/ERROR/.test(line)) {
					console.log(`      ${line.replace(/^[0-9-]+ [0-9:]+ /, '')}`);
				}
			}
		}
	}

	console.log('\n────────────────────────────────');
	if (failures === 0) {
		console.log(`\x1b[32mAll ${checked} fixture project(s) compile.\x1b[0m`);
		process.exit(0);
	}
	console.log(`\x1b[31m${failures} of ${checked} fixture project(s) failed to compile.\x1b[0m`);
	process.exit(1);
};

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
