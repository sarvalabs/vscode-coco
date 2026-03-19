import {
	createConnection,
	TextDocuments,
	Diagnostic,
	DiagnosticSeverity,
	ProposedFeatures,
	InitializeParams,
	DidChangeConfigurationNotification,
	CompletionItem,
	TextDocumentPositionParams,
	TextDocumentSyncKind,
	InitializeResult,
	Location,
	Range,
	SemanticTokens,
	SemanticTokensBuilder,
	SemanticTokensLegend
} from 'vscode-languageserver/node';
import * as path from 'path';
import * as fs from 'fs/promises';
import { fileURLToPath, pathToFileURL } from 'url';
import { completionItems, completionDetails } from './modules/completion';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { checkMutation, checkNames, getCallableTypeMap, getCollections, statefulValidation } from './modules/validation';

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
			},
			definitionProvider: true,
			semanticTokensProvider: {
				legend: semanticTokensLegend,
				full: true
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

// Coco configuration settings to be implemented
interface CocoSettings {
}

// Cache the settings of all open documents
const documentSettings: Map<string, Thenable<CocoSettings>> = new Map();



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

	const text = textDocument.getText();
	const diagnostics: Diagnostic[] = [];
	const callableTypeMap = getCallableTypeMap(text);
	const persistentCollections = getCollections(text);
	const moduleContext = await buildModuleContext(textDocument.uri, text);
	const analysisIndexes = buildModuleAnalysisIndexes(moduleContext);
	const classIndex = analysisIndexes.classIndex;
	const eventIndex = analysisIndexes.eventIndex;
	const interfaceIndex = analysisIndexes.interfaceIndex;
	const interfaceStateIndex = analysisIndexes.interfaceStateIndex;
	const stateIndex = analysisIndexes.stateIndex;

	statefulValidation(text, diagnostics, callableTypeMap);
	checkMutation(text, diagnostics, persistentCollections)
	checkNames(text, diagnostics);
	checkTypeLiteralProperties(text, classIndex, eventIndex, diagnostics);
	checkUndefinedVariables(text, classIndex, eventIndex, interfaceIndex, stateIndex, diagnostics);
	checkStateFieldReferences(text, stateIndex, interfaceStateIndex, diagnostics);
	checkFieldAccess(text, classIndex, diagnostics);
	checkFStringChunks(text, classIndex, diagnostics);
	checkStandardFunctionTypes(text, classIndex, diagnostics);
	checkEmitTypes(text, classIndex, eventIndex, diagnostics);
	checkArrayFunctionTypes(text, diagnostics);
	checkAssetMethodCalls(text, diagnostics);
	const diagnosticSource = path.basename(new URL(textDocument.uri).pathname);
	for (const diagnostic of diagnostics) {
		diagnostic.source = diagnosticSource;
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
		// which code complete got requested.
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

connection.onDefinition(async (params: TextDocumentPositionParams) => {
	const document = documents.get(params.textDocument.uri);
	if (!document) {
		return [];
	}

	const text = document.getText();
	const moduleContext = await buildModuleContext(params.textDocument.uri, text);
	const moduleSymbols = buildModuleSymbols(moduleContext);
	const interfaceIndex = moduleSymbols.interfaceIndex;
	const classIndex = moduleSymbols.classIndex;
	const eventIndex = moduleSymbols.eventIndex;
	const callableIndex = buildCallableIndex(text);
	const memberCall = getMemberCallAtPosition(document, params.position);
	if (memberCall) {
		const receiverType = findTypeForReceiver(text, memberCall.receiver, params.position.line, callableIndex);
		if (receiverType) {
			const iface = interfaceIndex.interfaces.get(receiverType);
			const ifaceMember = iface?.members.get(memberCall.member);
			if (ifaceMember) {
				const range = Range.create(
					ifaceMember.range.start,
					ifaceMember.range.end
				);
				return ifaceMember;
			}

			const klass = classIndex.classes.get(receiverType);
			const method = klass?.methods.get(memberCall.member) ?? klass?.fields.get(memberCall.member);
			if (method) {
				return method;
			}
		}
	}

	const classLiteralProperty = getClassLiteralPropertyAtPosition(document, params.position);
	if (classLiteralProperty) {
		const klass = classIndex.classes.get(classLiteralProperty.typeName);
		const field = klass?.fields.get(classLiteralProperty.property);
		if (field) {
			return field;
		}

		const event = eventIndex.events.get(classLiteralProperty.typeName);
		const eventMember = event?.fields.get(classLiteralProperty.property) ?? event?.topics.get(classLiteralProperty.property);
		if (eventMember) {
			return eventMember;
		}
	}

	const callArgument = getCallArgumentAtPosition(document, params.position);
	if (callArgument) {
	const callee = moduleSymbols.callables.callables.get(callArgument.callee);
		const paramDefinition = callee?.params.get(callArgument.argument);
		if (paramDefinition) {
			return paramDefinition;
		}
	}

	const callCallee = getCallCalleeAtPosition(document, params.position);
	if (callCallee) {
		const definition = findDefinition(text, callCallee);
		if (definition) {
			const range = Range.create(
				{ line: definition.line, character: definition.character },
				{ line: definition.line, character: definition.character + callCallee.length }
			);
			return Location.create(document.uri, range);
		}
	}

	const target = getWordAtPosition(document, params.position);
	if (!target) {
		return [];
	}

	const interfaceDefinition = interfaceIndex.interfaces.get(target)?.definition;
	if (interfaceDefinition) {
		return interfaceDefinition;
	}

	const classDefinition = classIndex.classes.get(target)?.definition;
	if (classDefinition) {
		return classDefinition;
	}

	const eventDefinition = eventIndex.events.get(target)?.definition;
	if (eventDefinition) {
		return eventDefinition;
	}

	const variableDefinition = findVariableDefinition(text, target, params.position.line, callableIndex);
	if (variableDefinition) {
		const range = Range.create(
			{ line: variableDefinition.line, character: variableDefinition.character },
			{ line: variableDefinition.line, character: variableDefinition.character + target.length }
		);
		return Location.create(document.uri, range);
	}

	const definition = findDefinition(text, target);
	if (definition) {
		const range = Range.create(
			{ line: definition.line, character: definition.character },
			{ line: definition.line, character: definition.character + target.length }
		);
		return Location.create(document.uri, range);
	}

	const moduleCallable = moduleSymbols.callables.callables.get(target);
	if (moduleCallable) {
		return moduleCallable.definition;
	}

	return [];
});

connection.languages.semanticTokens.on(async (params): Promise<SemanticTokens> => {
	const document = documents.get(params.textDocument.uri);
	if (!document) {
		return { data: [] };
	}

	const moduleContext = await buildModuleContext(params.textDocument.uri, document.getText());
	const analysisIndexes = buildModuleAnalysisIndexes(moduleContext);
	return buildSemanticTokens(document, analysisIndexes);
});

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();

const semanticTokenTypes = ["variable", "parameter", "function", "type", "property"];
const semanticTokensLegend: SemanticTokensLegend = {
	tokenTypes: semanticTokenTypes,
	tokenModifiers: []
};

const builtinTypeNames = new Set<string>([
	"String",
	"Identifier",
	"Bool",
	"Bytes",
	"Ptr",
	"U64",
	"U256",
	"I64",
	"I256",
	"Map"
]);

const getWordAtPosition = (document: TextDocument, position: { line: number; character: number }): string | null => {
	const range = getWordRangeAtPosition(document, position);
	return range ? range.word : null;
};

const getWordRangeAtPosition = (
	document: TextDocument,
	position: { line: number; character: number }
): { word: string; start: number; end: number } | null => {
	const text = document.getText();
	const offset = document.offsetAt(position);
	let start = offset;
	let end = offset;

	while (start > 0 && isWordChar(text.charAt(start - 1))) {
		start -= 1;
	}

	while (end < text.length && isWordChar(text.charAt(end))) {
		end += 1;
	}

	if (start === end) {
		return null;
	}

	return { word: text.slice(start, end), start, end };
};

const isWordChar = (value: string): boolean => {
	return /[A-Za-z0-9_]/.test(value);
};

const skipWhitespaceForward = (text: string, index: number): number => {
	for (let i = index; i < text.length; i++) {
		if (!/\s/.test(text[i])) {
			return i;
		}
	}
	return -1;
};

const skipWhitespaceBackward = (text: string, index: number): number => {
	for (let i = index; i >= 0; i--) {
		if (!/\s/.test(text[i])) {
			return i;
		}
	}
	return -1;
};

const getCallArgumentAtPosition = (
	document: TextDocument,
	position: { line: number; character: number }
): { callee: string; argument: string } | null => {
	const lineText = document.getText({
		start: { line: position.line, character: 0 },
		end: { line: position.line, character: Number.MAX_SAFE_INTEGER }
	});

	const call = findCallAtPosition(lineText, position.character);
	if (!call) {
		return null;
	}

	const argumentName = getArgumentNameAtPosition(call.argsText, call.argsStart, position.character);
	if (!argumentName) {
		return null;
	}

	return { callee: call.callee, argument: argumentName };
};

const getCallCalleeAtPosition = (
	document: TextDocument,
	position: { line: number; character: number }
): string | null => {
	const lineText = document.getText({
		start: { line: position.line, character: 0 },
		end: { line: position.line, character: Number.MAX_SAFE_INTEGER }
	});

	const wordRange = getWordRangeInLine(lineText, position.character);
	if (!wordRange) {
		return null;
	}

	const { word, start, end } = wordRange;
	const nextIndex = skipWhitespaceForward(lineText, end);
	if (nextIndex >= 0 && lineText[nextIndex] === "(") {
		const prevIndex = skipWhitespaceBackward(lineText, start - 1);
		if (prevIndex >= 0 && lineText[prevIndex] === ".") {
			return null;
		}
		return word;
	}

	return null;
};

const getWordRangeInLine = (
	lineText: string,
	character: number
): { word: string; start: number; end: number } | null => {
	let start = character;
	let end = character;

	while (start > 0 && isWordChar(lineText.charAt(start - 1))) {
		start -= 1;
	}

	while (end < lineText.length && isWordChar(lineText.charAt(end))) {
		end += 1;
	}

	if (start === end) {
		return null;
	}

	return { word: lineText.slice(start, end), start, end };
};

const getClassLiteralPropertyAtPosition = (
	document: TextDocument,
	position: { line: number; character: number }
): { typeName: string; property: string } | null => {
	const lineText = document.getText({
		start: { line: position.line, character: 0 },
		end: { line: position.line, character: Number.MAX_SAFE_INTEGER }
	});

	for (const literal of findTypeLiteralCandidates(lineText)) {
		if (position.character < literal.braceStart || position.character > literal.braceEnd) {
			continue;
		}
		const property = getPropertyNameAtPosition(literal.bodyText, literal.bodyStart, position.character);
		if (property) {
			return { typeName: literal.typeName, property };
		}
	}

	return null;
};

const getMemberCallAtPosition = (
	document: TextDocument,
	position: { line: number; character: number }
): { receiver: string; member: string } | null => {
	const lineText = document.getText({
		start: { line: position.line, character: 0 },
		end: { line: position.line, character: Number.MAX_SAFE_INTEGER }
	});
	const matches = lineText.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)/g);

	for (const match of matches) {
		const matchIndex = match.index ?? -1;
		if (matchIndex < 0) {
			continue;
		}
		const receiver = match[1];
		const member = match[2];
		const memberStart = matchIndex + receiver.length + 1;
		const memberEnd = memberStart + member.length;
		if (position.character >= memberStart && position.character <= memberEnd) {
			return { receiver, member };
		}
	}

	return null;
};

type DefinitionLocation = { line: number; character: number };
type InterfaceIndex = {
	interfaces: Map<string, { definition: DefinitionLocation; members: Map<string, DefinitionLocation> }>;
};

type ClassIndex = {
	classes: Map<string, { definition: DefinitionLocation; fields: Map<string, DefinitionLocation>; methods: Map<string, DefinitionLocation>; fieldTypes: Map<string, { typeName: string; isCollection: boolean }> }>;
};

type EventIndex = {
	events: Map<string, { definition: DefinitionLocation; fields: Map<string, DefinitionLocation>; topics: Map<string, DefinitionLocation> }>;
};

type LocatedInterfaceIndex = {
	interfaces: Map<string, { definition: Location; members: Map<string, Location> }>;
};

type LocatedClassIndex = {
	classes: Map<string, { definition: Location; fields: Map<string, Location>; methods: Map<string, Location> }>;
};

type LocatedEventIndex = {
	events: Map<string, { definition: Location; fields: Map<string, Location>; topics: Map<string, Location> }>;
};

type StateIndex = {
	moduleName: string | null;
	logicFields: Set<string>;
	actorFields: Set<string>;
};

type InterfaceStateIndex = {
	interfaces: Map<string, { logicFields: Set<string>; actorFields: Set<string> }>;
};

type CallableIndex = {
	callables: Map<string, { definition: DefinitionLocation; params: Map<string, DefinitionLocation>; returns: Map<string, DefinitionLocation> }>;
	callableRanges: Array<{ name: string; line: number; indent: number }>;
};

type LocatedCallableIndex = {
	callables: Map<string, { definition: Location; params: Map<string, Location>; returns: Map<string, Location> }>;
};

type ModuleContext = {
	moduleName: string | null;
	files: Array<{ uri: string; text: string }>;
};

type ModuleSymbols = {
	classIndex: LocatedClassIndex;
	eventIndex: LocatedEventIndex;
	interfaceIndex: LocatedInterfaceIndex;
	callables: LocatedCallableIndex;
};

const buildInterfaceIndex = (text: string): InterfaceIndex => {
	const lines = text.split(/\r?\n/);
	const interfaces = new Map<string, { definition: DefinitionLocation; members: Map<string, DefinitionLocation> }>();

	const interfacePattern = /^\s*interface\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*$/;
	const interfaceSectionPattern = /^\s*(endpoint|asset)\s*:\s*$/;
	const interfaceMemberPattern = /^\s*(?:(dynamic|static|pure)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/;

	let inInterface = false;
	let interfaceIndent = 0;
	let currentInterface: string | null = null;
	let currentSectionIndent = 0;
	let inInterfaceSection = false;

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex];
		const lineIndent = line.match(/^\s*/)?.[0].length ?? 0;
		const isBlank = line.trim().length === 0;

		const interfaceMatch = line.match(interfacePattern);
		if (interfaceMatch) {
			const name = interfaceMatch[1];
			const nameIndex = line.indexOf(name, interfaceMatch.index ?? 0);
			interfaces.set(name, {
				definition: { line: lineIndex, character: nameIndex },
				members: new Map()
			});
			inInterface = true;
			interfaceIndent = lineIndent;
			currentInterface = name;
			inInterfaceSection = false;
			continue;
		}

		if (inInterface && !isBlank && lineIndent <= interfaceIndent) {
			inInterface = false;
			currentInterface = null;
			inInterfaceSection = false;
		}

		if (!inInterface || !currentInterface) {
			continue;
		}

		const sectionMatch = line.match(interfaceSectionPattern);
		if (sectionMatch) {
			inInterfaceSection = true;
			currentSectionIndent = lineIndent;
			continue;
		}

		if (inInterfaceSection && !isBlank && lineIndent <= currentSectionIndent) {
			inInterfaceSection = false;
		}

		if (inInterfaceSection && lineIndent > currentSectionIndent) {
			const memberMatch = line.match(interfaceMemberPattern);
			if (memberMatch) {
				const memberName = memberMatch[2];
				const memberIndex = line.indexOf(memberName, memberMatch.index ?? 0);
				interfaces.get(currentInterface)?.members.set(memberName, {
					line: lineIndex,
					character: memberIndex
				});
			}
		}
	}

	return { interfaces };
};

const buildLocatedInterfaceIndex = (text: string, uri: string): LocatedInterfaceIndex => {
	const lines = text.split(/\r?\n/);
	const interfaces = new Map<string, { definition: Location; members: Map<string, Location> }>();

	const interfacePattern = /^\s*interface\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*$/;
	const interfaceSectionPattern = /^\s*(endpoint|asset)\s*:\s*$/;
	const interfaceMemberPattern = /^\s*(?:(dynamic|static|pure)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/;

	let inInterface = false;
	let interfaceIndent = 0;
	let currentInterface: string | null = null;
	let currentSectionIndent = 0;
	let inInterfaceSection = false;

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex];
		const lineIndent = line.match(/^\s*/)?.[0].length ?? 0;
		const isBlank = line.trim().length === 0;

		const interfaceMatch = line.match(interfacePattern);
		if (interfaceMatch) {
			const name = interfaceMatch[1];
			const nameIndex = line.indexOf(name, interfaceMatch.index ?? 0);
			const range = Range.create(
				{ line: lineIndex, character: nameIndex },
				{ line: lineIndex, character: nameIndex + name.length }
			);
			interfaces.set(name, {
				definition: Location.create(uri, range),
				members: new Map()
			});
			inInterface = true;
			interfaceIndent = lineIndent;
			currentInterface = name;
			inInterfaceSection = false;
			continue;
		}

		if (inInterface && !isBlank && lineIndent <= interfaceIndent) {
			inInterface = false;
			currentInterface = null;
			inInterfaceSection = false;
		}

		if (!inInterface || !currentInterface) {
			continue;
		}

		const sectionMatch = line.match(interfaceSectionPattern);
		if (sectionMatch) {
			inInterfaceSection = true;
			currentSectionIndent = lineIndent;
			continue;
		}

		if (inInterfaceSection && !isBlank && lineIndent <= currentSectionIndent) {
			inInterfaceSection = false;
		}

		if (inInterfaceSection && lineIndent > currentSectionIndent) {
			const memberMatch = line.match(interfaceMemberPattern);
			if (memberMatch) {
				const memberName = memberMatch[2];
				const memberIndex = line.indexOf(memberName, memberMatch.index ?? 0);
				const range = Range.create(
					{ line: lineIndex, character: memberIndex },
					{ line: lineIndex, character: memberIndex + memberName.length }
				);
				interfaces.get(currentInterface)?.members.set(memberName, Location.create(uri, range));
			}
		}
	}

	return { interfaces };
};

const buildEventIndex = (text: string): EventIndex => {
	const lines = text.split(/\r?\n/);
	const events = new Map<string, { definition: DefinitionLocation; fields: Map<string, DefinitionLocation>; topics: Map<string, DefinitionLocation> }>();

	const eventPattern = /^\s*event\s+([A-Za-z_][A-Za-z0-9_]*)\b(?=\s*:)/;
	const fieldPattern = /^\s*field\s+([A-Za-z_][A-Za-z0-9_]*)\b/;
	const topicPattern = /^\s*topic\s+([A-Za-z_][A-Za-z0-9_]*)\b/;

	let inEvent = false;
	let eventIndent = 0;
	let currentEvent: string | null = null;

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex];
		const lineIndent = line.match(/^\s*/)?.[0].length ?? 0;
		const isBlank = line.trim().length === 0;

		const eventMatch = line.match(eventPattern);
		if (eventMatch) {
			const name = eventMatch[1];
			const nameIndex = line.indexOf(name, eventMatch.index ?? 0);
			events.set(name, {
				definition: { line: lineIndex, character: nameIndex },
				fields: new Map(),
				topics: new Map()
			});
			inEvent = true;
			eventIndent = lineIndent;
			currentEvent = name;
			continue;
		}

		if (inEvent && !isBlank && lineIndent <= eventIndent) {
			inEvent = false;
			currentEvent = null;
		}

		if (!inEvent || !currentEvent) {
			continue;
		}

		const topicMatch = line.match(topicPattern);
		if (topicMatch) {
			const topicName = topicMatch[1];
			const topicIndex = line.indexOf(topicName, topicMatch.index ?? 0);
			events.get(currentEvent)?.topics.set(topicName, { line: lineIndex, character: topicIndex });
			continue;
		}

		const fieldMatch = line.match(fieldPattern);
		if (fieldMatch) {
			const fieldName = fieldMatch[1];
			const fieldIndex = line.indexOf(fieldName, fieldMatch.index ?? 0);
			events.get(currentEvent)?.fields.set(fieldName, { line: lineIndex, character: fieldIndex });
		}
	}

	return { events };
};

const buildLocatedEventIndex = (text: string, uri: string): LocatedEventIndex => {
	const lines = text.split(/\r?\n/);
	const events = new Map<string, { definition: Location; fields: Map<string, Location>; topics: Map<string, Location> }>();

	const eventPattern = /^\s*event\s+([A-Za-z_][A-Za-z0-9_]*)\b(?=\s*:)/;
	const fieldPattern = /^\s*field\s+([A-Za-z_][A-Za-z0-9_]*)\b/;
	const topicPattern = /^\s*topic\s+([A-Za-z_][A-Za-z0-9_]*)\b/;

	let inEvent = false;
	let eventIndent = 0;
	let currentEvent: string | null = null;

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex];
		const lineIndent = line.match(/^\s*/)?.[0].length ?? 0;
		const isBlank = line.trim().length === 0;

		const eventMatch = line.match(eventPattern);
		if (eventMatch) {
			const name = eventMatch[1];
			const nameIndex = line.indexOf(name, eventMatch.index ?? 0);
			const range = Range.create(
				{ line: lineIndex, character: nameIndex },
				{ line: lineIndex, character: nameIndex + name.length }
			);
			events.set(name, {
				definition: Location.create(uri, range),
				fields: new Map(),
				topics: new Map()
			});
			inEvent = true;
			eventIndent = lineIndent;
			currentEvent = name;
			continue;
		}

		if (inEvent && !isBlank && lineIndent <= eventIndent) {
			inEvent = false;
			currentEvent = null;
		}

		if (!inEvent || !currentEvent) {
			continue;
		}

		const topicMatch = line.match(topicPattern);
		if (topicMatch) {
			const topicName = topicMatch[1];
			const topicIndex = line.indexOf(topicName, topicMatch.index ?? 0);
			const range = Range.create(
				{ line: lineIndex, character: topicIndex },
				{ line: lineIndex, character: topicIndex + topicName.length }
			);
			events.get(currentEvent)?.topics.set(topicName, Location.create(uri, range));
			continue;
		}

		const fieldMatch = line.match(fieldPattern);
		if (fieldMatch) {
			const fieldName = fieldMatch[1];
			const fieldIndex = line.indexOf(fieldName, fieldMatch.index ?? 0);
			const range = Range.create(
				{ line: lineIndex, character: fieldIndex },
				{ line: lineIndex, character: fieldIndex + fieldName.length }
			);
			events.get(currentEvent)?.fields.set(fieldName, Location.create(uri, range));
		}
	}

	return { events };
};

const buildStateIndex = (text: string): StateIndex => {
	const lines = text.split(/\r?\n/);
	let moduleName: string | null = null;
	const logicFields = new Set<string>();
	const actorFields = new Set<string>();

	for (const line of lines) {
		const cocoMatch = line.match(/^\s*coco\s+([A-Za-z_][A-Za-z0-9_]*)/);
		if (cocoMatch) {
			moduleName = cocoMatch[1];
			break;
		}
	}

	let inState = false;
	let stateIndent = 0;
	let stateQualifier: "logic" | "actor" | null = null;
	let inInterface = false;
	let interfaceIndent = 0;

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex];
		const lineIndent = line.match(/^\s*/)?.[0].length ?? 0;
		const isBlank = line.trim().length === 0;

		const interfaceMatch = line.match(/^\s*interface\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*$/);
		if (interfaceMatch) {
			inInterface = true;
			interfaceIndent = lineIndent;
		} else if (inInterface && !isBlank && lineIndent <= interfaceIndent) {
			inInterface = false;
		}

		if (inInterface) {
			continue;
		}

		const stateMatch = line.match(/^\s*state\s+(logic|actor|persistent|ephemeral|readonly)\s*:\s*$/);
		if (stateMatch) {
			inState = true;
			stateIndent = lineIndent;
			const qual = stateMatch[1];
			stateQualifier = (qual === "actor" || qual === "ephemeral") ? "actor" : "logic";
			continue;
		}

		if (inState && !isBlank && lineIndent <= stateIndent) {
			inState = false;
			stateQualifier = null;
		}

		if (!inState || !stateQualifier) {
			continue;
		}

		const fieldMatch = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\b/);
		if (fieldMatch) {
			const fieldName = fieldMatch[1];
			if (stateQualifier === "logic") {
				logicFields.add(fieldName);
			} else {
				actorFields.add(fieldName);
			}
		}
	}

	return { moduleName, logicFields, actorFields };
};

const buildInterfaceStateIndex = (text: string): InterfaceStateIndex => {
	const lines = text.split(/\r?\n/);
	const interfaces = new Map<string, { logicFields: Set<string>; actorFields: Set<string> }>();

	let inInterface = false;
	let interfaceIndent = 0;
	let currentInterface: string | null = null;
	let inState = false;
	let stateIndent = 0;
	let stateQualifier: "logic" | "actor" | null = null;

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex];
		const lineIndent = line.match(/^\s*/)?.[0].length ?? 0;
		const isBlank = line.trim().length === 0;

		const interfaceMatch = line.match(/^\s*interface\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*$/);
		if (interfaceMatch) {
			const name = interfaceMatch[1];
			interfaces.set(name, { logicFields: new Set(), actorFields: new Set() });
			inInterface = true;
			interfaceIndent = lineIndent;
			currentInterface = name;
			inState = false;
			stateQualifier = null;
			continue;
		}

		if (inInterface && !isBlank && lineIndent <= interfaceIndent) {
			inInterface = false;
			currentInterface = null;
			inState = false;
			stateQualifier = null;
		}

		if (!inInterface || !currentInterface) {
			continue;
		}

		const stateMatch = line.match(/^\s*state\s+(logic|actor|persistent|ephemeral|readonly)\s*:\s*$/);
		if (stateMatch) {
			inState = true;
			stateIndent = lineIndent;
			const qual = stateMatch[1];
			stateQualifier = (qual === "actor" || qual === "ephemeral") ? "actor" : "logic";
			continue;
		}

		if (inState && !isBlank && lineIndent <= stateIndent) {
			inState = false;
			stateQualifier = null;
		}

		if (!inState || !stateQualifier) {
			continue;
		}

		const fieldMatch = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\b/);
		if (fieldMatch) {
			const fieldName = fieldMatch[1];
			const entry = interfaces.get(currentInterface);
			if (entry) {
				if (stateQualifier === "logic") {
					entry.logicFields.add(fieldName);
				} else {
					entry.actorFields.add(fieldName);
				}
			}
		}
	}

	return { interfaces };
};

const buildModuleContext = async (uri: string, text: string): Promise<ModuleContext> => {
	const moduleName = getCocoModuleName(text);
	if (!moduleName) {
		return { moduleName: null, files: [{ uri, text }] };
	}

	const dir = path.dirname(fileURLToPath(uri));
	let entries: string[] = [];
	try {
		entries = await fs.readdir(dir);
	} catch {
		return { moduleName, files: [{ uri, text }] };
	}

	const files: Array<{ uri: string; text: string }> = [];
	for (const entry of entries) {
		const ext = path.extname(entry).toLowerCase();
		if (ext !== ".coco" && ext !== ".nut") {
			continue;
		}
		const filePath = path.join(dir, entry);
		const fileUri = pathToFileURL(filePath).toString();
		let fileText = "";
		const openDoc = documents.get(fileUri);
		if (openDoc) {
			fileText = openDoc.getText();
		} else {
			try {
				fileText = await fs.readFile(filePath, "utf8");
			} catch {
				continue;
			}
		}

		const fileModule = getCocoModuleName(fileText);
		if (fileModule === moduleName) {
			files.push({ uri: fileUri, text: fileText });
		}
	}

	if (!files.some(file => file.uri === uri)) {
		files.push({ uri, text });
	}

	return { moduleName, files };
};

const buildModuleSymbols = (context: ModuleContext): ModuleSymbols => {
	const classIndex: LocatedClassIndex = { classes: new Map() };
	const eventIndex: LocatedEventIndex = { events: new Map() };
	const interfaceIndex: LocatedInterfaceIndex = { interfaces: new Map() };
	const callables: LocatedCallableIndex = { callables: new Map() };

	for (const file of context.files) {
		const fileClassIndex = buildLocatedClassIndex(file.text, file.uri);
		const fileEventIndex = buildLocatedEventIndex(file.text, file.uri);
		const fileInterfaceIndex = buildLocatedInterfaceIndex(file.text, file.uri);
		const fileCallableIndex = buildLocatedCallableIndex(file.text, file.uri);

		for (const [name, value] of fileClassIndex.classes.entries()) {
			if (!classIndex.classes.has(name)) {
				classIndex.classes.set(name, value);
			}
		}
		for (const [name, value] of fileEventIndex.events.entries()) {
			if (!eventIndex.events.has(name)) {
				eventIndex.events.set(name, value);
			}
		}
		for (const [name, value] of fileInterfaceIndex.interfaces.entries()) {
			if (!interfaceIndex.interfaces.has(name)) {
				interfaceIndex.interfaces.set(name, value);
			}
		}
		for (const [name, value] of fileCallableIndex.callables.entries()) {
			if (!callables.callables.has(name)) {
				callables.callables.set(name, value);
			}
		}
	}

	return { classIndex, eventIndex, interfaceIndex, callables };
};

const buildModuleAnalysisIndexes = (context: ModuleContext): {
	classIndex: ClassIndex;
	eventIndex: EventIndex;
	interfaceIndex: InterfaceIndex;
	interfaceStateIndex: InterfaceStateIndex;
	stateIndex: StateIndex;
} => {
	const classIndexes: ClassIndex[] = [];
	const eventIndexes: EventIndex[] = [];
	const interfaceIndexes: InterfaceIndex[] = [];
	const interfaceStateIndexes: InterfaceStateIndex[] = [];
	const stateIndexes: StateIndex[] = [];

	for (const file of context.files) {
		classIndexes.push(buildClassIndex(file.text));
		eventIndexes.push(buildEventIndex(file.text));
		interfaceIndexes.push(buildInterfaceIndex(file.text));
		interfaceStateIndexes.push(buildInterfaceStateIndex(file.text));
		stateIndexes.push(buildStateIndex(file.text));
	}

	return {
		classIndex: mergeClassIndexes(classIndexes),
		eventIndex: mergeEventIndexes(eventIndexes),
		interfaceIndex: mergeInterfaceIndexes(interfaceIndexes),
		interfaceStateIndex: mergeInterfaceStateIndexes(interfaceStateIndexes),
		stateIndex: mergeStateIndexes(context.moduleName, stateIndexes)
	};
};

const mergeClassIndexes = (indexes: ClassIndex[]): ClassIndex => {
	const classes = new Map<string, { definition: DefinitionLocation; fields: Map<string, DefinitionLocation>; methods: Map<string, DefinitionLocation>; fieldTypes: Map<string, { typeName: string; isCollection: boolean }> }>();
	for (const index of indexes) {
		for (const [name, value] of index.classes.entries()) {
			if (!classes.has(name)) {
				classes.set(name, value);
			}
		}
	}
	return { classes };
};

const mergeEventIndexes = (indexes: EventIndex[]): EventIndex => {
	const events = new Map<string, { definition: DefinitionLocation; fields: Map<string, DefinitionLocation>; topics: Map<string, DefinitionLocation> }>();
	for (const index of indexes) {
		for (const [name, value] of index.events.entries()) {
			if (!events.has(name)) {
				events.set(name, value);
			}
		}
	}
	return { events };
};

const mergeInterfaceIndexes = (indexes: InterfaceIndex[]): InterfaceIndex => {
	const interfaces = new Map<string, { definition: DefinitionLocation; members: Map<string, DefinitionLocation> }>();
	for (const index of indexes) {
		for (const [name, value] of index.interfaces.entries()) {
			if (!interfaces.has(name)) {
				interfaces.set(name, value);
			}
		}
	}
	return { interfaces };
};

const mergeInterfaceStateIndexes = (indexes: InterfaceStateIndex[]): InterfaceStateIndex => {
	const interfaces = new Map<string, { logicFields: Set<string>; actorFields: Set<string> }>();
	for (const index of indexes) {
		for (const [name, value] of index.interfaces.entries()) {
			let entry = interfaces.get(name);
			if (!entry) {
				entry = { logicFields: new Set(), actorFields: new Set() };
				interfaces.set(name, entry);
			}
			for (const field of value.logicFields) {
				entry.logicFields.add(field);
			}
			for (const field of value.actorFields) {
				entry.actorFields.add(field);
			}
		}
	}
	return { interfaces };
};

const mergeStateIndexes = (moduleName: string | null, indexes: StateIndex[]): StateIndex => {
	const logicFields = new Set<string>();
	const actorFields = new Set<string>();
	for (const index of indexes) {
		for (const field of index.logicFields) {
			logicFields.add(field);
		}
		for (const field of index.actorFields) {
			actorFields.add(field);
		}
	}
	return { moduleName, logicFields, actorFields };
};

const getCocoModuleName = (text: string): string | null => {
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) {
			continue;
		}
		if (trimmed.startsWith("//")) {
			continue;
		}
		const match = trimmed.match(/^coco\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
		return match ? match[1] : null;
	}
	return null;
};

const buildClassIndex = (text: string): ClassIndex => {
	const lines = text.split(/\r?\n/);
	const classes = new Map<string, { definition: DefinitionLocation; fields: Map<string, DefinitionLocation>; methods: Map<string, DefinitionLocation>; fieldTypes: Map<string, { typeName: string; isCollection: boolean }> }>();

	const classPattern = /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\b(?=\s*:)/;
	const fieldPattern = /^\s*field\s+([A-Za-z_][A-Za-z0-9_]*)\s+((?:\[\]|Map\[.*?\]|\[\d+\])*)([A-Za-z_][A-Za-z0-9_]*)/;
	const methodPattern = /^\s*method\s+(?:(?:mutate|observe)\s+)?([A-Za-z_][A-Za-z0-9_!]*)\b/;

	let inClass = false;
	let classIndent = 0;
	let currentClass: string | null = null;

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex];
		const lineIndent = line.match(/^\s*/)?.[0].length ?? 0;
		const isBlank = line.trim().length === 0;

		const classMatch = line.match(classPattern);
		if (classMatch) {
			const name = classMatch[1];
			const nameIndex = line.indexOf(name, classMatch.index ?? 0);
			classes.set(name, {
				definition: { line: lineIndex, character: nameIndex },
				fields: new Map(),
				methods: new Map(),
				fieldTypes: new Map()
			});
			inClass = true;
			classIndent = lineIndent;
			currentClass = name;
			continue;
		}

		if (inClass && !isBlank && lineIndent <= classIndent) {
			inClass = false;
			currentClass = null;
		}

		if (!inClass || !currentClass) {
			continue;
		}

		const fieldMatch = line.match(fieldPattern);
		if (fieldMatch) {
			const fieldName = fieldMatch[1];
			const collectionPrefix = fieldMatch[2];
			const fieldTypeName = fieldMatch[3];
			const isCollection = collectionPrefix.length > 0;
			const fieldIndex = line.indexOf(fieldName, fieldMatch.index ?? 0);
			classes.get(currentClass)?.fields.set(fieldName, { line: lineIndex, character: fieldIndex });
			classes.get(currentClass)?.fieldTypes.set(fieldName, { typeName: fieldTypeName, isCollection });
			continue;
		}

		const methodMatch = line.match(methodPattern);
		if (methodMatch) {
			const methodName = methodMatch[1];
			const methodIndex = line.indexOf(methodName, methodMatch.index ?? 0);
			classes.get(currentClass)?.methods.set(methodName, { line: lineIndex, character: methodIndex });
		}
	}

	return { classes };
};

const buildLocatedClassIndex = (text: string, uri: string): LocatedClassIndex => {
	const lines = text.split(/\r?\n/);
	const classes = new Map<string, { definition: Location; fields: Map<string, Location>; methods: Map<string, Location> }>();

	const classPattern = /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\b(?=\s*:)/;
	const fieldPattern = /^\s*field\s+([A-Za-z_][A-Za-z0-9_]*)\b/;
	const methodPattern = /^\s*method\s+(?:(?:mutate|observe)\s+)?([A-Za-z_][A-Za-z0-9_!]*)\b/;

	let inClass = false;
	let classIndent = 0;
	let currentClass: string | null = null;

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex];
		const lineIndent = line.match(/^\s*/)?.[0].length ?? 0;
		const isBlank = line.trim().length === 0;

		const classMatch = line.match(classPattern);
		if (classMatch) {
			const name = classMatch[1];
			const nameIndex = line.indexOf(name, classMatch.index ?? 0);
			const range = Range.create(
				{ line: lineIndex, character: nameIndex },
				{ line: lineIndex, character: nameIndex + name.length }
			);
			classes.set(name, {
				definition: Location.create(uri, range),
				fields: new Map(),
				methods: new Map()
			});
			inClass = true;
			classIndent = lineIndent;
			currentClass = name;
			continue;
		}

		if (inClass && !isBlank && lineIndent <= classIndent) {
			inClass = false;
			currentClass = null;
		}

		if (!inClass || !currentClass) {
			continue;
		}

		const fieldMatch = line.match(fieldPattern);
		if (fieldMatch) {
			const fieldName = fieldMatch[1];
			const fieldIndex = line.indexOf(fieldName, fieldMatch.index ?? 0);
			const range = Range.create(
				{ line: lineIndex, character: fieldIndex },
				{ line: lineIndex, character: fieldIndex + fieldName.length }
			);
			classes.get(currentClass)?.fields.set(fieldName, Location.create(uri, range));
			continue;
		}

		const methodMatch = line.match(methodPattern);
		if (methodMatch) {
			const methodName = methodMatch[1];
			const methodIndex = line.indexOf(methodName, methodMatch.index ?? 0);
			const range = Range.create(
				{ line: lineIndex, character: methodIndex },
				{ line: lineIndex, character: methodIndex + methodName.length }
			);
			classes.get(currentClass)?.methods.set(methodName, Location.create(uri, range));
		}
	}

	return { classes };
};

const buildCallableIndex = (text: string): CallableIndex => {
	const lines = text.split(/\r?\n/);
	const callables = new Map<string, { definition: DefinitionLocation; params: Map<string, DefinitionLocation>; returns: Map<string, DefinitionLocation> }>();
	const callableRanges: Array<{ name: string; line: number; indent: number }> = [];

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex];
		const match = matchCallableDefinition(line, lineIndex);
		if (!match) {
			continue;
		}

		callables.set(match.name, {
			definition: { line: lineIndex, character: match.nameIndex },
			params: match.params,
			returns: match.returns
		});

		callableRanges.push({ name: match.name, line: lineIndex, indent: match.indent });
	}

	return { callables, callableRanges };
};

const buildLocatedCallableIndex = (text: string, uri: string): LocatedCallableIndex => {
	const lines = text.split(/\r?\n/);
	const callables = new Map<string, { definition: Location; params: Map<string, Location>; returns: Map<string, Location> }>();

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex];
		const match = matchCallableDefinition(line, lineIndex);
		if (!match) {
			continue;
		}

		const defRange = Range.create(
			{ line: lineIndex, character: match.nameIndex },
			{ line: lineIndex, character: match.nameIndex + match.name.length }
		);
		const params = new Map<string, Location>();
		for (const [name, loc] of match.params.entries()) {
			const range = Range.create(
				{ line: loc.line, character: loc.character },
				{ line: loc.line, character: loc.character + name.length }
			);
			params.set(name, Location.create(uri, range));
		}
		const returns = new Map<string, Location>();
		for (const [name, loc] of match.returns.entries()) {
			const range = Range.create(
				{ line: loc.line, character: loc.character },
				{ line: loc.line, character: loc.character + name.length }
			);
			returns.set(name, Location.create(uri, range));
		}

		callables.set(match.name, {
			definition: Location.create(uri, defRange),
			params,
			returns
		});
	}

	return { callables };
};

const matchCallableDefinition = (
	line: string,
	lineIndex: number
): { name: string; nameIndex: number; params: Map<string, DefinitionLocation>; returns: Map<string, DefinitionLocation>; indent: number } | null => {
	const indent = line.match(/^\s*/)?.[0].length ?? 0;
	const patterns = [
		/^\s*endpoint\s+(?:(?:invoke|enlist|deploy)\s+)?(?:(?:ephemeral|persistent|readonly|static|dynamic|pure)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*(?:->\s*\(([^)]*)\))?/,
		/^\s*function\s+(?:(?:persistent|ephemeral|readonly|static|dynamic|pure)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*(?:->\s*\(([^)]*)\))?/,
		/^\s*method\s+(?:(?:mutate|observe)\s+)?([A-Za-z_][A-Za-z0-9_!]*)\s*\(([^)]*)\)\s*(?:->\s*\(([^)]*)\))?/
	];

	for (const pattern of patterns) {
		const match = line.match(pattern);
		if (!match) {
			continue;
		}

		const name = match[1];
		const nameIndex = line.indexOf(name, match.index ?? 0);
		const paramsText = match[2] ?? "";
		const paramsStart = line.indexOf("(", match.index ?? 0) + 1;
		const returnsText = match[3] ?? "";
		let returnsStart = -1;
		if (match[3] !== undefined) {
			const arrowIndex = line.indexOf("->", match.index ?? 0);
			if (arrowIndex >= 0) {
				const returnsParen = line.indexOf("(", arrowIndex);
				returnsStart = returnsParen >= 0 ? returnsParen + 1 : -1;
			}
		}

		const params = paramsStart > 0 ? parseNameList(paramsText, line, lineIndex, paramsStart, true) : new Map();
		const returns = returnsStart > 0 ? parseNameList(returnsText, line, lineIndex, returnsStart, true) : new Map();

		return { name, nameIndex, params, returns, indent };
	}

	return null;
};

const parseNameList = (
	listText: string,
	line: string,
	lineIndex: number,
	listStart: number,
	keepLast: boolean
): Map<string, DefinitionLocation> => {
	const results = new Map<string, DefinitionLocation>();
	if (!listText.trim()) {
		return results;
	}

	const parts = listText.split(",");
	let searchIndex = listStart;
	for (const part of parts) {
		const nameMatch = part.match(/\b([A-Za-z_][A-Za-z0-9_]*)\b/);
		if (!nameMatch) {
			continue;
		}
		const name = nameMatch[1];
		const nameIndex = line.indexOf(name, searchIndex);
		if (nameIndex >= 0) {
			if (keepLast || !results.has(name)) {
				results.set(name, { line: lineIndex, character: nameIndex });
			}
			searchIndex = nameIndex + name.length;
		}
	}

	return results;
};

const findCallAtPosition = (
	line: string,
	position: number
): { callee: string; argsText: string; argsStart: number } | null => {
	for (const call of findCallCandidates(line)) {
		if (position >= call.argsStart - 1 && position <= call.argsEnd) {
			return { callee: call.callee, argsText: call.argsText, argsStart: call.argsStart };
		}
	}

	return null;
};

const findCallCandidates = (
	line: string
): Array<{ callee: string; argsText: string; argsStart: number; argsEnd: number; calleeStart: number; calleeEnd: number }> => {
	const results: Array<{ callee: string; argsText: string; argsStart: number; argsEnd: number; calleeStart: number; calleeEnd: number }> = [];
	for (let i = 0; i < line.length; i++) {
		const match = line.slice(i).match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
		if (!match) {
			continue;
		}

		const callee = match[1];
		const calleeIndex = i + (match.index ?? 0);
		const parenIndex = line.indexOf("(", calleeIndex);
		if (parenIndex < 0) {
			i = calleeIndex + callee.length;
			continue;
		}

		let depth = 0;
		let endIndex = -1;
		for (let j = parenIndex; j < line.length; j++) {
			const ch = line[j];
			if (ch === "(") {
				depth += 1;
			} else if (ch === ")") {
				depth -= 1;
				if (depth === 0) {
					endIndex = j;
					break;
				}
			}
		}

		if (endIndex < 0) {
			i = parenIndex + 1;
			continue;
		}

		results.push({
			callee,
			argsText: line.slice(parenIndex + 1, endIndex),
			argsStart: parenIndex + 1,
			argsEnd: endIndex,
			calleeStart: calleeIndex,
			calleeEnd: calleeIndex + callee.length
		});

		i = endIndex + 1;
	}

	return results;
};

const findTypeLiteralCandidates = (
	line: string
): Array<{ typeName: string; typeStart: number; bodyText: string; bodyStart: number; braceStart: number; braceEnd: number }> => {
	const results: Array<{ typeName: string; typeStart: number; bodyText: string; bodyStart: number; braceStart: number; braceEnd: number }> = [];

	for (let i = 0; i < line.length; i++) {
		const match = line.slice(i).match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\{/);
		if (!match) {
			continue;
		}

		const typeName = match[1];
		const typeIndex = i + (match.index ?? 0);
		const braceIndex = line.indexOf("{", typeIndex);
		if (braceIndex < 0) {
			i = typeIndex + typeName.length;
			continue;
		}

		let depth = 0;
		let endIndex = -1;
		for (let j = braceIndex; j < line.length; j++) {
			const ch = line[j];
			if (ch === "{") {
				depth += 1;
			} else if (ch === "}") {
				depth -= 1;
				if (depth === 0) {
					endIndex = j;
					break;
				}
			}
		}

		if (endIndex < 0) {
			i = braceIndex + 1;
			continue;
		}

		results.push({
			typeName,
			typeStart: typeIndex,
			bodyText: line.slice(braceIndex + 1, endIndex),
			bodyStart: braceIndex + 1,
			braceStart: braceIndex,
			braceEnd: endIndex
		});

		i = endIndex + 1;
	}

	return results;
};

const getPropertyNameAtPosition = (bodyText: string, bodyStart: number, position: number): string | null => {
	let depth = 0;
	let segmentStart = 0;

	for (let i = 0; i <= bodyText.length; i++) {
		const ch = bodyText[i];
		if (ch === "{") {
			depth += 1;
		} else if (ch === "}") {
			depth -= 1;
		}

		const isEnd = i === bodyText.length || (ch === "," && depth === 0);
		if (!isEnd) {
			continue;
		}

		const segment = bodyText.slice(segmentStart, i);
		const nameMatch = segment.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/);
		if (nameMatch) {
			const name = nameMatch[1];
			const nameOffset = segment.indexOf(name);
			const nameStart = bodyStart + segmentStart + nameOffset;
			const nameEnd = nameStart + name.length;
			if (position >= nameStart && position <= nameEnd) {
				return name;
			}
		}

		segmentStart = i + 1;
	}

	return null;
};

const parseLiteralProperties = (bodyText: string, bodyStart: number): Array<{ name: string; start: number }> => {
	const results: Array<{ name: string; start: number }> = [];
	const depthAt = new Array<number>(bodyText.length).fill(0);
	let depth = 0;
	for (let i = 0; i < bodyText.length; i++) {
		if (bodyText[i] === "{" || bodyText[i] === "(") { depth++; }
		depthAt[i] = depth;
		if (bodyText[i] === "}" || bodyText[i] === ")") { depth--; }
	}
	for (const match of bodyText.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) {
		const name = match[1];
		const matchIndex = match.index ?? -1;
		if (matchIndex < 0) {
			continue;
		}
		if (depthAt[matchIndex] > 0) {
			continue;
		}
		const nameIndex = bodyText.indexOf(name, matchIndex);
		if (nameIndex >= 0) {
			results.push({ name, start: bodyStart + nameIndex });
		}
	}
	return results;
};

const checkUndefinedVariables = (
	text: string,
	classIndex: ClassIndex,
	eventIndex: EventIndex,
	interfaceIndex: InterfaceIndex,
	stateIndex: StateIndex,
	diagnostics: Diagnostic[]
): void => {
	const lines = text.split(/\r?\n/);
	const callableIndex = buildCallableIndex(text);
	const scopes = buildCallableScopes(lines, callableIndex);
	const callableNames = new Set<string>(callableIndex.callables.keys());
	const typeNames = new Set<string>([
		...classIndex.classes.keys(),
		...eventIndex.events.keys(),
		...interfaceIndex.interfaces.keys(),
		...builtinTypeNames
	]);
	if (stateIndex.moduleName) {
		typeNames.add(stateIndex.moduleName);
	}
	const moduleConstants = new Set<string>();
	for (const constMatch of text.matchAll(/^const\s+([A-Za-z_][A-Za-z0-9_]*)\b/gm)) {
		moduleConstants.add(constMatch[1]);
	}

	for (const scope of scopes) {
		const scopeStack: Array<{ indent: number; defined: Set<string> }> = [
			{ indent: scope.indent, defined: new Set(scope.parameters) }
		];
		const returnDefinitions = getReturnNamesAndPositions(lines, scope.startLine);
		const returnNames = new Set([
			...(callableIndex.callables.get(scope.name)?.returns.keys() ?? []),
			...returnDefinitions.keys()
		]);
		let blockIndent = 0;
		let blockActive = false;
		let prevLineEndsBlock = false;
		let pendingBlockDeclarations: Set<string> | null = null;
		let inlineBlockActive = false;
		let inlineDefined: Set<string> | null = null;
		let inlineKeywords: Set<string> | null = null;
		let signatureContinuation = false;

		for (let lineIndex = scope.startLine; lineIndex <= scope.endLine; lineIndex++) {
			const line = lines[lineIndex];
			if (/^\s*(function|endpoint|method|class|interface|event)\b/.test(line)) {
				if (!line.trim().endsWith(":")) {
					signatureContinuation = true;
				}
				continue;
			}
			if (signatureContinuation) {
				if (line.trim().endsWith(":")) {
					signatureContinuation = false;
				}
				continue;
			}
			const commentIndex = line.indexOf("//");
			const scanLine = commentIndex >= 0 ? line.slice(0, commentIndex) : line;
			let stringRanges = getStringRanges(scanLine);
			const lineIndent = line.match(/^\s*/)?.[0].length ?? 0;
			const isBlank = line.trim().length === 0;
			const inlineBlock = splitInlineBlock(scanLine);

			if (!isBlank) {
				while (scopeStack.length > 1 && lineIndent < scopeStack[scopeStack.length - 1].indent) {
					scopeStack.pop();
				}
				if (prevLineEndsBlock && lineIndent > scopeStack[scopeStack.length - 1].indent) {
					scopeStack.push({ indent: lineIndent, defined: new Set(pendingBlockDeclarations ?? []) });
					pendingBlockDeclarations = null;
				}
			}

			if (blockActive) {
				if (!isBlank && lineIndent <= blockIndent) {
					blockActive = false;
				}
			}

			const headerMatch = scanLine.match(/^\s*(?:generate\s+)?(memory|storage)\s*:\s*$/);
			if (headerMatch) {
				blockActive = true;
				blockIndent = lineIndent;
				prevLineEndsBlock = false;
				continue;
			}

			const lineDeclarations = getVariableDeclarationsForLine(scanLine, blockActive, blockIndent, lineIndent, isBlank);
			const mutateObserveInfo = extractMutateObserveInfo(scanLine);
			const mutateObserveIsBlock = !!mutateObserveInfo.verb && scanLine.trim().endsWith(":");
			const headerDeclarations = mutateObserveIsBlock ? mutateObserveInfo.targets : [];
			const forTargets = extractForTargets(scanLine);
			const returnTargets = getReturnTargets(scanLine, stringRanges);
			for (const target of returnTargets) {
				if (!returnNames.has(target.name)) {
					diagnostics.push({
						severity: DiagnosticSeverity.Error,
						range: {
							start: { line: lineIndex, character: target.start },
							end: { line: lineIndex, character: target.end }
						},
						message: `'${target.name}' is not declared as a return value`,
						source: 'ex'
					});
				}
			}
			if (mutateObserveInfo.verb && !mutateObserveIsBlock) {
				for (const target of mutateObserveInfo.targets) {
					if (returnNames.has(target.name)) {
						continue;
					}
					if (isKeyword(target.name) || callableNames.has(target.name) || typeNames.has(target.name) || moduleConstants.has(target.name)) {
						continue;
					}
					if (isCallLabel(scanLine, target.end)) {
						continue;
					}
					if (!isDefinedInScopes(scopeStack, target.name)) {
						diagnostics.push({
							severity: DiagnosticSeverity.Error,
							range: {
								start: { line: lineIndex, character: target.start },
								end: { line: lineIndex, character: target.end }
							},
							message: `'${target.name}' is not defined in this scope`,
							source: 'ex'
						});
					}
				}
			}

			if (inlineBlock) {
				inlineBlockActive = true;
				inlineDefined = new Set<string>(scopeStack[scopeStack.length - 1].defined);
				inlineKeywords = extractInlineBlockKeywords(inlineBlock.header);
				const inlineMutateInfo = extractMutateObserveInfo(inlineBlock.header);
				const inlineForTargets = extractForTargets(inlineBlock.header);
				if (inlineMutateInfo.verb && inlineBlock.header.trim().endsWith(":")) {
					for (const declaration of inlineMutateInfo.targets) {
						inlineDefined.add(declaration.name);
					}
				}
				for (const target of inlineForTargets) {
					if (target.name !== "_") {
						inlineDefined.add(target.name);
					}
				}
				for (const declaration of getVariableDeclarationsForLine(inlineBlock.body, false, 0, 0, false)) {
					inlineDefined.add(declaration.name);
				}
				for (const declaration of lineDeclarations) {
					scopeStack[scopeStack.length - 1].defined.add(declaration.name);
				}

				const inlineStringRanges = getStringRanges(inlineBlock.body);
				const inlineCallOutputTargets = getCallOutputTargets(inlineBlock.body);
				for (const identifier of getIdentifierCandidates(inlineBlock.body)) {
					if (isInsideRanges(identifier.start, inlineStringRanges)) {
						continue;
					}
					if (isInlineBlockKeyword(inlineKeywords, identifier.name) || isKeyword(identifier.name) || callableNames.has(identifier.name) || typeNames.has(identifier.name) || moduleConstants.has(identifier.name)) {
						continue;
					}
					if (identifier.name === "_") {
						continue;
					}
					if (returnNames.has(identifier.name)) {
						if (isMemberAccess(inlineBlock.body, identifier.start)) {
							continue;
						}
						if (isCallLabel(inlineBlock.body, identifier.end) || isCallableUsage(inlineBlock.body, identifier.end)) {
							continue;
						}
						const retKw = inlineBlock.body.match(/\b(return|yield)\b/);
						if (retKw && retKw.index !== undefined && identifier.start > retKw.index + retKw[1].length) {
							continue;
						}
						if (!isAssignmentTarget(inlineBlock.body, identifier) && !isReturnTargetUsage(inlineBlock.body, identifier)) {
							if (isCallOutputTarget(identifier, inlineCallOutputTargets)) {
								continue;
							}
							if (isFunctionArgument(inlineBlock.body, identifier.start)) {
								continue;
							}
							const inlineOffset = inlineBlock.bodyStart;
							diagnostics.push({
								severity: DiagnosticSeverity.Error,
								range: {
									start: { line: lineIndex, character: inlineOffset + identifier.start },
									end: { line: lineIndex, character: inlineOffset + identifier.start + identifier.name.length }
								},
								message: `'${identifier.name}' is a write-only return value`,
								source: 'ex'
							});
						}
						continue;
					}
					if (isMemberAccess(inlineBlock.body, identifier.start)) {
						continue;
					}
					if (isCallLabel(inlineBlock.body, identifier.end) || isCallableUsage(inlineBlock.body, identifier.end)) {
						continue;
					}
					if (isCallOutputTarget(identifier, inlineCallOutputTargets)) {
						continue;
					}
					if (isCrossPackageRef(inlineBlock.body, identifier.start)) {
						continue;
					}
					if (!inlineDefined?.has(identifier.name)) {
						const inlineOffset = inlineBlock.bodyStart;
						diagnostics.push({
							severity: DiagnosticSeverity.Error,
							range: {
								start: { line: lineIndex, character: inlineOffset + identifier.start },
								end: { line: lineIndex, character: inlineOffset + identifier.start + identifier.name.length }
							},
							message: `'${identifier.name}' is not defined in this scope`,
							source: 'ex'
						});
					}
				}

				prevLineEndsBlock = false;
				inlineBlockActive = false;
				inlineDefined = null;
				inlineKeywords = null;
				pendingBlockDeclarations = null;
				continue;
			}

			const callOutputTargets = getCallOutputTargets(scanLine);
			for (const identifier of getIdentifierCandidates(scanLine)) {
				if (isInsideRanges(identifier.start, stringRanges)) {
					continue;
				}
				if (mutateObserveIsBlock && isDeclarationIdentifier(identifier, mutateObserveInfo.targets)) {
					continue;
				}
				if (isDeclarationIdentifier(identifier, forTargets)) {
					continue;
				}
				if (mutateObserveInfo.stateRange && identifier.start >= mutateObserveInfo.stateRange.start && identifier.start < mutateObserveInfo.stateRange.end) {
					continue;
				}
				if (isDeclarationIdentifier(identifier, lineDeclarations)) {
					continue;
				}
				if (isKeyword(identifier.name) || callableNames.has(identifier.name) || typeNames.has(identifier.name) || moduleConstants.has(identifier.name)) {
					continue;
				}
				if (identifier.name === "_") {
					continue;
				}
				if (isDeclarationIdentifier(identifier, mutateObserveInfo.targets)) {
					continue;
				}
				if (returnNames.has(identifier.name)) {
					if (isMemberAccess(scanLine, identifier.start)) {
						continue;
					}
					if (isCallLabel(scanLine, identifier.end) || isCallableUsage(scanLine, identifier.end)) {
						continue;
					}
					const retKeyword = scanLine.match(/\b(return|yield)\b/);
					if (retKeyword && retKeyword.index !== undefined && identifier.start > retKeyword.index + retKeyword[1].length) {
						continue;
					}
					const isObserveTarget = (mutateObserveInfo.verb === "observe"
						&& isDeclarationIdentifier(identifier, mutateObserveInfo.targets))
						|| isObserveTargetInLine(scanLine, identifier);
					if (!isAssignmentTarget(scanLine, identifier) && !isReturnTargetUsage(scanLine, identifier) && !isObserveTarget) {
						if (isCallOutputTarget(identifier, callOutputTargets)) {
							continue;
						}
						if (isFunctionArgument(scanLine, identifier.start)) {
							continue;
						}
						diagnostics.push({
							severity: DiagnosticSeverity.Error,
							range: {
								start: { line: lineIndex, character: identifier.start },
								end: { line: lineIndex, character: identifier.start + identifier.name.length }
							},
							message: `'${identifier.name}' is a write-only return value`,
							source: 'ex'
						});
					}
					continue;
				}
				if (isMemberAccess(scanLine, identifier.start)) {
					continue;
				}
				if (isCallLabel(scanLine, identifier.end) || isCallableUsage(scanLine, identifier.end)) {
					continue;
				}
				if (isCallOutputTarget(identifier, callOutputTargets)) {
					continue;
				}
				if (isCrossPackageRef(scanLine, identifier.start)) {
					continue;
				}
				if (!isDefinedInScopes(scopeStack, identifier.name)) {
					diagnostics.push({
						severity: DiagnosticSeverity.Error,
						range: {
							start: { line: lineIndex, character: identifier.start },
							end: { line: lineIndex, character: identifier.start + identifier.name.length }
						},
						message: `'${identifier.name}' is not defined in this scope`,
						source: 'ex'
					});
				}
			}

			for (const declaration of lineDeclarations) {
				scopeStack[scopeStack.length - 1].defined.add(declaration.name);
			}
			for (const target of forTargets) {
				if (target.name !== "_") {
					scopeStack[scopeStack.length - 1].defined.add(target.name);
				}
			}

			if (headerDeclarations.length > 0) {
				pendingBlockDeclarations = new Set(headerDeclarations.map(decl => decl.name));
			} else if (forTargets.length > 0) {
				pendingBlockDeclarations = new Set(forTargets.filter(t => t.name !== "_").map(t => t.name));
			} else {
				pendingBlockDeclarations = null;
			}

			prevLineEndsBlock = isBlockStarter(scanLine);
		}
	}
};

const getIdentifierCandidates = (line: string): Array<{ name: string; start: number; end: number }> => {
	const results: Array<{ name: string; start: number; end: number }> = [];
	for (const match of line.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
		const name = match[0];
		const start = match.index ?? -1;
		if (start < 0) {
			continue;
		}
		results.push({ name, start, end: start + name.length });
	}
	return results;
};

const getStringRanges = (line: string): Array<{ start: number; end: number }> => {
	const ranges: Array<{ start: number; end: number }> = [];
	let i = 0;
	while (i < line.length) {
		const ch = line[i];
		if (ch !== "\"" && ch !== "'") {
			i += 1;
			continue;
		}
		const quote = ch;
		let start = i;
		if (start > 0 && line[start - 1] === "f" && (start === 1 || !isWordChar(line[start - 2]))) {
			start -= 1;
		}
		i += 1;
		while (i < line.length) {
			if (line[i] === "\\" && i + 1 < line.length) {
				i += 2;
				continue;
			}
			if (line[i] === quote) {
				i += 1;
				break;
			}
			i += 1;
		}
		ranges.push({ start, end: i });
	}
	return ranges;
};

const extractFStringChunks = (line: string): Array<{ start: number; end: number }> => {
	const chunks: Array<{ start: number; end: number }> = [];
	let i = 0;
	while (i < line.length) {
		const ch = line[i];
		if (ch !== "\"" && ch !== "'") {
			i += 1;
			continue;
		}
		const quote = ch;
		const isFString = i > 0 && line[i - 1] === "f" && (i === 1 || !isWordChar(line[i - 2]));
		i += 1; // skip opening quote
		if (!isFString) {
			// skip non-f-string content
			while (i < line.length) {
				if (line[i] === "\\" && i + 1 < line.length) { i += 2; continue; }
				if (line[i] === quote) { i += 1; break; }
				i += 1;
			}
			continue;
		}
		// Inside f-string: scan for { } chunks
		while (i < line.length) {
			if (line[i] === "\\" && i + 1 < line.length) { i += 2; continue; }
			if (line[i] === quote) { i += 1; break; }
			if (line[i] === "{") {
				if (i + 1 < line.length && line[i + 1] === "{") {
					i += 2; // escaped {{
					continue;
				}
				// Start of expression
				const exprStart = i + 1;
				let depth = 1;
				i += 1;
				while (i < line.length && depth > 0) {
					if (line[i] === "{") { depth++; }
					else if (line[i] === "}") { depth--; }
					if (depth > 0) { i += 1; }
				}
				if (depth === 0) {
					chunks.push({ start: exprStart, end: i });
					i += 1; // skip closing }
				}
			} else if (line[i] === "}" && i + 1 < line.length && line[i + 1] === "}") {
				i += 2; // escaped }}
			} else {
				i += 1;
			}
		}
	}
	return chunks;
};

const isInsideRanges = (pos: number, ranges: Array<{ start: number; end: number }>): boolean => {
	for (const range of ranges) {
		if (pos >= range.start && pos < range.end) {
			return true;
		}
	}
	return false;
};

const isMemberAccess = (line: string, start: number): boolean => {
	let i = start - 1;
	while (i >= 0 && /\s/.test(line[i])) {
		i -= 1;
	}
	return i >= 0 && line[i] === ".";
};

const isFunctionArgument = (line: string, start: number): boolean => {
	let depth = 0;
	for (let i = start - 1; i >= 0; i--) {
		if (line[i] === ")") { depth++; }
		if (line[i] === "(") {
			if (depth === 0) { return true; }
			depth--;
		}
	}
	return false;
};

const isCrossPackageRef = (line: string, start: number): boolean => {
	return start >= 2 && line[start - 1] === ":" && line[start - 2] === ":";
};

const isCallLabel = (line: string, end: number): boolean => {
	let i = end;
	while (i < line.length && /\s/.test(line[i])) {
		i += 1;
	}
	return i < line.length && line[i] === ":";
};

const isCallableUsage = (line: string, end: number): boolean => {
	let i = end;
	while (i < line.length && /\s/.test(line[i])) {
		i += 1;
	}
	return i < line.length && line[i] === "(";
};

const isKeyword = (name: string): boolean => {
	return cocoKeywords.has(name);
};

const isAssignmentTarget = (
	line: string,
	identifier: { name: string; start: number; end: number }
): boolean => {
	const nameIndex = line.indexOf(identifier.name);
	if (nameIndex !== identifier.start) {
		return false;
	}

	const incMatch = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(\+\+|--)/);
	if (incMatch && incMatch[1] === identifier.name) {
		return true;
	}

	const assignMatch = line.match(/^(\s*.+?)(\+=|-=|\*=|\/=|%=|=)/);
	if (!assignMatch) {
		return false;
	}

	const op = assignMatch[2];
	if (op === "=") {
		const opIndex = line.indexOf("=");
		const prevChar = opIndex > 0 ? line[opIndex - 1] : "";
		const nextChar = opIndex + 1 < line.length ? line[opIndex + 1] : "";
		if (prevChar === "=" || prevChar === "!" || prevChar === "<" || prevChar === ">" || nextChar === "=") {
			return false;
		}
	}

	const leftPart = line.slice(0, line.indexOf(assignMatch[2])).trim();
	for (const part of leftPart.split(",")) {
		const trimmedPart = part.trim();
		if (trimmedPart === identifier.name) {
			return true;
		}
		if (trimmedPart.startsWith(identifier.name)) {
			const nextChar = trimmedPart[identifier.name.length];
			if (nextChar === "[" || nextChar === ".") {
				return true;
			}
		}
	}

	return false;
};

const isReturnTargetUsage = (
	line: string,
	identifier: { name: string; start: number; end: number }
): boolean => {
	const targets = getReturnTargets(line);
	return targets.some(target => target.start === identifier.start && target.end === identifier.end);
};

const getMutateObserveVerbRange = (
	line: string,
	verb: "mutate" | "observe"
): { start: number; end: number } | null => {
	const match = line.match(/^\s*(mutate|observe)\b/);
	if (!match || match[1] !== verb) {
		return null;
	}
	const start = line.indexOf(match[1], match.index ?? 0);
	if (start < 0) {
		return null;
	}
	return { start, end: start + match[1].length };
};

const extractForTargets = (line: string): Array<{ name: string; start: number; end: number }> => {
	const match = line.match(/^\s*for\s+(.+?)\s+in\s+.+?:?\s*$/);
	if (!match) {
		return [];
	}

	const segment = match[1];
	const segmentStart = line.indexOf(segment, match.index ?? 0);
	if (segmentStart < 0) {
		return [];
	}

	const results: Array<{ name: string; start: number; end: number }> = [];
	for (const identifier of getIdentifierCandidates(segment)) {
		results.push({
			name: identifier.name,
			start: segmentStart + identifier.start,
			end: segmentStart + identifier.end
		});
	}
	return results;
};

const isObserveTargetInLine = (
	line: string,
	identifier: { name: string; start: number; end: number }
): boolean => {
	const trimmed = line.trimStart();
	if (!trimmed.startsWith("observe") && !trimmed.startsWith("gather") && !trimmed.startsWith("disperse")) {
		return false;
	}
	const arrowIndex = Math.max(line.indexOf("<-"), line.indexOf("->"));
	if (arrowIndex === -1) {
		return false;
	}
	return identifier.end <= arrowIndex;
};

const getReturnNamesAndPositions = (
	lines: string[],
	startLine: number
): Map<string, { line: number; character: number }> => {
	const results = new Map<string, { line: number; character: number }>();
	let inReturns = false;
	let returnStartIndex = -1;

	for (let lineIndex = startLine; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex];
		if (!inReturns) {
			const arrowIndex = line.indexOf("->");
			if (arrowIndex === -1) {
				if (lineIndex > startLine && line.trim().endsWith(":")) {
					break;
				}
				continue;
			}
			const parenIndex = line.indexOf("(", arrowIndex);
			if (parenIndex === -1) {
				continue;
			}
			inReturns = true;
			returnStartIndex = parenIndex + 1;
		}

		if (!inReturns) {
			continue;
		}

		const segmentStart = lineIndex === startLine ? returnStartIndex : 0;
		let segmentEnd = line.length;
		const closeIndex = line.indexOf(")", segmentStart);
		if (closeIndex !== -1) {
			segmentEnd = closeIndex;
		}

		const segmentText = line.slice(segmentStart, segmentEnd);
		const parts = segmentText.split(",");
		let offset = segmentStart;
		for (const part of parts) {
			const match = part.match(/\b([A-Za-z_][A-Za-z0-9_]*)\b/);
			if (match) {
				const name = match[1];
				const nameIndex = line.indexOf(name, offset);
				if (nameIndex >= 0 && !results.has(name)) {
					results.set(name, { line: lineIndex, character: nameIndex });
				}
			}
			offset += part.length + 1;
		}

		if (closeIndex !== -1) {
			break;
		}
	}

	return results;
};

const findForTargetDefinition = (
	lines: string[],
	callableRange: { name: string; indent: number; startLine: number },
	target: string,
	maxLine: number
): { line: number; character: number } | null => {
	let definition: { line: number; character: number } | null = null;
	let blockIndent = 0;
	let blockActive = false;

	for (let lineIndex = callableRange.startLine + 1; lineIndex <= maxLine && lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex];
		const lineIndent = line.match(/^\s*/)?.[0].length ?? 0;
		const isBlank = line.trim().length === 0;
		const inlineBlock = splitInlineBlock(line);

		if (!isBlank && lineIndent <= callableRange.indent) {
			break;
		}

		if (blockActive) {
			if (!isBlank && lineIndent <= blockIndent) {
				blockActive = false;
			}
		}

		const headerMatch = line.match(/^\s*(memory|storage)\s*:\s*$/);
		if (headerMatch) {
			blockActive = true;
			blockIndent = lineIndent;
			continue;
		}

		const targets = extractForTargets(inlineBlock ? inlineBlock.header : line);
		for (const forTarget of targets) {
			if (forTarget.name === target) {
				let character = forTarget.start;
				if (inlineBlock) {
					const headerStart = line.indexOf(inlineBlock.header);
					if (headerStart >= 0) {
						character = headerStart + forTarget.start;
					}
				}
				definition = { line: lineIndex, character };
			}
		}
	}

	return definition;
};

const getReturnTargets = (
	line: string,
	stringRanges: Array<{ start: number; end: number }> = []
): Array<{ name: string; start: number; end: number }> => {
	const keywordMatch = line.match(/\b(return|yield)\b/);
	if (!keywordMatch || keywordMatch.index === undefined) {
		return [];
	}
	const keyword = keywordMatch[1];
	const keywordIndex = keywordMatch.index;
	if (isInsideRanges(keywordIndex, stringRanges)) {
		return [];
	}
	const afterReturn = line.slice(keywordIndex + keyword.length);
	const offset = keywordIndex + keyword.length;
	const results: Array<{ name: string; start: number; end: number }> = [];

	if (keyword === "yield") {
		const yieldMatch = afterReturn.match(/^\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
		if (yieldMatch) {
			const name = yieldMatch[1];
			const nameStart = offset + (yieldMatch.index ?? 0) + yieldMatch[0].indexOf(name);
			results.push({ name, start: nameStart, end: nameStart + name.length });
		}
		return results;
	}

	const tupleMatch = afterReturn.match(/\(([^)]*)\)/);
	if (tupleMatch) {
		const tupleStart = afterReturn.indexOf(tupleMatch[0]);
		for (const match of tupleMatch[1].matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) {
			const name = match[1];
			const nameStart = offset + tupleStart + 1 + (match.index ?? 0);
			results.push({ name, start: nameStart, end: nameStart + name.length });
		}
		return results;
	}

	const braceMatch = afterReturn.match(/\{([^}]*)\}/);
	if (braceMatch) {
		const braceStart = afterReturn.indexOf(braceMatch[0]);
		for (const match of braceMatch[1].matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) {
			const name = match[1];
			const nameStart = offset + braceStart + 1 + (match.index ?? 0);
			results.push({ name, start: nameStart, end: nameStart + name.length });
		}
		return results;
	}

	const match = afterReturn.match(/\b([A-Za-z_][A-Za-z0-9_]*)\b/);
	if (match) {
		const name = match[1];
		const nameStart = offset + (match.index ?? 0);
		results.push({ name, start: nameStart, end: nameStart + name.length });
	}

	return results;
};

const getCallOutputTargets = (line: string): Array<{ name: string; start: number; end: number }> => {
	const results: Array<{ name: string; start: number; end: number }> = [];
	const pattern = /\(([^)]*)\)\s*<-/g;
	for (const match of line.matchAll(pattern)) {
		if (match.index === undefined) {
			continue;
		}
		const segment = match[1];
		const segmentStart = match.index + 1;
		for (const nameMatch of segment.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
			const name = nameMatch[0];
			const nameIndex = nameMatch.index ?? -1;
			if (nameIndex < 0) {
				continue;
			}
			const start = segmentStart + nameIndex;
			results.push({ name, start, end: start + name.length });
		}
	}
	return results;
};

const isCallOutputTarget = (
	identifier: { name: string; start: number; end: number },
	targets: Array<{ name: string; start: number; end: number }>
): boolean => {
	return targets.some(target => target.name === identifier.name && target.start === identifier.start && target.end === identifier.end);
};

const isDefinedInScopes = (scopes: Array<{ defined: Set<string> }>, name: string): boolean => {
	for (let i = scopes.length - 1; i >= 0; i--) {
		if (scopes[i].defined.has(name)) {
			return true;
		}
	}
	return false;
};

const splitInlineBlock = (line: string): { header: string; body: string; bodyStart: number } | null => {
	const trimStart = line.match(/^\s*/)?.[0].length ?? 0;
	let depth = 0;
	let splitAt = -1;

	for (let i = trimStart; i < line.length; i++) {
		const ch = line[i];
		if (ch === "(" || ch === "[" || ch === "{") { depth++; }
		if (ch === ")" || ch === "]" || ch === "}") { depth--; }
		if (ch === ":" && depth === 0) {
			// Check if followed by whitespace and content (inline block)
			let j = i + 1;
			while (j < line.length && /\s/.test(line[j])) { j++; }
			if (j < line.length) {
				splitAt = i;
				break;
			}
		}
	}

	if (splitAt < 0) {
		return null;
	}

	const header = line.slice(trimStart, splitAt).trim();
	if (!isBlockStarter(`${header}:`)) {
		return null;
	}

	let bodyStart = splitAt + 1;
	while (bodyStart < line.length && /\s/.test(line[bodyStart])) { bodyStart++; }
	const body = line.slice(bodyStart);
	return { header, body, bodyStart };
};

const extractInlineBlockKeywords = (header: string): Set<string> => {
	const keywords = new Set<string>();
	for (const match of header.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
		const name = match[0];
		if (isKeyword(name)) {
			keywords.add(name);
		}
	}
	return keywords;
};

const isInlineBlockKeyword = (keywords: Set<string> | null, name: string): boolean => {
	return keywords ? keywords.has(name) : false;
};

const isBlockStarter = (line: string): boolean => {
	const trimmed = line.trim();
	if (!trimmed.endsWith(":")) {
		return false;
	}
	const withoutColon = trimmed.slice(0, -1).trim();
	return /^(if|else(\s+if)?|for|try|catch|finally|switch|case|default|mutate|observe|class|event|state|interface|endpoint|asset|method|function|imports)\b/.test(withoutColon);
};

const getVariableDeclarationsForLine = (
	line: string,
	blockActive: boolean,
	blockIndent: number,
	lineIndent: number,
	isBlank: boolean
): Array<{ name: string; start: number; end: number }> => {
	if (blockActive && !isBlank && lineIndent > blockIndent) {
		if (/^\s*\/\//.test(line)) {
			return [];
		}
		const groupedMatch = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\b/);
		if (!groupedMatch) {
			return [];
		}
		const name = groupedMatch[1];
		const start = line.indexOf(name, groupedMatch.index ?? 0);
		return start >= 0 ? [{ name, start, end: start + name.length }] : [];
	}

	const results: Array<{ name: string; start: number; end: number }> = [];
	for (const variable of extractInlineVariableDeclarations(line)) {
		results.push({ name: variable.name, start: variable.character, end: variable.character + variable.name.length });
	}

	const constMatch = line.match(/^\s*const\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
	if (constMatch) {
		const name = constMatch[1];
		const start = line.indexOf(name, (constMatch.index ?? 0) + 5);
		if (start >= 0) {
			results.push({ name, start, end: start + name.length });
		}
	}

	return results;
};

const isDeclarationIdentifier = (
	identifier: { name: string; start: number; end: number },
	declarations: Array<{ name: string; start: number; end: number }>
): boolean => {
	return declarations.some(decl => decl.name === identifier.name && decl.start === identifier.start && decl.end === identifier.end);
};

const extractMutateObserveInfo = (
	line: string
): {
	verb: "mutate" | "observe" | null;
	targets: Array<{ name: string; start: number; end: number }>;
	stateRef: string | null;
	stateRange: { start: number; end: number } | null;
} => {
	const match = line.match(/^\s*(mutate|observe)\s+(.+?)\s*(<-|->)\s*([^:]+?)\s*:?\s*(?:\/\/.*)?$/);
	if (!match) {
		return { verb: null, targets: [], stateRef: null, stateRange: null };
	}

	const verb = match[1] === "mutate" ? "mutate" : "observe";
	const targetsSegment = match[2];
	const stateRef = match[4].trim();
	const matchIndex = match.index ?? 0;
	const matchText = match[0];
	const verbEnd = matchText.indexOf(match[1]) + match[1].length;
	const segmentOffset = matchText.indexOf(targetsSegment, verbEnd);
	const segmentStart = segmentOffset >= 0 ? matchIndex + segmentOffset : -1;
	const stateOffset = matchText.indexOf(stateRef, segmentOffset + targetsSegment.length);
	const stateStart = stateOffset >= 0 ? matchIndex + stateOffset : line.indexOf(stateRef, segmentStart + targetsSegment.length);
	const stateRange = stateStart >= 0 ? { start: stateStart, end: stateStart + stateRef.length } : null;

	const targets: Array<{ name: string; start: number; end: number }> = [];
	for (const identifier of getIdentifierCandidates(targetsSegment)) {
		if (isMemberAccess(targetsSegment, identifier.start)) {
			continue;
		}
		const start = segmentStart >= 0 ? segmentStart + identifier.start : identifier.start;
		targets.push({ name: identifier.name, start, end: start + identifier.name.length });
	}

	return { verb, targets, stateRef, stateRange };
};

const cocoKeywords = new Set<string>([
	"if",
	"else",
	"for",
	"break",
	"pass",
	"continue",
	"return",
	"yield",
	"throw",
	"revert",
	"from",
	"in",
	"observe",
	"transfer",
	"disperse",
	"gather",
	"generate",
	"sweep",
	"try",
	"catch",
	"field",
	"topic",
	"Map",
	"coco",
	"state",
	"event",
	"asset",
	"endpoint",
	"function",
	"method",
	"class",
	"interface",
	"mutate",
	"persistent",
	"ephemeral",
	"readonly",
	"static",
	"dynamic",
	"pure",
	"invoke",
	"enlist",
	"deploy",
	"memory",
	"storage",
	"const",
	"logic",
	"actor",
	"len",
	"join",
	"remove",
	"emit",
	"true",
	"false",
	"self",
	"Sender",
	"Receiver",
	"State",
	"Builtins",
	"Invocation",
	"Environment",
	"blake2b",
	"keccak256",
	"sha256",
	"sigverify",
	"polorize",
	"depolorize",
	"grow",
	"shrink",
	"switch",
	"case",
	"default"
]);

const ASSET_METHODS = new Map<string, { args: string[]; returns: string[] }>([
	["Transfer",      { args: ["token_id", "beneficiary", "amount"], returns: [] }],
	["TransferFrom",  { args: ["token_id", "benefactor", "beneficiary", "amount"], returns: [] }],
	["Mint",          { args: ["token_id", "beneficiary", "amount"], returns: [] }],
	["MintWithMetadata", { args: ["token_id", "beneficiary", "amount", "static_metadata"], returns: [] }],
	["Burn",          { args: ["token_id", "amount"], returns: [] }],
	["Approve",       { args: ["token_id", "beneficiary", "amount", "expires_at"], returns: [] }],
	["Revoke",        { args: ["token_id", "beneficiary"], returns: [] }],
	["Lockup",        { args: ["token_id", "beneficiary", "amount"], returns: [] }],
	["Release",       { args: ["token_id", "benefactor", "beneficiary", "amount"], returns: [] }],
	["Symbol",        { args: [], returns: ["symbol"] }],
	["BalanceOf",     { args: ["token_id", "address"], returns: ["balance"] }],
	["Creator",       { args: [], returns: ["creator"] }],
	["Manager",       { args: [], returns: ["manager"] }],
	["Decimals",      { args: [], returns: ["decimals"] }],
	["MaxSupply",     { args: [], returns: ["max_supply"] }],
	["CirculatingSupply", { args: [], returns: ["circulating_supply"] }],
	["EnableEvents",  { args: [], returns: ["enable_events"] }],
	["SetStaticMetadata",  { args: ["key", "value"], returns: [] }],
	["SetDynamicMetadata", { args: ["key", "value"], returns: [] }],
	["GetStaticMetadata",  { args: ["key"], returns: ["value"] }],
	["GetDynamicMetadata", { args: ["key"], returns: ["value"] }],
	["SetStaticTokenMetadata",  { args: ["token_id", "key", "value"], returns: [] }],
	["SetDynamicTokenMetadata", { args: ["token_id", "key", "value"], returns: [] }],
	["GetStaticTokenMetadata",  { args: ["token_id", "key"], returns: ["value"] }],
	["GetDynamicTokenMetadata", { args: ["token_id", "key"], returns: ["value"] }],
	["Define", { args: ["symbol", "decimals", "manager", "creator", "max_supply", "enable_events"], returns: [] }],
]);

const getArgumentNameAtPosition = (argsText: string, argsStart: number, position: number): string | null => {
	let depth = 0;
	let segmentStart = 0;

	for (let i = 0; i <= argsText.length; i++) {
		const ch = argsText[i];
		if (ch === "(") {
			depth += 1;
		} else if (ch === ")") {
			depth -= 1;
		}

		const isEnd = i === argsText.length || (ch === "," && depth === 0);
		if (!isEnd) {
			continue;
		}

		const segment = argsText.slice(segmentStart, i);
		const nameMatch = segment.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/);
		if (nameMatch) {
			const name = nameMatch[1];
			const nameOffset = segment.indexOf(name);
			const nameStart = argsStart + segmentStart + nameOffset;
			const nameEnd = nameStart + name.length;
			if (position >= nameStart && position <= nameEnd) {
				return name;
			}
		}

		segmentStart = i + 1;
	}

	return null;
};

const findVariableDefinition = (
	text: string,
	target: string,
	maxLine: number,
	callableIndex: CallableIndex
): { line: number; character: number } | null => {
	const lines = text.split(/\r?\n/);
	const callableRange = getEnclosingCallableRange(lines, maxLine, callableIndex.callableRanges);
	const callableName = callableRange?.name ?? null;
	if (callableName) {
		const callable = callableIndex.callables.get(callableName);
		const param = callable?.params.get(target);
		if (param) {
			return { line: param.line, character: param.character };
		}
		const returns = callable?.returns.get(target);
		if (returns) {
			return { line: returns.line, character: returns.character };
		}
		if (callableRange) {
			const returnDefinition = getReturnNamesAndPositions(lines, callableRange.startLine).get(target);
			if (returnDefinition) {
				return { line: returnDefinition.line, character: returnDefinition.character };
			}
			const forDefinition = findForTargetDefinition(lines, callableRange, target, maxLine);
			if (forDefinition) {
				return forDefinition;
			}
		}
	}

	let best: { line: number; character: number } | null = null;
	if (!callableRange) {
		return best;
	}

	const endLine = getCallableEndLine(lines, { line: callableRange.startLine, indent: callableRange.indent });
	for (const variable of collectVariableDeclarationsInRange(
		lines,
		callableRange.startLine + 1,
		Math.min(maxLine, endLine)
	)) {
		if (variable.name === target && variable.line <= maxLine) {
			best = { line: variable.line, character: variable.character };
		}
	}

	return best;
};

const findTypeForReceiver = (
	text: string,
	receiver: string,
	maxLine: number,
	callableIndex: CallableIndex
): string | null => {
	const lines = text.split(/\r?\n/);
	const callableRange = getEnclosingCallableRange(lines, maxLine, callableIndex.callableRanges);
	if (!callableRange) {
		return null;
	}

	const assignmentPattern = /^\s*(?:memory|storage|const)?\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\s*(\(|\{)/;
	const typedDeclarationPattern = /^\s*(?:memory|storage)\s+([A-Za-z_][A-Za-z0-9_]*)\s+(?:\[\])?([A-Za-z_][A-Za-z0-9_]*)\b/;
	const groupedTypedPattern = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s+(?:\[\])?([A-Za-z_][A-Za-z0-9_]*)\b/;
	let found: string | null = null;
	let blockIndent = 0;
	let blockActive = false;

	// Check callable parameter types
	const sigLine = lines[callableRange.startLine];
	const parenMatch = sigLine.match(/\(([^)]*)\)/);
	if (parenMatch) {
		for (const part of parenMatch[1].split(",")) {
			const paramTypeMatch = part.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s+(?:\[\])?([A-Za-z_][A-Za-z0-9_]*)/);
			if (paramTypeMatch && paramTypeMatch[1] === receiver) {
				found = paramTypeMatch[2];
			}
		}
	}

	for (let lineIndex = callableRange.startLine + 1; lineIndex <= maxLine && lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex];
		const lineIndent = line.match(/^\s*/)?.[0].length ?? 0;
		const isBlank = line.trim().length === 0;
		const inlineBlock = splitInlineBlock(line);
		if (!isBlank && lineIndent <= callableRange.indent) {
			break;
		}

		if (inlineBlock) {
			const assignmentMatch = inlineBlock.body.match(assignmentPattern);
			if (assignmentMatch && assignmentMatch[1] === receiver) {
				found = assignmentMatch[2];
			}
			const typedMatch = inlineBlock.body.match(typedDeclarationPattern);
			if (typedMatch && typedMatch[1] === receiver) {
				found = typedMatch[2];
			}
			continue;
		}

		if (blockActive) {
			if (!isBlank && lineIndent <= blockIndent) {
				blockActive = false;
			}
		}

		const headerMatch = line.match(/^\s*(memory|storage)\s*:\s*$/);
		if (headerMatch) {
			blockActive = true;
			blockIndent = lineIndent;
			continue;
		}

		const assignmentMatch = line.match(assignmentPattern);
		if (assignmentMatch && assignmentMatch[1] === receiver) {
			found = assignmentMatch[2];
		}

		if (blockActive && !isBlank && lineIndent > blockIndent) {
			const groupedMatch = line.match(groupedTypedPattern);
			if (groupedMatch && groupedMatch[1] === receiver) {
				found = groupedMatch[2];
			}
		} else {
			const typedMatch = line.match(typedDeclarationPattern);
			if (typedMatch && typedMatch[1] === receiver) {
				found = typedMatch[2];
			}
		}
	}

	return found;
};

const findAssignedTypeGlobal = (
	text: string,
	receiver: string,
	maxLine: number
): string | null => {
	const lines = text.split(/\r?\n/);
	const assignmentPattern = /^\s*(?:memory|storage|const)?\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\s*(\(|\{)/;
	const typedDeclarationPattern = /^\s*(?:memory|storage)\s+([A-Za-z_][A-Za-z0-9_]*)\s+(?:\[\])?([A-Za-z_][A-Za-z0-9_]*)\b/;
	const groupedTypedPattern = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s+(?:\[\])?([A-Za-z_][A-Za-z0-9_]*)\b/;
	let blockIndent = 0;
	let blockActive = false;
	let found: string | null = null;

	for (let lineIndex = 0; lineIndex <= maxLine && lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex];
		const lineIndent = line.match(/^\s*/)?.[0].length ?? 0;
		const isBlank = line.trim().length === 0;
		const inlineBlock = splitInlineBlock(line);

		if (inlineBlock) {
			const assignmentMatch = inlineBlock.body.match(assignmentPattern);
			if (assignmentMatch && assignmentMatch[1] === receiver) {
				found = assignmentMatch[2];
			}
			const typedMatch = inlineBlock.body.match(typedDeclarationPattern);
			if (typedMatch && typedMatch[1] === receiver) {
				found = typedMatch[2];
			}
		}

		if (blockActive) {
			if (!isBlank && lineIndent <= blockIndent) {
				blockActive = false;
			}
		}

		const headerMatch = line.match(/^\s*(memory|storage)\s*:\s*$/);
		if (headerMatch) {
			blockActive = true;
			blockIndent = lineIndent;
			continue;
		}

		const assignmentMatch = line.match(assignmentPattern);
		if (assignmentMatch && assignmentMatch[1] === receiver) {
			found = assignmentMatch[2];
		}

		if (blockActive && !isBlank && lineIndent > blockIndent) {
			const groupedMatch = line.match(groupedTypedPattern);
			if (groupedMatch && groupedMatch[1] === receiver) {
				found = groupedMatch[2];
			}
		} else {
			const typedMatch = line.match(typedDeclarationPattern);
			if (typedMatch && typedMatch[1] === receiver) {
				found = typedMatch[2];
			}
		}
	}

	return found;
};

const resolveInterfaceReceiver = (
	text: string,
	receiver: string,
	maxLine: number,
	interfaceStateIndex: InterfaceStateIndex
): string | null => {
	const lines = text.split(/\r?\n/);
	const assignmentPattern = /^\s*(?:memory|storage|const)?\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\s*(\(|\{)/;
	const typedDeclarationPattern = /^\s*(?:memory|storage)\s+([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)\b/;
	const groupedTypedPattern = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)\b/;
	let blockIndent = 0;
	let blockActive = false;

	for (let lineIndex = 0; lineIndex <= maxLine && lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex];
		const lineIndent = line.match(/^\s*/)?.[0].length ?? 0;
		const isBlank = line.trim().length === 0;
		const inlineBlock = splitInlineBlock(line);

		if (inlineBlock) {
			const assignmentMatch = inlineBlock.body.match(assignmentPattern);
			if (assignmentMatch && assignmentMatch[1] === receiver && interfaceStateIndex.interfaces.has(assignmentMatch[2])) {
				return assignmentMatch[2];
			}
			const typedMatch = inlineBlock.body.match(typedDeclarationPattern);
			if (typedMatch && typedMatch[1] === receiver && interfaceStateIndex.interfaces.has(typedMatch[2])) {
				return typedMatch[2];
			}
		}

		if (blockActive) {
			if (!isBlank && lineIndent <= blockIndent) {
				blockActive = false;
			}
		}

		const headerMatch = line.match(/^\s*(memory|storage)\s*:\s*$/);
		if (headerMatch) {
			blockActive = true;
			blockIndent = lineIndent;
			continue;
		}

		const assignmentMatch = line.match(assignmentPattern);
		if (assignmentMatch && assignmentMatch[1] === receiver && interfaceStateIndex.interfaces.has(assignmentMatch[2])) {
			return assignmentMatch[2];
		}

		if (blockActive && !isBlank && lineIndent > blockIndent) {
			const groupedMatch = line.match(groupedTypedPattern);
			if (groupedMatch && groupedMatch[1] === receiver && interfaceStateIndex.interfaces.has(groupedMatch[2])) {
				return groupedMatch[2];
			}
		} else {
			const typedMatch = line.match(typedDeclarationPattern);
			if (typedMatch && typedMatch[1] === receiver && interfaceStateIndex.interfaces.has(typedMatch[2])) {
				return typedMatch[2];
			}
		}
	}

	return null;
};

const getEnclosingCallableRange = (
	lines: string[],
	lineNumber: number,
	callableRanges: Array<{ name: string; line: number; indent: number }>
): { name: string; indent: number; startLine: number } | null => {
	let current: { name: string; indent: number; startLine: number } | null = null;
	for (let lineIndex = 0; lineIndex <= lineNumber && lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex];
		const lineIndent = line.match(/^\s*/)?.[0].length ?? 0;
		const isBlank = line.trim().length === 0;

		const match = callableRanges.find(range => range.line === lineIndex);
		if (match) {
			current = { name: match.name, indent: match.indent, startLine: match.line };
			continue;
		}

		if (current && !isBlank && lineIndent <= current.indent) {
			current = null;
		}
	}

	return current;
};

const collectVariableDeclarationsInRange = (
	lines: string[],
	startLine: number,
	endLine: number
): Array<{ name: string; line: number; character: number }> => {
	const results: Array<{ name: string; line: number; character: number }> = [];
	let blockIndent = 0;
	let blockActive = false;

	for (let lineIndex = startLine; lineIndex <= endLine && lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex];
		const lineIndent = line.match(/^\s*/)?.[0].length ?? 0;
		const isBlank = line.trim().length === 0;
		const inlineBlock = splitInlineBlock(line);

		if (blockActive) {
			if (!isBlank && lineIndent <= blockIndent) {
				blockActive = false;
			}
		}

		const headerMatch = line.match(/^\s*(memory|storage)\s*:\s*$/);
		if (headerMatch) {
			blockActive = true;
			blockIndent = lineIndent;
			continue;
		}

		if (inlineBlock) {
			for (const variable of extractInlineVariableDeclarations(inlineBlock.body)) {
				results.push({
					name: variable.name,
					line: lineIndex,
					character: inlineBlock.bodyStart + variable.character
				});
			}
			const inlineMutateInfo = extractMutateObserveInfo(inlineBlock.header);
			if (inlineMutateInfo.verb && inlineBlock.header.trim().endsWith(":")) {
				for (const declaration of inlineMutateInfo.targets) {
					results.push({ name: declaration.name, line: lineIndex, character: declaration.start });
				}
			}
			continue;
		}

		if (blockActive && !isBlank && lineIndent > blockIndent) {
			if (/^\s*\/\//.test(line)) {
				continue;
			}
			const groupedMatch = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\b/);
			if (groupedMatch) {
				const name = groupedMatch[1];
				const nameIndex = line.indexOf(name, groupedMatch.index ?? 0);
				if (nameIndex >= 0) {
					results.push({ name, line: lineIndex, character: nameIndex });
				}
			}
			continue;
		}

		for (const variable of extractInlineVariableDeclarations(line)) {
			results.push({ name: variable.name, line: lineIndex, character: variable.character });
		}

		const mutateInfo = extractMutateObserveInfo(line);
		if (mutateInfo.verb && line.trim().endsWith(":")) {
			for (const declaration of mutateInfo.targets) {
				results.push({ name: declaration.name, line: lineIndex, character: declaration.start });
			}
		}
	}

	return results;
};

const extractInlineVariableDeclarations = (line: string): { name: string; character: number }[] => {
	const match = line.match(/^\s*(?:generate\s+)?(memory|storage)\s+((?:[A-Za-z_][A-Za-z0-9_]*\s*,\s*)*[A-Za-z_][A-Za-z0-9_]*)/);
	if (!match) {
		return [];
	}

	const variablesSegment = match[2];
	const matchIndex = match.index ?? 0;
	const keywordEnd = match[0].indexOf(match[1]) + match[1].length;
	const matchSegmentIndex = match[0].indexOf(variablesSegment, keywordEnd);
	const segmentIndex = matchSegmentIndex >= 0 ? matchIndex + matchSegmentIndex : -1;
	if (segmentIndex < 0) {
		return [];
	}

	const results: { name: string; character: number }[] = [];
	for (const variableMatch of variablesSegment.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
		const name = variableMatch[0];
		const offset = variableMatch.index ?? 0;
		results.push({ name, character: segmentIndex + offset });
	}

	return results;
};

const findDefinition = (text: string, target: string): { line: number; character: number } | null => {
	const lines = text.split(/\r?\n/);
	const endpointPattern = /^\s*endpoint\s+(?:(?:invoke|enlist|deploy)\s+)?(?:(?:ephemeral|persistent|readonly|static|dynamic|pure)\s+)?([A-Za-z_][A-Za-z0-9_]*)\b/;
	const functionPattern = /^\s*function\s+(?:(?:persistent|ephemeral|readonly|static|dynamic|pure)\s+)?([A-Za-z_][A-Za-z0-9_]*)\b/;
	const methodPattern = /^\s*method\s+(?:(?:mutate|observe)\s+)?([A-Za-z_][A-Za-z0-9_!]*)\b/;
	const classPattern = /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\b(?=\s*:)/;
	const eventPattern = /^\s*event\s+([A-Za-z_][A-Za-z0-9_]*)\b/;

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex];

		const endpointMatch = line.match(endpointPattern);
		if (endpointMatch && endpointMatch[1] === target) {
			const nameIndex = line.indexOf(endpointMatch[1], endpointMatch.index ?? 0);
			return { line: lineIndex, character: nameIndex };
		}

		const functionMatch = line.match(functionPattern);
		if (functionMatch && functionMatch[1] === target) {
			const nameIndex = line.indexOf(functionMatch[1], functionMatch.index ?? 0);
			return { line: lineIndex, character: nameIndex };
		}

		const methodMatch = line.match(methodPattern);
		if (methodMatch && methodMatch[1] === target) {
			const nameIndex = line.indexOf(methodMatch[1], methodMatch.index ?? 0);
			return { line: lineIndex, character: nameIndex };
		}

		const classMatch = line.match(classPattern);
		if (classMatch && classMatch[1] === target) {
			const nameIndex = line.indexOf(classMatch[1], classMatch.index ?? 0);
			return { line: lineIndex, character: nameIndex };
		}

		const eventMatch = line.match(eventPattern);
		if (eventMatch && eventMatch[1] === target) {
			const nameIndex = line.indexOf(eventMatch[1], eventMatch.index ?? 0);
			return { line: lineIndex, character: nameIndex };
		}
	}

	return null;
};

const checkTypeLiteralProperties = (
	text: string,
	classIndex: ClassIndex,
	eventIndex: EventIndex,
	diagnostics: Diagnostic[]
): void => {
	const lines = text.split(/\r?\n/);

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex];
		const commentIndex = line.indexOf("//");
		const scanLine = commentIndex >= 0 ? line.slice(0, commentIndex) : line;

		for (const literal of findTypeLiteralCandidates(scanLine)) {
			const classInfo = classIndex.classes.get(literal.typeName);
			const eventInfo = eventIndex.events.get(literal.typeName);
			if (!classInfo && !eventInfo) {
				continue;
			}

			const allowed = new Set<string>();
			if (classInfo) {
				for (const name of classInfo.fields.keys()) {
					allowed.add(name);
				}
			}
			if (eventInfo) {
				for (const name of eventInfo.fields.keys()) {
					allowed.add(name);
				}
				for (const name of eventInfo.topics.keys()) {
					allowed.add(name);
				}
			}

			for (const property of parseLiteralProperties(literal.bodyText, literal.bodyStart)) {
				if (!allowed.has(property.name)) {
					diagnostics.push({
						severity: DiagnosticSeverity.Error,
						range: {
							start: { line: lineIndex, character: property.start },
							end: { line: lineIndex, character: property.start + property.name.length }
						},
						message: `'${property.name}' is not a member of ${literal.typeName}`,
						source: 'ex'
					});
				}
			}
		}
	}
};

const checkStateFieldReferences = (
	text: string,
	stateIndex: StateIndex,
	interfaceStateIndex: InterfaceStateIndex,
	diagnostics: Diagnostic[]
): void => {
	const lines = text.split(/\r?\n/);
	const callableIndex = buildCallableIndex(text);

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex];
		const commentIndex = line.indexOf("//");
		const scanLine = commentIndex >= 0 ? line.slice(0, commentIndex) : line;
		const info = extractMutateObserveInfo(scanLine);
		if (!info.stateRef) {
			continue;
		}

		const stateRefs = info.stateRef.split(",").map(s => s.trim()).filter(s => s.length > 0);
		const baseStart = info.stateRange?.start ?? scanLine.indexOf(info.stateRef);
		let refSearchStart = baseStart;

		for (const ref of stateRefs) {
			const refStart = scanLine.indexOf(ref, refSearchStart);
			refSearchStart = refStart >= 0 ? refStart + ref.length : refSearchStart;

			// Skip complex expressions like Actor(Identifier(addr)).field
			if (ref.includes("(")) {
				continue;
			}

			const parts = ref.split(".");
			if (parts.length !== 3) {
				if (refStart >= 0) {
					diagnostics.push({
						severity: DiagnosticSeverity.Error,
						range: {
							start: { line: lineIndex, character: refStart },
							end: { line: lineIndex, character: refStart + ref.length }
						},
						message: `State field identifier needs three elements`,
						source: 'ex'
					});
				}
				continue;
			}

			const [rootName, actorName, fieldName] = parts;
			const start = refStart >= 0 ? refStart : baseStart;

			if (stateIndex.moduleName && rootName === stateIndex.moduleName) {
				const isLogic = actorName === "Logic";
				const fields = isLogic ? stateIndex.logicFields : stateIndex.actorFields;
				if (!fields.has(fieldName)) {
					if (start >= 0) {
						const fieldStart = start + rootName.length + actorName.length + 2;
						diagnostics.push({
							severity: DiagnosticSeverity.Error,
							range: {
								start: { line: lineIndex, character: fieldStart },
								end: { line: lineIndex, character: fieldStart + fieldName.length }
							},
							message: `'${fieldName}' is not defined in state ${isLogic ? "logic" : "actor"}`,
							source: 'ex'
						});
					}
				}
				continue;
			}

			let receiverType = findTypeForReceiver(text, rootName, lineIndex, callableIndex);
			if (!receiverType) {
				receiverType = findAssignedTypeGlobal(text, rootName, lineIndex);
			}
			if (!receiverType) {
				receiverType = resolveInterfaceReceiver(text, rootName, lineIndex, interfaceStateIndex);
			}
			if (!receiverType && interfaceStateIndex.interfaces.has(rootName)) {
				receiverType = rootName;
			}

			const interfaceState = receiverType ? interfaceStateIndex.interfaces.get(receiverType) : undefined;
			if (!interfaceState) {
				continue;
			}

			const isLogic = actorName === "Logic";
			const fields = isLogic ? interfaceState.logicFields : interfaceState.actorFields;
			if (!fields.has(fieldName)) {
				if (start >= 0) {
					const fieldStart = start + rootName.length + actorName.length + 2;
					diagnostics.push({
						severity: DiagnosticSeverity.Error,
						range: {
							start: { line: lineIndex, character: fieldStart },
							end: { line: lineIndex, character: fieldStart + fieldName.length }
						},
						message: `'${fieldName}' is not defined in interface state ${isLogic ? "logic" : "actor"}`,
						source: 'ex'
					});
				}
			}

			if (info.verb === "mutate") {
				const verbRange = getMutateObserveVerbRange(scanLine, "mutate");
				if (verbRange) {
					diagnostics.push({
						severity: DiagnosticSeverity.Error,
						range: {
							start: { line: lineIndex, character: verbRange.start },
							end: { line: lineIndex, character: verbRange.end }
						},
						message: "mutate is not allowed on interface state",
						source: 'ex'
					});
				}
			}
		}
	}
};

const resolveVariableArrayKind = (
	text: string,
	varName: string,
	lineIndex: number,
	callableIndex: CallableIndex
): "varray" | "array" | null => {
	const lines = text.split(/\r?\n/);
	const callableRange = getEnclosingCallableRange(lines, lineIndex, callableIndex.callableRanges);
	if (!callableRange) {
		return null;
	}

	let result: "varray" | "array" | null = null;

	// Check function parameter types
	const sigLine = lines[callableRange.startLine];
	const parenMatch = sigLine.match(/\(([^)]*)\)/);
	if (parenMatch) {
		for (const part of parenMatch[1].split(",")) {
			const trimmed = part.trim();
			const m = trimmed.match(/^([A-Za-z_]\w*)\s+(\[\]|\[\d+\])/);
			if (m && m[1] === varName) {
				result = m[2] === "[]" ? "varray" : "array";
			}
		}
	}

	// Check local declarations
	let blockActive = false;
	let blockIndent = 0;

	for (let i = callableRange.startLine + 1; i <= lineIndex && i < lines.length; i++) {
		const line = lines[i];
		const lineIndent = line.match(/^\s*/)?.[0].length ?? 0;
		const isBlank = line.trim().length === 0;
		if (!isBlank && lineIndent <= callableRange.indent) {
			break;
		}

		if (blockActive && !isBlank && lineIndent <= blockIndent) {
			blockActive = false;
		}
		const headerMatch = line.match(/^\s*(memory|storage)\s*:\s*$/);
		if (headerMatch) {
			blockActive = true;
			blockIndent = lineIndent;
			continue;
		}

		// memory/storage var []Type or memory/storage var [N]Type
		const m = line.match(/^\s*(?:memory|storage)\s+([A-Za-z_]\w*)\s+(\[\]|\[\d+\])/);
		if (m && m[1] === varName) {
			result = m[2] === "[]" ? "varray" : "array";
		}

		// Inside memory/storage block: var []Type or var [N]Type
		const inBlock = blockActive && !isBlank && lineIndent > blockIndent;
		if (inBlock) {
			const grouped = line.match(/^\s*([A-Za-z_]\w*)\s+(\[\]|\[\d+\])/);
			if (grouped && grouped[1] === varName) {
				result = grouped[2] === "[]" ? "varray" : "array";
			}
		}
	}

	return result;
};

const checkEmitTypes = (
	text: string,
	classIndex: ClassIndex,
	eventIndex: EventIndex,
	diagnostics: Diagnostic[]
): void => {
	const lines = text.split(/\r?\n/);
	const callableIndex = buildCallableIndex(text);

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex];
		const commentIndex = line.indexOf("//");
		const scanLine = commentIndex >= 0 ? line.slice(0, commentIndex) : line;

		const match = scanLine.match(/^\s*emit\s+(.+)/);
		if (!match) {
			continue;
		}

		const expr = match[1].trim();

		// String literal or f-string → valid
		if (/^["']/.test(expr) || /^f["']/.test(expr)) {
			continue;
		}

		// Boolean or numeric literal → invalid
		if (expr === "true" || expr === "false" || /^\d+$/.test(expr)) {
			const litType = /^\d+$/.test(expr) ? "U64" : "Bool";
			const emitStart = scanLine.indexOf("emit");
			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				range: {
					start: { line: lineIndex, character: emitStart },
					end: { line: lineIndex, character: emitStart + 4 }
				},
				message: `can't emit on type '${litType}'`,
				source: 'ex'
			});
			continue;
		}

		// Event constructor: Name{...} → valid if event or class (compiler converts class to event)
		const ctorMatch = expr.match(/^([A-Za-z_]\w*)\s*\{/);
		if (ctorMatch) {
			if (eventIndex.events.has(ctorMatch[1]) || classIndex.classes.has(ctorMatch[1])) {
				continue;
			}
		}

		// Incomplete member access: expr ending with '.' → error
		if (/\.\s*$/.test(expr)) {
			const emitStart = scanLine.indexOf("emit");
			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				range: {
					start: { line: lineIndex, character: emitStart },
					end: { line: lineIndex, character: emitStart + 4 }
				},
				message: `incomplete expression: missing field name after '.'`,
				source: 'ex'
			});
			continue;
		}

		// Try to infer expression type (handles variables, member access, casts, etc.)
		const exprInfo = inferExpressionType(expr, lineIndex, text, callableIndex, classIndex);
		if (!exprInfo) {
			continue;
		}
		// Collections (arrays/maps) cannot be emitted
		if (exprInfo.isCollection) {
			const emitStart = scanLine.indexOf("emit");
			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				range: {
					start: { line: lineIndex, character: emitStart },
					end: { line: lineIndex, character: emitStart + 4 }
				},
				message: `can't emit on type '[]${exprInfo.typeName}'`,
				source: 'ex'
			});
			continue;
		}
		// String, Event, and Class types are allowed
		if (exprInfo.typeName === "String") {
			continue;
		}
		if (eventIndex.events.has(exprInfo.typeName)) {
			continue;
		}
		const emitStart = scanLine.indexOf("emit");
		diagnostics.push({
			severity: DiagnosticSeverity.Error,
			range: {
				start: { line: lineIndex, character: emitStart },
				end: { line: lineIndex, character: emitStart + 4 }
			},
			message: `can't emit on type '${exprInfo.typeName}'`,
			source: 'ex'
		});
	}
};

const checkArrayFunctionTypes = (
	text: string,
	diagnostics: Diagnostic[]
): void => {
	const lines = text.split(/\r?\n/);
	const callableIndex = buildCallableIndex(text);

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex];
		const commentIndex = line.indexOf("//");
		const scanLine = commentIndex >= 0 ? line.slice(0, commentIndex) : line;
		const stringRanges = getStringRanges(scanLine);

		// Match append(...), popend(...), merge(...)
		// Also handle: disperse append(...), sweep popend(...)
		const pattern = /\b(append|popend|merge)\s*\(/g;
		for (const match of scanLine.matchAll(pattern)) {
			const funcName = match[1];
			const funcStart = match.index!;

			if (isInsideRanges(funcStart, stringRanges)) {
				continue;
			}

			// Skip if preceded by dot (method call)
			if (isMemberAccess(scanLine, funcStart)) {
				continue;
			}

			const openParen = funcStart + match[0].length - 1;

			// Find matching close paren
			let depth = 1;
			let pos = openParen + 1;
			while (pos < scanLine.length && depth > 0) {
				if (scanLine[pos] === "(" || scanLine[pos] === "{" || scanLine[pos] === "[") { depth++; }
				if (scanLine[pos] === ")" || scanLine[pos] === "}" || scanLine[pos] === "]") { depth--; }
				pos++;
			}
			if (depth !== 0) {
				continue;
			}

			const argText = scanLine.slice(openParen + 1, pos - 1).trim();
			if (!argText) {
				continue;
			}

			// Extract first argument
			let firstArg = argText;
			let argDepth = 0;
			for (let i = 0; i < argText.length; i++) {
				const ch = argText[i];
				if (ch === "(" || ch === "{" || ch === "[") { argDepth++; }
				if (ch === ")" || ch === "}" || ch === "]") { argDepth--; }
				if (ch === "," && argDepth === 0) {
					firstArg = argText.slice(0, i).trim();
					break;
				}
			}

			// The first arg must be a simple variable for us to check
			if (!/^[A-Za-z_]\w*$/.test(firstArg)) {
				continue;
			}

			const arrayKind = resolveVariableArrayKind(text, firstArg, lineIndex, callableIndex);

			// append and merge require varray (variable-length array)
			if (funcName === "append" || funcName === "merge") {
				if (arrayKind === null) {
					// Could be from another module or unresolvable — skip
					continue;
				}
				if (arrayKind !== "varray") {
					diagnostics.push({
						severity: DiagnosticSeverity.Error,
						range: {
							start: { line: lineIndex, character: funcStart },
							end: { line: lineIndex, character: funcStart + funcName.length }
						},
						message: `'${funcName}' can only be used with variables of Varray type`,
						source: 'ex'
					});
				}
			}

			// popend requires any array type
			if (funcName === "popend") {
				if (arrayKind === null) {
					continue;
				}
				// arrayKind is "varray" or "array" — both valid, nothing to flag
			}
		}
	}
};

const TYPECAST_ALLOWED = new Map<string, Set<string>>([
	["Bool", new Set(["Bool", "String", "Bytes", "U64", "I64", "U256", "Identifier"])],
	["String", new Set(["String", "Bytes", "U64", "U256", "I64", "Identifier"])],
	["Identifier", new Set(["String", "Bytes", "U256", "Identifier", "Invocation"])],
	["U64", new Set(["U64", "Bool", "Bytes", "String", "I64", "U256"])],
	["I64", new Set(["I64", "Bool", "Bytes", "String", "U64", "U256"])],
	["U256", new Set(["U256", "Bool", "Bytes", "String", "U64", "I64"])],
	["Bytes", new Set(["Bytes", "String", "U64", "I64", "U256", "Identifier"])],
	["len", new Set(["String", "Bytes"])],
]);

const resolveVariableTypeInfo = (
	text: string,
	varName: string,
	lineIndex: number,
	callableIndex: CallableIndex
): { typeName: string; isCollection: boolean } | null => {
	const lines = text.split(/\r?\n/);
	const callableRange = getEnclosingCallableRange(lines, lineIndex, callableIndex.callableRanges);
	if (!callableRange) {
		return null;
	}

	let result: { typeName: string; isCollection: boolean } | null = null;

	// Check function parameter types
	const sigLine = lines[callableRange.startLine];
	const parenMatch = sigLine.match(/\(([^)]*)\)/);
	if (parenMatch) {
		for (const part of parenMatch[1].split(",")) {
			const trimmed = part.trim();
			const m = trimmed.match(/^([A-Za-z_]\w*)\s+(\[\]|Map\[)?/);
			if (m && m[1] === varName) {
				const isCollection = !!m[2];
				const typeMatch = trimmed.match(/^[A-Za-z_]\w*\s+(?:\[\]|Map\[.*?\])?([A-Za-z_]\w*)/);
				if (typeMatch) {
					result = { typeName: typeMatch[1], isCollection };
				}
			}
		}
	}

	// Check local declarations
	const typedDeclPattern = /^\s*(?:memory|storage)\s+([A-Za-z_]\w*)\s+(\[\]|Map\[)?/;
	const assignPattern = /^\s*(?:memory|storage|const)?\s*([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\s*[({]/;
	const groupedTypedPattern = /^\s*([A-Za-z_]\w*)\s+(?:\[\])?([A-Za-z_]\w*)\b/;
	let blockActive = false;
	let blockIndent = 0;

	for (let i = callableRange.startLine + 1; i <= lineIndex && i < lines.length; i++) {
		const line = lines[i];
		const lineIndent = line.match(/^\s*/)?.[0].length ?? 0;
		const isBlank = line.trim().length === 0;
		if (!isBlank && lineIndent <= callableRange.indent) {
			break;
		}

		if (blockActive && !isBlank && lineIndent <= blockIndent) {
			blockActive = false;
		}

		const headerMatch = line.match(/^\s*(memory|storage)\s*:\s*$/);
		if (headerMatch) {
			blockActive = true;
			blockIndent = lineIndent;
			continue;
		}

		const m = line.match(typedDeclPattern);
		if (m && m[1] === varName) {
			const isCollection = !!m[2];
			const typeMatch = line.match(/^\s*(?:memory|storage)\s+[A-Za-z_]\w*\s+(?:\[\]|Map\[.*?\])?([A-Za-z_]\w*)/);
			if (typeMatch) {
				result = { typeName: typeMatch[1], isCollection };
			}
		}
		const assignMatch = line.match(assignPattern);
		if (assignMatch && assignMatch[1] === varName) {
			result = { typeName: assignMatch[2], isCollection: false };
		}

		// Infer type from literal assignments: memory x = true, x = 10, x = "hi"
		const hasKeyword = /^\s*(?:memory|storage|const)\b/.test(line);
		const inBlock = blockActive && !isBlank && lineIndent > blockIndent;
		if (hasKeyword || inBlock) {
			const litMatch = line.match(/^\s*(?:memory|storage|const)?\s*([A-Za-z_]\w*)\s*=\s*(true|false|"[^"]*"|\d+)\s*(?:\/\/.*)?$/);
			if (litMatch && litMatch[1] === varName) {
				const lit = litMatch[2];
				if (lit === "true" || lit === "false") {
					result = { typeName: "Bool", isCollection: false };
				} else if (/^\d+$/.test(lit)) {
					result = { typeName: "U64", isCollection: false };
				} else if (lit.startsWith('"')) {
					result = { typeName: "String", isCollection: false };
				}
			}
		}

		// Grouped typed pattern inside memory/storage block: varName Type
		if (inBlock) {
			const groupedMatch = line.match(groupedTypedPattern);
			if (groupedMatch && groupedMatch[1] === varName) {
				const isCollection = /^\s*[A-Za-z_]\w*\s+(\[\]|Map\[)/.test(line);
				result = { typeName: groupedMatch[2], isCollection };
			}
		}
	}

	return result;
};

const inferExpressionType = (
	exprText: string,
	lineIndex: number,
	text: string,
	callableIndex: CallableIndex,
	classIndex: ClassIndex
): { typeName: string; isCollection: boolean } | null => {
	const trimmed = exprText.trim();

	if (trimmed === "true" || trimmed === "false") {
		return { typeName: "Bool", isCollection: false };
	}

	// Known typecast call → return type
	const castMatch = trimmed.match(/^(Bool|String|Identifier|U64|I64|U256|Bytes)\s*\(/);
	if (castMatch) {
		return { typeName: castMatch[1], isCollection: false };
	}

	// Class literal: ClassName{...}
	const classLitMatch = trimmed.match(/^([A-Za-z_]\w*)\s*\{/);
	if (classLitMatch && classIndex.classes.has(classLitMatch[1])) {
		return { typeName: classLitMatch[1], isCollection: false };
	}

	// Simple variable reference
	if (/^[A-Za-z_]\w*$/.test(trimmed)) {
		return resolveVariableTypeInfo(text, trimmed, lineIndex, callableIndex);
	}

	// Chained member access: identifier[idx].field1[idx].field2...
	const chainMatch = trimmed.match(/^([A-Za-z_]\w*)((?:\[[^\]]*\])*(?:\.(?:[A-Za-z_]\w*)(?:\[[^\]]*\])*)+)$/);
	if (chainMatch) {
		const varName = chainMatch[1];
		const accessChain = chainMatch[2];
		const varInfo = resolveVariableTypeInfo(text, varName, lineIndex, callableIndex);
		if (varInfo) {
			// Extract field names from chain: .Field1[0].Field2 → ["Field1", "Field2"]
			const fieldNames: { name: string; indexed: boolean }[] = [];
			const segmentPattern = /\.([A-Za-z_]\w*)(\[[^\]]*\])?/g;
			for (const seg of accessChain.matchAll(segmentPattern)) {
				fieldNames.push({ name: seg[1], indexed: !!seg[2] });
			}

			let currentType = varInfo.typeName;
			let currentIsCollection = varInfo.isCollection;
			for (const segment of fieldNames) {
				// If current type is a collection and we index into it, resolve to element type
				// If not indexed and it's a collection, the whole thing is still a collection
				const classEntry = classIndex.classes.get(currentType);
				if (!classEntry) {
					return null;
				}
				const fieldInfo = classEntry.fieldTypes.get(segment.name);
				if (!fieldInfo) {
					return null;
				}
				currentType = fieldInfo.typeName;
				currentIsCollection = fieldInfo.isCollection;
				// If the field is a collection and we index into it, it's no longer a collection
				if (currentIsCollection && segment.indexed) {
					currentIsCollection = false;
				}
			}
			return { typeName: currentType, isCollection: currentIsCollection };
		}
	}

	return null;
};

const checkStandardFunctionTypes = (
	text: string,
	classIndex: ClassIndex,
	diagnostics: Diagnostic[]
): void => {
	const lines = text.split(/\r?\n/);
	const callableIndex = buildCallableIndex(text);

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex];
		const commentIndex = line.indexOf("//");
		const scanLine = commentIndex >= 0 ? line.slice(0, commentIndex) : line;
		const stringRanges = getStringRanges(scanLine);

		const pattern = /\b(Bool|String|Identifier|U64|I64|U256|Bytes|len)\s*\(/g;
		for (const match of scanLine.matchAll(pattern)) {
			const funcName = match[1];
			const funcStart = match.index!;

			if (isInsideRanges(funcStart, stringRanges)) {
				continue;
			}

			// Skip if preceded by dot (method call like value.String())
			if (isMemberAccess(scanLine, funcStart)) {
				continue;
			}

			// Skip definition lines
			if (/^\s*(?:class|event|field|endpoint|function|method|interface|state)\b/.test(scanLine)) {
				continue;
			}

			const openParen = funcStart + match[0].length - 1;

			// Find matching close paren
			let depth = 1;
			let pos = openParen + 1;
			while (pos < scanLine.length && depth > 0) {
				if (scanLine[pos] === "(" || scanLine[pos] === "{" || scanLine[pos] === "[") { depth++; }
				if (scanLine[pos] === ")" || scanLine[pos] === "}" || scanLine[pos] === "]") { depth--; }
				pos++;
			}
			if (depth !== 0) {
				continue;
			}

			const argText = scanLine.slice(openParen + 1, pos - 1).trim();
			if (!argText) {
				continue;
			}

			// Extract first argument (split on comma at depth 0)
			let firstArg = argText;
			let argDepth = 0;
			for (let i = 0; i < argText.length; i++) {
				const ch = argText[i];
				if (ch === "(" || ch === "{" || ch === "[") { argDepth++; }
				if (ch === ")" || ch === "}" || ch === "]") { argDepth--; }
				if (ch === "," && argDepth === 0) {
					firstArg = argText.slice(0, i).trim();
					break;
				}
			}

			// Strip label if present: "label: value" → "value"
			const labelMatch = firstArg.match(/^[A-Za-z_]\w*\s*:\s*(.*)/);
			if (labelMatch) {
				firstArg = labelMatch[1].trim();
			}

			const argInfo = inferExpressionType(firstArg, lineIndex, text, callableIndex, classIndex);
			if (!argInfo) {
				continue;
			}

			const allowed = TYPECAST_ALLOWED.get(funcName);
			if (!allowed) {
				continue;
			}

			if (allowed.has(argInfo.typeName)) {
				continue;
			}

			// For len(), allow Class types and collection variables
			if (funcName === "len") {
				if (argInfo.isCollection) {
					continue;
				}
				if (classIndex.classes.has(argInfo.typeName)) {
					continue;
				}
				// If the type is not a known primitive, it could be a collection from another module
				const disallowedForLen = new Set(["Bool", "U64", "I64", "U256", "Identifier", "Invocation"]);
				if (!disallowedForLen.has(argInfo.typeName)) {
					continue;
				}
			}

			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				range: {
					start: { line: lineIndex, character: funcStart },
					end: { line: lineIndex, character: funcStart + funcName.length }
				},
				message: `'${funcName}' is not implemented for type '${argInfo.typeName}'`,
				source: 'ex'
			});
		}
	}
};

const checkFieldAccess = (
	text: string,
	classIndex: ClassIndex,
	diagnostics: Diagnostic[]
): void => {
	const lines = text.split(/\r?\n/);
	const callableIndex = buildCallableIndex(text);

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex];
		const commentIndex = line.indexOf("//");
		const scanLine = commentIndex >= 0 ? line.slice(0, commentIndex) : line;
		const stringRanges = getStringRanges(scanLine);

		for (const match of scanLine.matchAll(/\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
			const fieldName = match[1];
			const dotPos = match.index!;
			const fieldStart = dotPos + 1;

			if (isInsideRanges(fieldStart, stringRanges)) {
				continue;
			}

			// Determine the receiver by looking before the dot
			let beforeDot = dotPos - 1;
			while (beforeDot >= 0 && /\s/.test(scanLine[beforeDot])) { beforeDot--; }
			if (beforeDot < 0) {
				continue;
			}

			let receiverName: string | null = null;

			if (scanLine[beforeDot] === "]") {
				// Indexed access: identifier[...].field
				let depth = 1;
				let pos = beforeDot - 1;
				while (pos >= 0 && depth > 0) {
					if (scanLine[pos] === "]") { depth++; }
					if (scanLine[pos] === "[") { depth--; }
					pos--;
				}
				let identEnd = pos + 1;
				while (identEnd > 0 && /\s/.test(scanLine[identEnd - 1])) { identEnd--; }
				let identStart = identEnd;
				while (identStart > 0 && /[A-Za-z0-9_]/.test(scanLine[identStart - 1])) { identStart--; }
				if (identStart < identEnd && /[A-Za-z_]/.test(scanLine[identStart])) {
					receiverName = scanLine.slice(identStart, identEnd);
				}
			} else if (/[A-Za-z0-9_]/.test(scanLine[beforeDot])) {
				// Direct access: identifier.field
				let identEnd = beforeDot + 1;
				let identStart = beforeDot;
				while (identStart > 0 && /[A-Za-z0-9_]/.test(scanLine[identStart - 1])) { identStart--; }
				if (/[A-Za-z_]/.test(scanLine[identStart])) {
					receiverName = scanLine.slice(identStart, identEnd);
				}
			}

			if (!receiverName) {
				continue;
			}

			// Skip keywords, type names, and known class names (type-level access)
			if (isKeyword(receiverName) || classIndex.classes.has(receiverName)) {
				continue;
			}

			let receiverType = findTypeForReceiver(text, receiverName, lineIndex, callableIndex);
			if (!receiverType) {
				receiverType = findAssignedTypeGlobal(text, receiverName, lineIndex);
			}
			if (!receiverType) {
				continue;
			}

			const classInfo = classIndex.classes.get(receiverType);
			if (!classInfo) {
				continue;
			}

			if (!classInfo.fields.has(fieldName) && !classInfo.methods.has(fieldName)) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					range: {
						start: { line: lineIndex, character: fieldStart },
						end: { line: lineIndex, character: fieldStart + fieldName.length }
					},
					message: `'${fieldName}' is not a member of ${receiverType}`,
					source: 'ex'
				});
			}
		}
	}
};

const checkFStringChunks = (
	text: string,
	classIndex: ClassIndex,
	diagnostics: Diagnostic[]
): void => {
	const lines = text.split(/\r?\n/);
	const callableIndex = buildCallableIndex(text);

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex];
		const commentIndex = line.indexOf("//");
		const scanLine = commentIndex >= 0 ? line.slice(0, commentIndex) : line;
		const chunks = extractFStringChunks(scanLine);

		for (const chunk of chunks) {
			const chunkText = scanLine.slice(chunk.start, chunk.end);

			for (const match of chunkText.matchAll(/\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
				const fieldName = match[1];
				const dotPos = match.index!;
				const fieldStart = chunk.start + dotPos + 1;

				let beforeDot = dotPos - 1;
				while (beforeDot >= 0 && /\s/.test(chunkText[beforeDot])) { beforeDot--; }
				if (beforeDot < 0) { continue; }

				let receiverName: string | null = null;

				if (chunkText[beforeDot] === "]") {
					let depth = 1;
					let pos = beforeDot - 1;
					while (pos >= 0 && depth > 0) {
						if (chunkText[pos] === "]") { depth++; }
						if (chunkText[pos] === "[") { depth--; }
						pos--;
					}
					let identEnd = pos + 1;
					while (identEnd > 0 && /\s/.test(chunkText[identEnd - 1])) { identEnd--; }
					let identStart = identEnd;
					while (identStart > 0 && /[A-Za-z0-9_]/.test(chunkText[identStart - 1])) { identStart--; }
					if (identStart < identEnd && /[A-Za-z_]/.test(chunkText[identStart])) {
						receiverName = chunkText.slice(identStart, identEnd);
					}
				} else if (/[A-Za-z0-9_]/.test(chunkText[beforeDot])) {
					let identEnd = beforeDot + 1;
					let identStart = beforeDot;
					while (identStart > 0 && /[A-Za-z0-9_]/.test(chunkText[identStart - 1])) { identStart--; }
					if (/[A-Za-z_]/.test(chunkText[identStart])) {
						receiverName = chunkText.slice(identStart, identEnd);
					}
				}

				if (!receiverName) { continue; }
				if (isKeyword(receiverName) || classIndex.classes.has(receiverName)) { continue; }

				let receiverType = findTypeForReceiver(text, receiverName, lineIndex, callableIndex);
				if (!receiverType) {
					receiverType = findAssignedTypeGlobal(text, receiverName, lineIndex);
				}
				if (!receiverType) { continue; }

				const classInfo = classIndex.classes.get(receiverType);
				if (!classInfo) { continue; }

				if (!classInfo.fields.has(fieldName) && !classInfo.methods.has(fieldName)) {
					diagnostics.push({
						severity: DiagnosticSeverity.Error,
						range: {
							start: { line: lineIndex, character: fieldStart },
							end: { line: lineIndex, character: fieldStart + fieldName.length }
						},
						message: `'${fieldName}' is not a member of ${receiverType}`,
						source: 'ex'
					});
				}
			}
		}
	}
};

const isCocoAssetFile = (text: string): boolean => {
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("//")) continue;
		return /^coco\s+asset\s+/.test(trimmed);
	}
	return false;
};

const checkAssetMethodCalls = (text: string, diagnostics: Diagnostic[]): void => {
	if (!isCocoAssetFile(text)) {
		return;
	}

	const lines = text.split(/\r?\n/);
	const lineOffsets: number[] = [];
	let offset = 0;
	for (const line of lines) {
		lineOffsets.push(offset);
		offset += line.length + 1; // +1 for \n (we split on \n after normalizing)
	}
	// Normalize line endings for offset calculations
	const normalizedText = lines.join("\n");

	const getLineAndCharacter = (pos: number): { line: number; character: number } => {
		let lo = 0;
		let hi = lineOffsets.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (lineOffsets[mid] <= pos) {
				lo = mid;
			} else {
				hi = mid - 1;
			}
		}
		return { line: lo, character: pos - lineOffsets[lo] };
	};

	const pattern = /\basset\.([A-Za-z_]\w*)\s*\(/g;
	let match: RegExpExecArray | null;

	while ((match = pattern.exec(normalizedText)) !== null) {
		const fullMatchStart = match.index;
		const methodName = match[1];
		const methodNameStart = fullMatchStart + "asset.".length;
		const openParenPos = match.index + match[0].length - 1;

		// Check if inside a comment
		const matchPos = getLineAndCharacter(fullMatchStart);
		const matchLine = lines[matchPos.line];
		const commentIdx = matchLine.indexOf("//");
		if (commentIdx >= 0 && matchPos.character >= commentIdx) {
			continue;
		}

		// Check if inside a string literal (simple heuristic: count unescaped quotes before position on the line)
		const linePrefix = matchLine.slice(0, matchPos.character);
		const doubleQuotes = (linePrefix.match(/(?<!\\)"/g) || []).length;
		if (doubleQuotes % 2 !== 0) {
			continue;
		}

		const methodInfo = ASSET_METHODS.get(methodName);
		if (!methodInfo) {
			const loc = getLineAndCharacter(methodNameStart);
			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				range: {
					start: { line: loc.line, character: loc.character },
					end: { line: loc.line, character: loc.character + methodName.length }
				},
				message: `'${methodName}' is not a known asset method`,
				source: 'ex'
			});
			continue;
		}

		// Find the matching close paren
		let depth = 1;
		let pos = openParenPos + 1;
		let closeParenPos = -1;
		while (pos < normalizedText.length && depth > 0) {
			const ch = normalizedText[pos];
			if (ch === "(" || ch === "{" || ch === "[") {
				depth++;
			} else if (ch === ")" || ch === "}" || ch === "]") {
				depth--;
				if (depth === 0) {
					closeParenPos = pos;
				}
			}
			pos++;
		}

		if (closeParenPos < 0) {
			continue; // Unmatched paren, skip
		}

		const argsText = normalizedText.slice(openParenPos + 1, closeParenPos).trim();

		// Split arguments respecting nesting depth
		const argStrings: string[] = [];
		if (argsText.length > 0) {
			let argDepth = 0;
			let argStart = 0;
			for (let i = 0; i < argsText.length; i++) {
				const ch = argsText[i];
				if (ch === "(" || ch === "{" || ch === "[") {
					argDepth++;
				} else if (ch === ")" || ch === "}" || ch === "]") {
					argDepth--;
				} else if (ch === "," && argDepth === 0) {
					argStrings.push(argsText.slice(argStart, i).trim());
					argStart = i + 1;
				}
			}
			const lastArg = argsText.slice(argStart).trim();
			if (lastArg.length > 0) {
				argStrings.push(lastArg);
			}
		}

		const expectedCount = methodInfo.args.length;
		const actualCount = argStrings.length;

		if (actualCount !== expectedCount) {
			const loc = getLineAndCharacter(methodNameStart);
			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				range: {
					start: { line: loc.line, character: loc.character },
					end: { line: loc.line, character: loc.character + methodName.length }
				},
				message: `asset method '${methodName}' expects ${expectedCount} argument${expectedCount !== 1 ? "s" : ""}, got ${actualCount}`,
				source: 'ex'
			});
			continue;
		}

		// Check labeled arguments
		for (const argStr of argStrings) {
			const labelMatch = argStr.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:/);
			if (labelMatch) {
				const label = labelMatch[1];
				if (!methodInfo.args.includes(label)) {
					// Find position of the label in the original text
					const argOffset = normalizedText.indexOf(argStr, openParenPos + 1);
					if (argOffset >= 0) {
						const labelLoc = getLineAndCharacter(argOffset);
						diagnostics.push({
							severity: DiagnosticSeverity.Warning,
							range: {
								start: { line: labelLoc.line, character: labelLoc.character },
								end: { line: labelLoc.line, character: labelLoc.character + label.length }
							},
							message: `unknown argument '${label}' for asset method '${methodName}'. Expected: ${methodInfo.args.join(", ")}`,
							source: 'ex'
						});
					}
				}
			}
		}
	}
};

const buildSemanticTokens = (
	document: TextDocument,
	analysisIndexes: {
		classIndex: ClassIndex;
		eventIndex: EventIndex;
		interfaceIndex: InterfaceIndex;
		interfaceStateIndex: InterfaceStateIndex;
		stateIndex: StateIndex;
	}
): SemanticTokens => {
	const text = document.getText();
	const lines = text.split(/\r?\n/);
	const callableIndex = buildCallableIndex(text);
	const classIndex = analysisIndexes.classIndex;
	const eventIndex = analysisIndexes.eventIndex;
	const interfaceIndex = analysisIndexes.interfaceIndex;
	const scopes = buildCallableScopes(lines, callableIndex);
	const lineScopes = new Array<{ parameters: Set<string>; variables: Set<string> } | null>(lines.length).fill(null);
	for (const scope of scopes) {
		for (let lineIndex = scope.startLine; lineIndex <= scope.endLine; lineIndex++) {
			lineScopes[lineIndex] = { parameters: scope.parameters, variables: scope.variables };
		}
	}

	const globalVariables = new Set<string>();
	for (const variable of collectVariableDeclarationsInRange(lines, 0, lines.length - 1)) {
		if (!lineScopes[variable.line]) {
			globalVariables.add(variable.name);
		}
	}

	const builder = new SemanticTokensBuilder();
	const wordPattern = /\b[A-Za-z_][A-Za-z0-9_]*\b/g;
	const typeNames = new Set<string>([
		...classIndex.classes.keys(),
		...eventIndex.events.keys(),
		...interfaceIndex.interfaces.keys(),
		...builtinTypeNames
	]);

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex];
		const commentIndex = line.indexOf("//");
		const scanLine = commentIndex >= 0 ? line.slice(0, commentIndex) : line;
		const scope = lineScopes[lineIndex];
		const parameters = scope?.parameters ?? new Set<string>();
		const variables = scope?.variables ?? globalVariables;
		const functionCalls = new Map<number, number>();
		const typeLiterals = new Map<number, number>();

		for (const call of findCallCalleePositions(scanLine)) {
			functionCalls.set(call.start, call.length);
		}

		for (const literal of findTypeLiteralCandidates(scanLine)) {
			if (typeNames.has(literal.typeName)) {
				typeLiterals.set(literal.typeStart, literal.typeName.length);
			}
		}

		for (const match of scanLine.matchAll(wordPattern)) {
			const name = match[0];
			const startChar = match.index ?? -1;
			if (startChar < 0) {
				continue;
			}

			if (functionCalls.has(startChar)) {
				builder.push(lineIndex, startChar, functionCalls.get(startChar) ?? name.length, semanticTokenTypes.indexOf("function"), 0);
			} else if (typeLiterals.has(startChar)) {
				builder.push(lineIndex, startChar, typeLiterals.get(startChar) ?? name.length, semanticTokenTypes.indexOf("type"), 0);
			} else if (typeNames.has(name) && !parameters.has(name) && !variables.has(name)) {
				builder.push(lineIndex, startChar, name.length, semanticTokenTypes.indexOf("type"), 0);
			} else if (parameters.has(name)) {
				builder.push(lineIndex, startChar, name.length, semanticTokenTypes.indexOf("parameter"), 0);
			} else if (variables.has(name)) {
				builder.push(lineIndex, startChar, name.length, semanticTokenTypes.indexOf("variable"), 0);
			} else if (isMemberAccess(scanLine, startChar)) {
				builder.push(lineIndex, startChar, name.length, semanticTokenTypes.indexOf("property"), 0);
			}
		}
	}

	return builder.build();
};

const findCallCalleePositions = (line: string): Array<{ start: number; length: number }> => {
	const results: Array<{ start: number; length: number }> = [];
	let i = 0;

	while (i < line.length) {
		if (!isWordChar(line[i]) || (i > 0 && isWordChar(line[i - 1]))) {
			i += 1;
			continue;
		}

		const start = i;
		let end = i + 1;
		while (end < line.length && isWordChar(line[end])) {
			end += 1;
		}

		let next = end;
		while (next < line.length && /\s/.test(line[next])) {
			next += 1;
		}

		if (next < line.length && line[next] === "(") {
			results.push({ start, length: end - start });
		}

		i = end;
	}

	return results;
};

const buildCallableScopes = (
	lines: string[],
	callableIndex: CallableIndex
): Array<{ name: string; startLine: number; endLine: number; indent: number; parameters: Set<string>; variables: Set<string> }> => {
	const scopes: Array<{ name: string; startLine: number; endLine: number; indent: number; parameters: Set<string>; variables: Set<string> }> = [];

	for (const range of callableIndex.callableRanges) {
		const callable = callableIndex.callables.get(range.name);
		if (!callable) {
			continue;
		}

		const parameters = new Set<string>();
		for (const name of callable.params.keys()) {
			parameters.add(name);
		}
		for (const name of callable.returns.keys()) {
			parameters.add(name);
		}

		const endLine = getCallableEndLine(lines, range);
		const variables = new Set<string>();
		for (const variable of collectVariableDeclarationsInRange(lines, range.line + 1, endLine)) {
			variables.add(variable.name);
		}

		scopes.push({
			name: range.name,
			startLine: range.line,
			endLine,
			indent: range.indent,
			parameters,
			variables
		});
	}

	return scopes;
};

const getCallableEndLine = (
	lines: string[],
	range: { line: number; indent: number }
): number => {
	let endLine = lines.length - 1;
	for (let lineIndex = range.line + 1; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex];
		const lineIndent = line.match(/^\s*/)?.[0].length ?? 0;
		const isBlank = line.trim().length === 0;
		if (!isBlank && lineIndent <= range.indent) {
			endLine = lineIndex - 1;
			break;
		}
	}
	return endLine;
};
