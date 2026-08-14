#!/usr/bin/env node

// Fixture Checker for the Cocolang VS Code Extension
//
// Runs the fixtures under test/fixtures/ through the language server and
// asserts on the diagnostics it produces.
//
//   test/fixtures/valid/    every file must produce NO diagnostics
//   test/fixtures/corpus/   whole modules of realistic Coco 0.9.0, one directory
//                           each, that must also produce NO diagnostics — every
//                           one of them compiles cleanly with `coco compile`
//   test/fixtures/invalid/  every `// EXPECT: <text>` comment must be matched by
//                           a diagnostic containing <text>, and there must be no
//                           diagnostics left over
//   test/fixtures/legacy/   same as invalid, but the directory's coco.nut targets
//                           PISA 0.7.1 instead of 0.8.0
//
// Each directory carries its own coco.nut, which is what tells the server which
// PISA version to validate against.
//
// Runs against dist/server.js, so `npm run bundle` has to have run first — this
// exercises the bundle that actually ships, not a separate tsc output.
//
// Usage:
//   node test/feature-check.mjs

import { spawn } from 'child_process';
import { readdir, readFile } from 'fs/promises';
import { join, resolve, dirname, relative } from 'path';
import { pathToFileURL, fileURLToPath } from 'url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(SCRIPT_DIR, 'fixtures');
const SERVER_PATH = resolve(SCRIPT_DIR, '..', 'dist', 'server.js');
const DIAGNOSTIC_TIMEOUT_MS = 5000;

// ──────────────────────────────────────────────
//  Minimal LSP JSON-RPC client over stdio
// ──────────────────────────────────────────────

class LspClient {
	constructor(serverPath) {
		this._nextId = 0;
		this._pending = new Map();
		this._diagnostics = new Map();
		this._waiters = new Map();
		this._buf = Buffer.alloc(0);

		this._proc = spawn('node', [serverPath, '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
		this._proc.stdout.on('data', (chunk) => this._onData(chunk));
		this._proc.stderr.on('data', () => {});
		this._proc.on('error', (err) => console.error('Server process error:', err.message));
	}

	_onData(chunk) {
		this._buf = Buffer.concat([this._buf, chunk]);
		while (this._tryParse()) { /* keep going */ }
	}

	_tryParse() {
		const sep = this._buf.indexOf('\r\n\r\n');
		if (sep === -1) return false;

		const header = this._buf.subarray(0, sep).toString();
		const match = header.match(/Content-Length:\s*(\d+)/i);
		if (!match) {
			this._buf = this._buf.subarray(sep + 4);
			return true;
		}

		const len = parseInt(match[1], 10);
		const start = sep + 4;
		if (this._buf.length < start + len) return false;

		const body = this._buf.subarray(start, start + len).toString();
		this._buf = this._buf.subarray(start + len);
		try {
			this._dispatch(JSON.parse(body));
		} catch { /* ignore malformed */ }
		return true;
	}

	_dispatch(msg) {
		if (msg.id !== undefined && this._pending.has(msg.id)) {
			this._pending.get(msg.id)(msg.result);
			this._pending.delete(msg.id);
			return;
		}
		if (msg.method === 'textDocument/publishDiagnostics') {
			const { uri, diagnostics } = msg.params;
			this._diagnostics.set(uri, diagnostics);
			const waiter = this._waiters.get(uri);
			if (waiter) {
				waiter(diagnostics);
				this._waiters.delete(uri);
			}
		}
	}

	_send(obj) {
		const body = JSON.stringify(obj);
		this._proc.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
	}

	request(method, params) {
		const id = this._nextId++;
		return new Promise((resolve) => {
			this._pending.set(id, resolve);
			this._send({ jsonrpc: '2.0', id, method, params });
		});
	}

	notify(method, params) {
		this._send({ jsonrpc: '2.0', method, params });
	}

	// openAndCollect opens a document and resolves with the diagnostics the
	// server publishes for it. An empty array is a valid result, so a timeout
	// resolves to whatever has arrived (or nothing) rather than hanging.
	openAndCollect(uri, text) {
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this._waiters.delete(uri);
				resolve(this._diagnostics.get(uri) ?? []);
			}, DIAGNOSTIC_TIMEOUT_MS);

			this._waiters.set(uri, (diagnostics) => {
				clearTimeout(timer);
				resolve(diagnostics);
			});

			this.notify('textDocument/didOpen', {
				textDocument: { uri, languageId: 'coco', version: 1, text }
			});
		});
	}

	stop() {
		this._proc.kill();
	}
}

// ──────────────────────────────────────────────
//  Fixture checking
// ──────────────────────────────────────────────

const expectationsIn = (text) =>
	text.split(/\r?\n/)
		.map(line => line.match(/^\s*\/\/\s*EXPECT:\s*(.+?)\s*$/))
		.filter(Boolean)
		.map(match => match[1]);

// collectSources walks a fixture group, descending into the per-module
// subdirectories the corpus group uses.
const collectSources = async (dir) => {
	const sources = [];
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.isDirectory()) {
			sources.push(...await collectSources(join(dir, entry.name)));
		} else if (entry.name.endsWith('.coco')) {
			sources.push(join(dir, entry.name));
		}
	}
	return sources;
};

const checkDirectory = async (client, name, expectDiagnostics) => {
	const dir = join(FIXTURES_DIR, name);
	let entries;
	try {
		entries = (await collectSources(dir)).map(filePath => relative(dir, filePath));
	} catch {
		console.log(`  (no ${name}/ directory, skipping)`);
		return { failures: 0, checked: 0 };
	}

	let failures = 0;
	for (const entry of entries) {
		const filePath = join(dir, entry);
		const text = await readFile(filePath, 'utf8');
		const uri = pathToFileURL(filePath).toString();
		const diagnostics = await client.openAndCollect(uri, text);
		const messages = diagnostics.map(diagnostic => diagnostic.message);
		const expectations = expectDiagnostics ? expectationsIn(text) : [];

		const unmatchedExpectations = [];
		const remaining = [...messages];
		for (const expectation of expectations) {
			const index = remaining.findIndex(message => message.includes(expectation));
			if (index === -1) {
				unmatchedExpectations.push(expectation);
			} else {
				remaining.splice(index, 1);
			}
		}

		if (unmatchedExpectations.length === 0 && remaining.length === 0) {
			console.log(`  \x1b[32m✓\x1b[0m ${name}/${entry}${expectations.length ? ` (${expectations.length})` : ''}`);
			continue;
		}

		failures++;
		console.log(`  \x1b[31m✗\x1b[0m ${name}/${entry}`);
		for (const expectation of unmatchedExpectations) {
			console.log(`      \x1b[31mmissing\x1b[0m  ${expectation}`);
		}
		for (const message of remaining) {
			console.log(`      \x1b[33munexpected\x1b[0m  ${message}`);
		}
	}

	return { failures, checked: entries.length };
};

const main = async () => {
	console.log('Cocolang Extension Fixture Checker');
	console.log('==================================');
	console.log(`Server   : ${SERVER_PATH}`);
	console.log(`Fixtures : ${FIXTURES_DIR}\n`);

	const client = new LspClient(SERVER_PATH);
	await client.request('initialize', { processId: process.pid, rootUri: null, capabilities: {} });
	client.notify('initialized', {});

	let failures = 0;
	let checked = 0;
	for (const [name, expectDiagnostics] of [['valid', false], ['corpus', false], ['invalid', true], ['legacy', true]]) {
		const result = await checkDirectory(client, name, expectDiagnostics);
		failures += result.failures;
		checked += result.checked;
	}

	client.stop();

	console.log('\n────────────────────────────────');
	if (failures === 0) {
		console.log(`\x1b[32mAll ${checked} fixture(s) behaved as expected.\x1b[0m`);
		process.exit(0);
	}
	console.log(`\x1b[31m${failures} of ${checked} fixture(s) failed.\x1b[0m`);
	process.exit(1);
};

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
