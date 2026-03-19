#!/usr/bin/env node

// LSP Diagnostic Checker for Cocolang VS Code Extension
//
// Feeds .coco files through the language server over stdio and reports
// any diagnostics. Since the test files are known-good source from the
// compiler repo, every diagnostic is a likely false-positive (extension bug).
//
// Usage:
//   node test/lsp-check.mjs [path-to-coco-tests]
//
// Default test path: ~/rust/cocolang/tests

import { spawn } from 'child_process';
import { readdir, readFile, stat } from 'fs/promises';
import { join, resolve, extname, dirname } from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { homedir } from 'os';

const TESTS_DIR = resolve(process.argv[2] || join(homedir(), 'rust', 'cocolang', 'tests'));
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = resolve(SCRIPT_DIR, '..', 'server', 'out', 'server.js');
const OPEN_DELAY_MS = 80;
const IDLE_TIMEOUT_MS = 5000;
const GLOBAL_TIMEOUT_MS = 60000;

// ──────────────────────────────────────────────
//  Minimal LSP JSON-RPC client over stdio
// ──────────────────────────────────────────────

class LspClient {
	constructor(serverPath) {
		this._nextId = 0;
		this._pending = new Map();
		this._handlers = new Map();
		this._buf = Buffer.alloc(0);

		this._proc = spawn('node', [serverPath, '--stdio'], {
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		this._proc.stdout.on('data', (chunk) => this._onData(chunk));
		this._proc.stderr.on('data', () => {});
		this._proc.on('error', (err) => {
			console.error('Server process error:', err.message);
		});
	}

	// --- transport ---

	_onData(chunk) {
		this._buf = Buffer.concat([this._buf, chunk]);
		while (this._tryParse()) { /* keep going */ }
	}

	_tryParse() {
		const sep = this._buf.indexOf('\r\n\r\n');
		if (sep === -1) return false;

		const header = this._buf.subarray(0, sep).toString();
		const m = header.match(/Content-Length:\s*(\d+)/i);
		if (!m) {
			this._buf = this._buf.subarray(sep + 4);
			return true;
		}

		const len = parseInt(m[1], 10);
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
			const { resolve } = this._pending.get(msg.id);
			this._pending.delete(msg.id);
			resolve(msg.result ?? msg.error);
		} else if (msg.method) {
			const fns = this._handlers.get(msg.method);
			if (fns) fns.forEach(fn => fn(msg.params));
		}
	}

	_write(msg) {
		const json = JSON.stringify(msg);
		const hdr = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n`;
		this._proc.stdin.write(hdr + json);
	}

	// --- public API ---

	request(method, params) {
		const id = ++this._nextId;
		return new Promise((resolve) => {
			this._pending.set(id, { resolve });
			this._write({ jsonrpc: '2.0', id, method, params });
		});
	}

	notify(method, params) {
		this._write({ jsonrpc: '2.0', method, params });
	}

	on(method, fn) {
		if (!this._handlers.has(method)) this._handlers.set(method, []);
		this._handlers.get(method).push(fn);
	}

	async shutdown() {
		try {
			await this.request('shutdown', null);
			this.notify('exit', null);
		} catch { /* best-effort */ }
		this._proc.kill();
	}
}

// ──────────────────────────────────────────────
//  File collection
// ──────────────────────────────────────────────

async function collectCocoFiles(dir) {
	const results = [];
	const entries = await readdir(dir, { withFileTypes: true });
	for (const e of entries) {
		const full = join(dir, e.name);
		if (e.isDirectory()) {
			results.push(...await collectCocoFiles(full));
		} else if (extname(e.name).toLowerCase() === '.coco') {
			results.push(full);
		}
	}
	return results.sort();
}

// ──────────────────────────────────────────────
//  Main
// ──────────────────────────────────────────────

async function main() {
	// Verify prerequisites
	try { await stat(SERVER_PATH); } catch {
		console.error(`Server not found: ${SERVER_PATH}`);
		console.error('Run "npm run compile" first.');
		process.exit(1);
	}

	const cocoFiles = await collectCocoFiles(TESTS_DIR);
	if (cocoFiles.length === 0) {
		console.error(`No .coco files found in ${TESTS_DIR}`);
		process.exit(1);
	}

	console.log('Cocolang LSP Diagnostic Checker');
	console.log('================================');
	console.log(`Server : ${SERVER_PATH}`);
	console.log(`Tests  : ${TESTS_DIR}`);
	console.log(`Files  : ${cocoFiles.length}`);
	console.log();

	const client = new LspClient(SERVER_PATH);

	// Diagnostics bookkeeping
	const diagnosticsMap = new Map();   // uri -> Diagnostic[]
	const receivedUris = new Set();
	const expectedUris = new Set();

	let idleTimer = null;
	let resolveAll;
	const allReceived = new Promise(r => { resolveAll = r; });

	const resetIdle = () => {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = setTimeout(() => resolveAll(), IDLE_TIMEOUT_MS);
	};

	client.on('textDocument/publishDiagnostics', ({ uri, diagnostics }) => {
		receivedUris.add(uri);
		if (diagnostics.length > 0) {
			diagnosticsMap.set(uri, diagnostics);
		}
		// Resolve when we have all, or reset idle timer
		if (receivedUris.size >= expectedUris.size) {
			resolveAll();
		} else {
			resetIdle();
		}
	});

	// LSP initialize handshake
	await client.request('initialize', {
		processId: process.pid,
		rootUri: pathToFileURL(TESTS_DIR).toString(),
		capabilities: {
			textDocument: {
				publishDiagnostics: { relatedInformation: true },
			},
		},
		workspaceFolders: null,
	});
	client.notify('initialized', {});

	// Open every .coco file
	process.stdout.write('Checking ');
	let version = 1;
	for (const filePath of cocoFiles) {
		const uri = pathToFileURL(filePath).toString();
		expectedUris.add(uri);
		const text = await readFile(filePath, 'utf8');

		client.notify('textDocument/didOpen', {
			textDocument: { uri, languageId: 'coco', version: version++, text },
		});

		process.stdout.write('.');
		await new Promise(r => setTimeout(r, OPEN_DELAY_MS));
	}
	console.log(' done\n');

	// Start the idle timer after the last file is opened
	resetIdle();

	// Also set an absolute timeout
	const globalTimeout = setTimeout(() => {
		console.log(`\nGlobal timeout (${GLOBAL_TIMEOUT_MS / 1000}s). ` +
			`Received ${receivedUris.size}/${expectedUris.size} responses.`);
		resolveAll();
	}, GLOBAL_TIMEOUT_MS);

	await allReceived;
	clearTimeout(globalTimeout);
	if (idleTimer) clearTimeout(idleTimer);

	// ── Report ──
	const missing = [...expectedUris].filter(u => !receivedUris.has(u));

	if (diagnosticsMap.size === 0) {
		console.log('All clean — no diagnostics reported for any file.');
	} else {
		let total = 0;
		const sorted = [...diagnosticsMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));

		for (const [uri, diags] of sorted) {
			const rel = fileURLToPath(uri).replace(TESTS_DIR + '/', '');
			console.log(`${rel}  (${diags.length}):`);
			for (const d of diags) {
				const ln = d.range.start.line + 1;
				const col = d.range.start.character + 1;
				const sev = d.severity === 1 ? 'ERR' : d.severity === 2 ? 'WRN' : 'INF';
				console.log(`  L${ln}:${col} [${sev}] ${d.message}`);
				total++;
			}
			console.log();
		}

		console.log('────────────────────────────────');
		console.log(`${diagnosticsMap.size} file(s) with diagnostics, ${total} total`);
		console.log('These are likely false positives (extension bugs).');
	}

	if (missing.length > 0) {
		console.log(`\nNote: ${missing.length} file(s) did not return diagnostics (server may have skipped them).`);
	}

	console.log(`\nChecked ${receivedUris.size}/${cocoFiles.length} files.`);
	await client.shutdown();
}

main().catch(err => {
	console.error('Fatal:', err);
	process.exit(1);
});
