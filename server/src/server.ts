
import {
	createConnection,
	TextDocuments,
	Diagnostic,
	DiagnosticSeverity,
	ProposedFeatures,
	InitializeParams,
	DidChangeConfigurationNotification,
	CompletionItem,
	CompletionItemKind,
	TextDocumentPositionParams,
	TextDocumentSyncKind,
	InitializeResult
} from 'vscode-languageserver/node';

import { completionItems, completionDetails } from './modules/completion';
import {
	TextDocument
} from 'vscode-languageserver-textdocument';

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;

connection.onInitialize((params: InitializeParams) => {
	const capabilities = params.capabilities;

	// Does the client support the `workspace/configuration` request?
	// If not, we fall back using global settings.
	hasConfigurationCapability = !!(
		capabilities.workspace && !!capabilities.workspace.configuration
	);
	hasWorkspaceFolderCapability = !!(
		capabilities.workspace && !!capabilities.workspace.workspaceFolders
	);
	hasDiagnosticRelatedInformationCapability = !!(
		capabilities.textDocument &&
		capabilities.textDocument.publishDiagnostics &&
		capabilities.textDocument.publishDiagnostics.relatedInformation
	);

	const result: InitializeResult = {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			// Tell the client that this server supports code completion.
			completionProvider: {
				resolveProvider: true
			}
		}
	};
	if (hasWorkspaceFolderCapability) {
		result.capabilities.workspace = {
			workspaceFolders: {
				supported: true
			}
		};
	}
	return result;
});

connection.onInitialized(() => {
	if (hasConfigurationCapability) {
		// Register for all configuration changes.
		connection.client.register(DidChangeConfigurationNotification.type, undefined);
	}
	if (hasWorkspaceFolderCapability) {
		connection.workspace.onDidChangeWorkspaceFolders(_event => {
			connection.console.log('Workspace folder change event received.');
		});
	}
});

// The example settings
interface ExampleSettings {
	maxNumberOfProblems: number;
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: ExampleSettings = { maxNumberOfProblems: 1000 };
let globalSettings: ExampleSettings = defaultSettings;

// Cache the settings of all open documents
const documentSettings: Map<string, Thenable<ExampleSettings>> = new Map();

connection.onDidChangeConfiguration(change => {
	if (hasConfigurationCapability) {
		// Reset all cached document settings
		documentSettings.clear();
	} else {
		globalSettings = <ExampleSettings>(
			(change.settings.languageServerExample || defaultSettings)
		);
	}

	// Revalidate all open text documents
	documents.all().forEach(validateTextDocument);
});

function getDocumentSettings(resource: string): Thenable<ExampleSettings> {
	if (!hasConfigurationCapability) {
		return Promise.resolve(globalSettings);
	}
	let result = documentSettings.get(resource);
	if (!result) {
		result = connection.workspace.getConfiguration({
			scopeUri: resource,
			section: 'cocolangServer'
		});
		documentSettings.set(resource, result);
	}
	return result;
}


// Only keep settings for open documents
documents.onDidClose(e => {
	documentSettings.delete(e.document.uri);
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(change => {
	validateTextDocument(change.document);
});

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
	const settings = await getDocumentSettings(textDocument.uri);

	const text = textDocument.getText();
	const lines = text.split(/\r?\n/);
	const diagnostics: Diagnostic[] = [];

	const endpointPattern = /^\s*(endpoint|func)\s+(\w+)\s*(\w+)(!)?\s*\([^)]*\):\s*$/;
	const mutatePattern = /^\s*mutate\s*(.*)?$/;
	const statefulFuncPattern = /^\s*(\w+)!\(([^)]*)\)$/

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex];

		const endpointMatch = line.match(endpointPattern);
		if (endpointMatch) {
			const endpointName = endpointMatch[1];
			const action = endpointMatch[2];
			const hasExclamation = !!endpointMatch[4]; // Check if '!' is present
			let hasMutateKeyword = false;
			let hasStatefulFunc = false;
			// Check for 'mutate' keyword after the endpoint declaration
			for (let bodyLineIndex = lineIndex + 1; bodyLineIndex < lines.length; bodyLineIndex++) {
				const bodyLine = lines[bodyLineIndex];
				if (!(/^\s*$/.test(bodyLine))) { // Skip empty lines
					if (bodyLine.match(mutatePattern)) {
						hasMutateKeyword = true;
					}
					if (bodyLine.match(statefulFuncPattern)) {
						hasStatefulFunc = true;
					}
				}
			}

			if ((hasMutateKeyword || hasStatefulFunc) && !hasExclamation) {
				const diagnostic: Diagnostic = {
					severity: DiagnosticSeverity.Error,
					range: {
						start: { line: lineIndex, character: 0 },
						end: { line: lineIndex, character: line.length }
					},
					message: `'${endpointName}' is missing the '!' staeful identifier while performing state modifications`,
					source: 'ex'
				};
				diagnostics.push(diagnostic);
				}

		}
	}

	connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

connection.onDidChangeWatchedFiles(_change => {
	// Monitored files have change in VSCode
	connection.console.log('We received an file change event');
});

// This handler provides the initial list of the completion items.
connection.onCompletion(
	(_textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
		// The pass parameter contains the position of the text document in
		// which code complete got requested. For the example we ignore this
		// info and always provide the same completion items.
		return completionItems();
	}
);

// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve(
	(item: CompletionItem): CompletionItem => {
		return completionDetails(item);
	}
);

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();

function findMatchingBrace(text: string, startIndex: number): number {
	let openBraces = 1;
	for (let i = startIndex; i < text.length; i++) {
		if (text[i] === '{') {
			openBraces++;
		} else if (text[i] === '}') {
			openBraces--;
			if (openBraces === 0) {
				return i + 1;
			}
		}
	}
	return -1;
}

function containsMutateStatement(text: string): boolean {
	const lines = text.split('\n');
	for (const line of lines) {
		if (line.trim().startsWith('mutate ')) {
			return true;
		}
	}
	return false;
}
