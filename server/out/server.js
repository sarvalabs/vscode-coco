"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_1 = require("vscode-languageserver/node");
const completion_1 = require("./modules/completion");
const vscode_languageserver_textdocument_1 = require("vscode-languageserver-textdocument");
// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = (0, node_1.createConnection)(node_1.ProposedFeatures.all);
// Create a simple text document manager.
const documents = new node_1.TextDocuments(vscode_languageserver_textdocument_1.TextDocument);
let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;
connection.onInitialize((params) => {
    const capabilities = params.capabilities;
    // Does the client support the `workspace/configuration` request?
    // If not, we fall back using global settings.
    hasConfigurationCapability = !!(capabilities.workspace && !!capabilities.workspace.configuration);
    hasWorkspaceFolderCapability = !!(capabilities.workspace && !!capabilities.workspace.workspaceFolders);
    hasDiagnosticRelatedInformationCapability = !!(capabilities.textDocument &&
        capabilities.textDocument.publishDiagnostics &&
        capabilities.textDocument.publishDiagnostics.relatedInformation);
    const result = {
        capabilities: {
            textDocumentSync: node_1.TextDocumentSyncKind.Incremental,
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
        connection.client.register(node_1.DidChangeConfigurationNotification.type, undefined);
    }
    if (hasWorkspaceFolderCapability) {
        connection.workspace.onDidChangeWorkspaceFolders(_event => {
            connection.console.log('Workspace folder change event received.');
        });
    }
});
// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings = { maxNumberOfProblems: 1000 };
let globalSettings = defaultSettings;
// Cache the settings of all open documents
const documentSettings = new Map();
connection.onDidChangeConfiguration(change => {
    if (hasConfigurationCapability) {
        // Reset all cached document settings
        documentSettings.clear();
    }
    else {
        globalSettings = ((change.settings.languageServerExample || defaultSettings));
    }
    // Revalidate all open text documents
    documents.all().forEach(validateTextDocument);
});
function getDocumentSettings(resource) {
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
async function validateTextDocument(textDocument) {
    const settings = await getDocumentSettings(textDocument.uri);
    const text = textDocument.getText();
    const lines = text.split(/\r?\n/);
    const diagnostics = [];
    const endpointPattern = /^\s*(endpoint|func)\s+(\w+)\s*(\w+)(!)?\s*\([^)]*\):\s*$/;
    const mutatePattern = /^\s*mutate\s*(.*)?$/;
    const statefulFuncPattern = /^\s*(\w+)!\(([^)]*)\)$/;
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
                const diagnostic = {
                    severity: node_1.DiagnosticSeverity.Error,
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
connection.onCompletion((_textDocumentPosition) => {
    // The pass parameter contains the position of the text document in
    // which code complete got requested. For the example we ignore this
    // info and always provide the same completion items.
    return (0, completion_1.completionItems)();
});
// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve((item) => {
    return (0, completion_1.completionDetails)(item);
});
// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);
// Listen on the connection
connection.listen();
function findMatchingBrace(text, startIndex) {
    let openBraces = 1;
    for (let i = startIndex; i < text.length; i++) {
        if (text[i] === '{') {
            openBraces++;
        }
        else if (text[i] === '}') {
            openBraces--;
            if (openBraces === 0) {
                return i + 1;
            }
        }
    }
    return -1;
}
function containsMutateStatement(text) {
    const lines = text.split('\n');
    for (const line of lines) {
        if (line.trim().startsWith('mutate ')) {
            return true;
        }
    }
    return false;
}
//# sourceMappingURL=server.js.map