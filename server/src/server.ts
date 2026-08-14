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

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;

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
type CocoSettings = Record<string, never>;

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
	const moduleContext = await buildModuleContext(textDocument.uri, text);
	const analysisIndexes = buildModuleAnalysisIndexes(moduleContext);
	const classIndex = analysisIndexes.classIndex;
	const eventIndex = analysisIndexes.eventIndex;
	const interfaceIndex = analysisIndexes.interfaceIndex;
	const interfaceStateIndex = analysisIndexes.interfaceStateIndex;
	const stateIndex = analysisIndexes.stateIndex;

	checkTypeLiteralProperties(text, classIndex, eventIndex, diagnostics);
	checkUndefinedVariables(text, classIndex, eventIndex, interfaceIndex, stateIndex, diagnostics);
	checkStateFieldReferences(text, stateIndex, interfaceStateIndex, classIndex, diagnostics);
	checkPayerClauses(text, moduleContext.pisaVersion, diagnostics);
	checkWholeStateWrites(text, stateIndex, classIndex, diagnostics);
	checkFieldAccess(text, classIndex, diagnostics);
	checkFStringChunks(text, classIndex, diagnostics);
	checkStandardFunctionTypes(text, classIndex, diagnostics);
	checkEmitTypes(text, classIndex, eventIndex, diagnostics);
	checkArrayFunctionTypes(text, diagnostics);
	checkAssetMethodCalls(text, diagnostics);
	checkSuperglobalMethodCalls(text, moduleContext.pisaVersion, classIndex, diagnostics);
	checkStateQualifiers(text, moduleContext.pisaVersion, interfaceStateIndex, diagnostics);
	checkReservedWordNames(text, diagnostics);
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

// This handler provides the initial list of the completion items. When the
// cursor sits just after a superglobal or the asset engine, the members of that
// receiver are offered instead of the plain keyword list.
connection.onCompletion(
	async (textDocumentPosition: TextDocumentPositionParams): Promise<CompletionItem[]> => {
		const document = documents.get(textDocumentPosition.textDocument.uri);
		if (document) {
			const linePrefix = document.getText({
				start: { line: textDocumentPosition.position.line, character: 0 },
				end: textDocumentPosition.position
			});
			const moduleContext = await buildModuleContext(textDocumentPosition.textDocument.uri, document.getText());
			const memberCompletions = buildMemberCompletions(linePrefix, moduleContext.pisaVersion);
			if (memberCompletions) {
				return memberCompletions;
			}
		}
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
	// Declared type text per field, e.g. "Map[String]U64" — used to tell atomic
	// storage (maps, arrays, classes) from scalars.
	logicFieldTypes: Map<string, string>;
	actorFieldTypes: Map<string, string>;
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
	pisaVersion: PisaVersion;
};

// PisaVersion is the [target.pisa] version a module compiles against. Features
// like `payer`, Environment.StorageResult and the actor methods only exist on
// 0.8.0, while Environment.VolumeCapacity/VolumeAvailable only exist below it.
type PisaVersion = "0.3.2" | "0.4.0" | "0.5.0" | "0.7.1" | "0.8.0";

// DEFAULT_PISA_VERSION matches what `coco nut init` writes, and is what we
// assume when no coco.nut sits next to the source file.
const DEFAULT_PISA_VERSION: PisaVersion = "0.8.0";

// PISA_VERSION_ALIASES maps every accepted coco.nut version string onto the
// target it actually compiles to: 0.6.0 through 0.7.1 are one and the same.
const PISA_VERSION_ALIASES = new Map<string, PisaVersion>([
	["0.3.2", "0.3.2"],
	["0.4.0", "0.4.0"],
	["0.5.0", "0.5.0"],
	["0.6.0", "0.7.1"],
	["0.6.1", "0.7.1"],
	["0.7.0", "0.7.1"],
	["0.7.1", "0.7.1"],
	["0.8.0", "0.8.0"]
]);

const PISA_VERSION_ORDER: PisaVersion[] = ["0.3.2", "0.4.0", "0.5.0", "0.7.1", "0.8.0"];

const isPisaAtLeast = (version: PisaVersion, minimum: PisaVersion): boolean =>
	PISA_VERSION_ORDER.indexOf(version) >= PISA_VERSION_ORDER.indexOf(minimum);

const isPisaAfter = (version: PisaVersion, bound: PisaVersion): boolean =>
	PISA_VERSION_ORDER.indexOf(version) > PISA_VERSION_ORDER.indexOf(bound);

// parsePisaVersion pulls `version` out of the [target.pisa] table of a coco.nut
// file. Hand-rolled rather than pulled from a TOML package: the server has no
// runtime dependencies and this is the only TOML it ever reads.
const parsePisaVersion = (nutText: string): PisaVersion | null => {
	const lines = nutText.split(/\r?\n/);
	let inTargetPisa = false;
	for (const line of lines) {
		const trimmed = line.replace(/#.*$/, "").trim();
		const section = trimmed.match(/^\[([^\]]+)\]$/);
		if (section) {
			inTargetPisa = section[1].trim() === "target.pisa";
			continue;
		}
		if (!inTargetPisa) {
			continue;
		}
		const value = trimmed.match(/^version\s*=\s*["']([^"']+)["']/);
		if (value) {
			return PISA_VERSION_ALIASES.get(value[1]) ?? null;
		}
	}
	return null;
};

type ModuleSymbols = {
	classIndex: LocatedClassIndex;
	eventIndex: LocatedEventIndex;
	interfaceIndex: LocatedInterfaceIndex;
	callables: LocatedCallableIndex;
};

type Segment = { text: string; start: number; end: number };
type StateRefParts = {
	rootName: string;
	actorRef: string;
	fieldName: string;
	rootStart: number;
	actorStart: number;
	fieldStart: number;
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
	const logicFieldTypes = new Map<string, string>();
	const actorFieldTypes = new Map<string, string>();

	for (const line of lines) {
		const cocoMatch = line.match(/^\s*coco\s+(?:asset\s+)?([A-Za-z_][A-Za-z0-9_]*)/);
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

		const stateMatch = line.match(/^\s*state\s+(logic|actor)\s*:\s*$/);
		if (stateMatch) {
			inState = true;
			stateIndent = lineIndent;
			const qual = stateMatch[1];
			stateQualifier = qual === "actor" ? "actor" : "logic";
			continue;
		}

		if (inState && !isBlank && lineIndent <= stateIndent) {
			inState = false;
			stateQualifier = null;
		}

		if (!inState || !stateQualifier) {
			continue;
		}

		const fieldMatch = stripCommentsAndStrings(line).match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(.*)$/);
		if (fieldMatch) {
			const fieldName = fieldMatch[1];
			const fieldType = fieldMatch[2].trim();
			if (stateQualifier === "logic") {
				logicFields.add(fieldName);
				logicFieldTypes.set(fieldName, fieldType);
			} else {
				actorFields.add(fieldName);
				actorFieldTypes.set(fieldName, fieldType);
			}
		}
	}

	return { moduleName, logicFields, actorFields, logicFieldTypes, actorFieldTypes };
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

		const stateMatch = line.match(/^\s*state\s+(logic|actor)\s*:\s*$/);
		if (stateMatch) {
			inState = true;
			stateIndent = lineIndent;
			const qual = stateMatch[1];
			stateQualifier = qual === "actor" ? "actor" : "logic";
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
		return { moduleName: null, files: [{ uri, text }], pisaVersion: DEFAULT_PISA_VERSION };
	}

	const dir = path.dirname(fileURLToPath(uri));
	let entries: string[] = [];
	try {
		entries = await fs.readdir(dir);
	} catch {
		return { moduleName, files: [{ uri, text }], pisaVersion: DEFAULT_PISA_VERSION };
	}

	const files: Array<{ uri: string; text: string }> = [];
	let pisaVersion: PisaVersion | null = null;
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

		if (entry.toLowerCase() === "coco.nut") {
			pisaVersion = parsePisaVersion(fileText);
			continue;
		}

		const fileModule = getCocoModuleName(fileText);
		if (fileModule === moduleName) {
			files.push({ uri: fileUri, text: fileText });
		}
	}

	if (!files.some(file => file.uri === uri)) {
		files.push({ uri, text });
	}

	return { moduleName, files, pisaVersion: pisaVersion ?? DEFAULT_PISA_VERSION };
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
	const logicFieldTypes = new Map<string, string>();
	const actorFieldTypes = new Map<string, string>();
	for (const index of indexes) {
		for (const field of index.logicFields) {
			logicFields.add(field);
		}
		for (const field of index.actorFields) {
			actorFields.add(field);
		}
		for (const [field, type] of index.logicFieldTypes) {
			if (!logicFieldTypes.has(field)) {
				logicFieldTypes.set(field, type);
			}
		}
		for (const [field, type] of index.actorFieldTypes) {
			if (!actorFieldTypes.has(field)) {
				actorFieldTypes.set(field, type);
			}
		}
	}
	return { moduleName, logicFields, actorFields, logicFieldTypes, actorFieldTypes };
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
		const match = trimmed.match(/^coco\s+(?:asset\s+)?([A-Za-z_][A-Za-z0-9_]*)\b/);
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
		/^\s*endpoint\s+(?:(?:invoke|enlist|deploy)\s+)?(?:(?:pure|static|dynamic|asset)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*(?:->\s*\(([^)]*)\))?/,
		/^\s*function\s+(?:(?:pure|static|dynamic|asset)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*(?:->\s*\(([^)]*)\))?/,
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

// splitTopLevelLiteralSegments cuts a literal body at the commas that sit
// outside every bracket and string, so `a: 1, b: Map[String]U64{"x": 2}` yields
// two segments rather than four.
const splitTopLevelLiteralSegments = (bodyText: string): Array<{ text: string; start: number }> => {
	const segments: Array<{ text: string; start: number }> = [];
	let depth = 0;
	let segmentStart = 0;
	let quote: string | null = null;

	for (let i = 0; i < bodyText.length; i++) {
		const ch = bodyText[i];
		if (quote) {
			if (ch === "\\") { i++; continue; }
			if (ch === quote) { quote = null; }
			continue;
		}
		if (ch === '"' || ch === "'") { quote = ch; continue; }
		if (ch === "{" || ch === "(" || ch === "[") { depth++; continue; }
		if (ch === "}" || ch === ")" || ch === "]") { depth--; continue; }
		if (ch === "," && depth === 0) {
			segments.push({ text: bodyText.slice(segmentStart, i), start: segmentStart });
			segmentStart = i + 1;
		}
	}
	segments.push({ text: bodyText.slice(segmentStart), start: segmentStart });
	return segments;
};

// parseLiteralEntries classifies each top-level entry of a class or event
// literal. `labeled` is the classic `field: value` form; `shorthand` is the
// field-name elision the compiler gained in 0.9.0, where a bare variable name
// stands for `field: field`. Anything else (nested brace-elided literals, map
// keys, expressions) is deliberately left unclassified.
const parseLiteralEntries = (
	bodyText: string,
	bodyStart: number
): Array<{ kind: "labeled" | "shorthand"; name: string; start: number }> => {
	const results: Array<{ kind: "labeled" | "shorthand"; name: string; start: number }> = [];

	for (const segment of splitTopLevelLiteralSegments(bodyText)) {
		const labeled = segment.text.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/);
		if (labeled) {
			results.push({
				kind: "labeled",
				name: labeled[2],
				start: bodyStart + segment.start + labeled[1].length
			});
			continue;
		}

		const shorthand = segment.text.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*$/);
		if (shorthand) {
			results.push({
				kind: "shorthand",
				name: shorthand[2],
				start: bodyStart + segment.start + shorthand[1].length
			});
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
			const stringRanges = getStringRanges(scanLine);
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
	payerRef: string | null;
	payerRange: { start: number; end: number } | null;
} => {
	const verbMatch = line.match(/^\s*(mutate|observe)\b/);
	if (!verbMatch) {
		return emptyMutateObserveInfo();
	}

	const verb = verbMatch[1] === "mutate" ? "mutate" : "observe";
	const verbStart = line.indexOf(verbMatch[1], verbMatch.index ?? 0);
	const verbEnd = verbStart + verbMatch[1].length;
	const arrows = findMutateObserveArrows(line, verbEnd);
	if (arrows.length === 0) {
		return emptyMutateObserveInfo();
	}
	const targetArrow = arrows[0];
	const stateArrow = arrows[arrows.length - 1];

	const targetsSegment = trimSegment(line, verbEnd, targetArrow.index);
	let stateAndPayer = trimSegment(line, stateArrow.index + stateArrow.token.length, line.length);
	if (stateAndPayer.text.endsWith(":")) {
		stateAndPayer = trimSegment(line, stateAndPayer.start, stateAndPayer.end - 1);
	}

	let stateSegment = stateAndPayer;
	let payerSegment: Segment | null = null;
	const payerIndex = findTopLevelPayerIndex(stateAndPayer.text);
	if (payerIndex >= 0) {
		stateSegment = trimSegment(line, stateAndPayer.start, stateAndPayer.start + payerIndex);
		payerSegment = trimSegment(line, stateAndPayer.start + payerIndex + "payer".length, stateAndPayer.end);
	}

	const targets: Array<{ name: string; start: number; end: number }> = [];
	for (const identifier of getIdentifierCandidates(targetsSegment.text)) {
		if (isMemberAccess(targetsSegment.text, identifier.start)) {
			continue;
		}
		const start = targetsSegment.start + identifier.start;
		targets.push({ name: identifier.name, start, end: start + identifier.name.length });
	}

	const stateRef = stateSegment.text.length > 0 ? stateSegment.text : null;
	const stateRange = stateRef ? { start: stateSegment.start, end: stateSegment.end } : null;
	const payerRef = payerSegment && payerSegment.text.length > 0 ? payerSegment.text : null;
	const payerRange = payerRef && payerSegment ? { start: payerSegment.start, end: payerSegment.end } : null;

	return { verb, targets, stateRef, stateRange, payerRef, payerRange };
};

const emptyMutateObserveInfo = (): {
	verb: null;
	targets: Array<{ name: string; start: number; end: number }>;
	stateRef: null;
	stateRange: null;
	payerRef: null;
	payerRange: null;
} => ({ verb: null, targets: [], stateRef: null, stateRange: null, payerRef: null, payerRange: null });

const trimSegment = (line: string, start: number, end: number): Segment => {
	let segmentStart = Math.max(0, start);
	let segmentEnd = Math.max(segmentStart, end);
	while (segmentStart < segmentEnd && /\s/.test(line[segmentStart])) {
		segmentStart++;
	}
	while (segmentEnd > segmentStart && /\s/.test(line[segmentEnd - 1])) {
		segmentEnd--;
	}
	return { text: line.slice(segmentStart, segmentEnd), start: segmentStart, end: segmentEnd };
};

const findMutateObserveArrows = (line: string, start: number): Array<{ index: number; token: "<-" | "->" }> => {
	const results: Array<{ index: number; token: "<-" | "->" }> = [];
	let depth = 0;
	for (let i = start; i < line.length - 1; i++) {
		const ch = line[i];
		if (ch === "(" || ch === "[" || ch === "{") { depth++; }
		if (ch === ")" || ch === "]" || ch === "}") { depth--; }
		if (depth === 0) {
			const token = line.slice(i, i + 2);
			if (token === "<-" || token === "->") {
				results.push({ index: i, token });
				i++;
			}
		}
	}
	return results;
};

const findTopLevelPayerIndex = (text: string): number => {
	let depth = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === "(" || ch === "[" || ch === "{") { depth++; continue; }
		if (ch === ")" || ch === "]" || ch === "}") { depth--; continue; }
		if (depth !== 0 || !text.startsWith("payer", i)) {
			continue;
		}
		const before = i > 0 ? text[i - 1] : "";
		const after = i + "payer".length < text.length ? text[i + "payer".length] : "";
		if (/\s/.test(before) && /\s/.test(after)) {
			return i;
		}
	}
	return -1;
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
	"payer",
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
	"append",
	"popend",
	"merge",
	"emit",
	"true",
	"false",
	"self",
	"Sender",
	"Logic",
	"Actor",
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
	"default",
	"build",
	"finally",
	"imports",
	"interact",
	"local",
	"make",
	"package",
	"pub",
	"throw",
	"pass",
	"self"
]);

// RESERVED_WORDS is the exact list the compiler refuses as a name. Kept separate
// from cocoKeywords, which is a looser "don't treat this as a receiver" set.
const RESERVED_WORDS = new Set<string>([
	"actor", "append", "asset", "break", "build", "case", "catch",
	"class", "coco", "const", "continue", "default", "depolorize", "deploy",
	"disperse", "dynamic", "else", "emit", "endpoint", "enlist", "ephemeral",
	"event", "false", "field", "finally", "for", "function", "gather",
	"generate", "if", "imports", "in", "interact", "interface", "invoke",
	"local", "logic", "make", "memory", "method", "mutate", "observe",
	"package", "pass", "payer", "persistent", "pub", "pure", "readonly",
	"return", "revert", "self", "state", "static", "storage", "sweep",
	"switch", "throw", "topic", "true", "try", "yield",
	"Actor", "Builtins", "Environment", "Invocation", "Logic", "Map", "Sender"
]);

// RESERVED_WORD_ALTERNATIVES suggests a way out for the reserved words that read
// most like ordinary names.
const RESERVED_WORD_ALTERNATIVES = new Map<string, string>([
	["actor", "owner, participant, account"],
	["payer", "payer_id, sponsor"],
	["local", "tmp, scratch"],
	["default", "fallback"],
	["field", "field_name"],
	["topic", "topic_name"],
	["method", "method_name"],
	["state", "state_value"],
	["logic", "logic_id"],
	["asset", "asset_id"]
]);

// StateQualifier is what an endpoint or function declares about the state it
// touches. Since compiler 0.9.0 the compiler infers the requirement from the
// body and rejects any mismatch in either direction, so an omitted qualifier
// means `pure` — not `static`.
type StateQualifier = "pure" | "static" | "dynamic";

const QUALIFIER_RANK: Record<StateQualifier, number> = { pure: 0, static: 1, dynamic: 2 };

const strongerQualifier = (left: StateQualifier, right: StateQualifier): StateQualifier =>
	QUALIFIER_RANK[left] >= QUALIFIER_RANK[right] ? left : right;

// ASSET_METHODS carries each asset engine method's argument names and the state
// qualifier its caller has to declare: every asset write is `dynamic`, every
// asset read is `static`. Mirrors ASSET_METHODS in the compiler's
// pisa/codegen/src/compiler/assets.rs — note there is no `Define`, an asset is
// created through Cocolab's `create` command rather than from Coco source.
const ASSET_METHODS = new Map<string, { args: string[]; returns: string[]; qualifier: StateQualifier }>([
	["Transfer", { args: ["token_id", "beneficiary", "amount"], returns: [], qualifier: "dynamic" }],
	["TransferFrom", { args: ["token_id", "benefactor", "beneficiary", "amount"], returns: [], qualifier: "dynamic" }],
	["Mint", { args: ["token_id", "beneficiary", "amount"], returns: [], qualifier: "dynamic" }],
	["MintWithMetadata", { args: ["token_id", "beneficiary", "amount", "static_metadata"], returns: [], qualifier: "dynamic" }],
	["Burn", { args: ["token_id", "amount"], returns: [], qualifier: "dynamic" }],
	["Approve", { args: ["token_id", "beneficiary", "amount", "expires_at"], returns: [], qualifier: "dynamic" }],
	["Revoke", { args: ["token_id", "beneficiary"], returns: [], qualifier: "dynamic" }],
	["Lockup", { args: ["token_id", "beneficiary", "amount"], returns: [], qualifier: "dynamic" }],
	["Release", { args: ["token_id", "benefactor", "beneficiary", "amount"], returns: [], qualifier: "dynamic" }],
	["Symbol", { args: [], returns: ["symbol"], qualifier: "static" }],
	["BalanceOf", { args: ["token_id", "address"], returns: ["balance"], qualifier: "static" }],
	["Creator", { args: [], returns: ["creator"], qualifier: "static" }],
	["Manager", { args: [], returns: ["manager"], qualifier: "static" }],
	["Decimals", { args: [], returns: ["decimals"], qualifier: "static" }],
	["MaxSupply", { args: [], returns: ["max_supply"], qualifier: "static" }],
	["CirculatingSupply", { args: [], returns: ["circulating_supply"], qualifier: "static" }],
	["EnableEvents", { args: [], returns: ["enable_events"], qualifier: "static" }],
	["SetStaticMetadata", { args: ["key", "value"], returns: [], qualifier: "dynamic" }],
	["SetDynamicMetadata", { args: ["key", "value"], returns: [], qualifier: "dynamic" }],
	["GetStaticMetadata", { args: ["key"], returns: ["value"], qualifier: "static" }],
	["GetDynamicMetadata", { args: ["key"], returns: ["value"], qualifier: "static" }],
	["SetStaticTokenMetadata", { args: ["token_id", "key", "value"], returns: [], qualifier: "dynamic" }],
	["SetDynamicTokenMetadata", { args: ["token_id", "key", "value"], returns: [], qualifier: "dynamic" }],
	["GetStaticTokenMetadata", { args: ["token_id", "key"], returns: ["value"], qualifier: "static" }],
	["GetDynamicTokenMetadata", { args: ["token_id", "key"], returns: ["value"], qualifier: "static" }],
]);

// BuiltinMethodSignature describes a method hanging off one of the superglobals.
// `since`/`until` bound the PISA versions that implement it — the compiler
// rejects a call outside that window rather than silently ignoring it.
type BuiltinMethodSignature = {
	args: Array<{ name: string; type: string }>;
	returns: string[];
	since?: PisaVersion;
	until?: PisaVersion;
	replacedBy?: string;
	detail: string;
};

const ENVIRONMENT_METHODS = new Map<string, BuiltinMethodSignature>([
	["Timestamp", { args: [], returns: ["U64"], detail: "Current block timestamp" }],
	["ClusterID", { args: [], returns: ["String"], until: "0.3.2", detail: "Cluster the logic runs on (PISA 0.3.2 only)" }],
	["EffortCapacity", { args: [], returns: ["U64"], since: "0.4.0", detail: "Total fuel available for this execution" }],
	["EffortAvailable", { args: [], returns: ["U64"], since: "0.4.0", detail: "Remaining fuel" }],
	["StorageResult", {
		args: [{ name: "account", type: "Identifier" }, { name: "payer", type: "Identifier" }],
		returns: ["U64", "U64"],
		since: "0.8.0",
		detail: "Storage bytes (added, removed) so far in this interaction for account, charged to payer"
	}],
	["VolumeCapacity", {
		args: [], returns: ["U64"], since: "0.4.0", until: "0.7.1",
		replacedBy: "Environment.StorageResult(account, payer)",
		detail: "Total storage space available (removed in PISA 0.8.0)"
	}],
	["VolumeAvailable", {
		args: [], returns: ["U64"], since: "0.4.0", until: "0.7.1",
		replacedBy: "Environment.StorageResult(account, payer)",
		detail: "Remaining storage space (removed in PISA 0.8.0)"
	}]
]);

const INVOCATION_METHODS = new Map<string, BuiltinMethodSignature>([
	["ID", { args: [], returns: ["Identifier"], detail: "Unique ID of this invocation" }],
	["__id__", { args: [], returns: ["Identifier"], detail: "Alias of Invocation.ID()" }],
	["Caller", { args: [], returns: ["Identifier"], since: "0.5.0", detail: "Immediate caller of this endpoint" }],
	["Kind", { args: [], returns: ["String"], until: "0.3.2", detail: "Interaction kind (PISA 0.3.2 only)" }],
	["FuelLimit", { args: [], returns: ["U64"], until: "0.3.2", detail: "Fuel limit of the interaction (PISA 0.3.2 only)" }],
	["FuelPrice", { args: [], returns: ["U256"], until: "0.3.2", detail: "Fuel price of the interaction (PISA 0.3.2 only)" }]
]);

const BUILTINS_METHODS = new Map<string, BuiltinMethodSignature>([
	["Sha256", { args: [{ name: "data", type: "Bytes" }], returns: ["U256"], detail: "SHA-256 hash" }],
	["Keccak", { args: [{ name: "data", type: "Bytes" }], returns: ["U256"], detail: "Keccak-256 hash" }],
	["Blake2b", { args: [{ name: "data", type: "Bytes" }], returns: ["U256"], detail: "Blake2b hash" }],
	["Sigverify", {
		args: [{ name: "data", type: "Bytes" }, { name: "signature", type: "Bytes" }, { name: "pubkey", type: "Bytes" }],
		returns: ["Bool"],
		detail: "Verify a signature"
	}]
]);

// ACTOR_METHODS are the participant queries introduced with PISA 0.8.0. They
// read the interaction, not any logic's state, so an endpoint that only calls
// them stays `pure`.
const ACTOR_METHODS = new Map<string, BuiltinMethodSignature>([
	["Exists", { args: [], returns: ["Bool"], since: "0.8.0", detail: "Is the identifier a participant of this interaction (never raises)" }],
	["HasSigned", { args: [], returns: ["Bool"], since: "0.8.0", detail: "Has the participant signed this interaction (raises on a non-participant)" }],
	["Param", { args: [{ name: "name", type: "String" }], returns: ["Bytes"], since: "0.8.0", detail: "Interaction parameter supplied by that participant (raises on a non-participant)" }]
]);

const SUPERGLOBAL_METHODS = new Map<string, Map<string, BuiltinMethodSignature>>([
	["Environment", ENVIRONMENT_METHODS],
	["Invocation", INVOCATION_METHODS],
	["Builtins", BUILTINS_METHODS],
	["Actor", ACTOR_METHODS]
]);

// signatureLabel renders a builtin signature the way the reference docs do.
const signatureLabel = (name: string, signature: BuiltinMethodSignature): string => {
	const args = signature.args.map(arg => `${arg.name} ${arg.type}`).join(", ");
	const returns = signature.returns.length > 0 ? ` -> (${signature.returns.join(", ")})` : "";
	return `${name}(${args})${returns}`;
};

// buildMemberCompletions offers the members of whichever receiver the cursor is
// sitting behind — `Environment.`, `Actor(id).`, `asset.` and friends. Returns
// null when the cursor is not after a known receiver, so the caller can fall
// back to the keyword list.
const buildMemberCompletions = (linePrefix: string, pisaVersion: PisaVersion): CompletionItem[] | null => {
	// Only offer what the target version actually implements, so a 0.8.0 project
	// never sees VolumeAvailable and a 0.7.1 one never sees StorageResult.
	const availableOn = (signature: BuiltinMethodSignature): boolean =>
		(!signature.since || isPisaAtLeast(pisaVersion, signature.since))
		&& (!signature.until || !isPisaAfter(pisaVersion, signature.until));

	const toItem = (name: string, signature: BuiltinMethodSignature): CompletionItem => ({
		label: name,
		kind: CompletionItemKind.Method,
		detail: signatureLabel(name, signature),
		documentation: signature.detail
	});

	const superglobal = linePrefix.match(/(?:^|[^A-Za-z0-9_.])(Environment|Invocation|Builtins)\s*\.\s*[A-Za-z0-9_]*$/);
	if (superglobal) {
		const table = SUPERGLOBAL_METHODS.get(superglobal[1]);
		return table ? [...table.entries()]
			.filter(([, signature]) => availableOn(signature))
			.map(([name, signature]) => toItem(name, signature)) : null;
	}

	if (/Actor\s*\([^()]*\)\s*\.\s*[A-Za-z0-9_]*$/.test(linePrefix)) {
		return [...ACTOR_METHODS.entries()]
			.filter(([, signature]) => availableOn(signature))
			.map(([name, signature]) => toItem(name, signature));
	}

	if (/(?:^|[^A-Za-z0-9_.])asset\s*\.\s*[A-Za-z0-9_]*$/.test(linePrefix)) {
		return [...ASSET_METHODS.entries()].map(([name, method]) => ({
			label: name,
			kind: CompletionItemKind.Method,
			detail: `${name}(${method.args.join(", ")})`
				+ (method.returns.length > 0 ? ` -> (${method.returns.join(", ")})` : ""),
			documentation: `Asset engine method — the calling endpoint must be declared '${method.qualifier}'.`
		}));
	}

	return null;
};

// buildLineOffsets returns the absolute offset each line starts at, so a match
// index into the joined text can be turned back into an LSP position.
const buildLineOffsets = (lines: string[]): number[] => {
	const offsets: number[] = [];
	let offset = 0;
	for (const line of lines) {
		offsets.push(offset);
		offset += line.length + 1;
	}
	return offsets;
};

const offsetToPosition = (offsets: number[], pos: number): { line: number; character: number } => {
	let lo = 0;
	let hi = offsets.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (offsets[mid] <= pos) { lo = mid; } else { hi = mid - 1; }
	}
	return { line: lo, character: pos - offsets[lo] };
};

// findMatchingCloseParen walks forward from an opening parenthesis and returns
// the index of its partner, or -1 when the call is still being typed.
const findMatchingCloseParen = (text: string, openParenPos: number): number => {
	let depth = 0;
	for (let i = openParenPos; i < text.length; i++) {
		const ch = text[i];
		if (ch === "(" || ch === "{" || ch === "[") {
			depth++;
		} else if (ch === ")" || ch === "}" || ch === "]") {
			depth--;
			if (depth === 0) {
				return i;
			}
		}
	}
	return -1;
};

const splitCallArguments = (argsText: string): string[] => {
	const trimmed = argsText.trim();
	if (trimmed.length === 0) {
		return [];
	}

	const args: string[] = [];
	let depth = 0;
	let start = 0;
	let quote: string | null = null;
	for (let i = 0; i < argsText.length; i++) {
		const ch = argsText[i];
		if (quote) {
			if (ch === "\\") { i++; continue; }
			if (ch === quote) { quote = null; }
			continue;
		}
		if (ch === '"' || ch === "'") { quote = ch; continue; }
		if (ch === "(" || ch === "{" || ch === "[") { depth++; }
		else if (ch === ")" || ch === "}" || ch === "]") { depth--; }
		else if (ch === "," && depth === 0) {
			args.push(argsText.slice(start, i).trim());
			start = i + 1;
		}
	}
	args.push(argsText.slice(start).trim());
	return args;
};

// isInsideCommentOrString is the same cheap guard checkAssetMethodCalls uses:
// anything past a `//` on the line, or after an odd number of quotes, is text.
const isInsideCommentOrString = (line: string, character: number): boolean => {
	const commentIdx = line.indexOf("//");
	if (commentIdx >= 0 && character >= commentIdx) {
		return true;
	}
	const prefix = line.slice(0, character);
	const doubleQuotes = (prefix.match(/(?<!\\)"/g) || []).length;
	return doubleQuotes % 2 !== 0;
};

// findSuperglobalMethodCalls locates every `Environment.X(`, `Invocation.X(`,
// `Builtins.X(` and `Actor(<expr>).X(` in the document. `Actor` is only treated
// as a superglobal when it does not follow a dot — `Module.Actor(id).field` is
// a state path, not a method call.
const findSuperglobalMethodCalls = (
	normalizedText: string,
	lines: string[],
	offsets: number[]
): Array<{ superglobal: string; method: string; methodStart: number; openParen: number }> => {
	const results: Array<{ superglobal: string; method: string; methodStart: number; openParen: number }> = [];

	const plainPattern = /(?<![A-Za-z0-9_.])(Environment|Invocation|Builtins)\s*\.\s*([A-Za-z_]\w*)\s*\(/g;
	let match: RegExpExecArray | null;
	while ((match = plainPattern.exec(normalizedText)) !== null) {
		const position = offsetToPosition(offsets, match.index);
		if (isInsideCommentOrString(lines[position.line] ?? "", position.character)) {
			continue;
		}
		const methodStart = normalizedText.lastIndexOf(match[2], match.index + match[0].length);
		results.push({
			superglobal: match[1],
			method: match[2],
			methodStart,
			openParen: match.index + match[0].length - 1
		});
	}

	const actorPattern = /(?<![A-Za-z0-9_.])Actor\s*\(/g;
	while ((match = actorPattern.exec(normalizedText)) !== null) {
		const position = offsetToPosition(offsets, match.index);
		if (isInsideCommentOrString(lines[position.line] ?? "", position.character)) {
			continue;
		}
		const closeParen = findMatchingCloseParen(normalizedText, match.index + match[0].length - 1);
		if (closeParen < 0) {
			continue;
		}
		const tail = normalizedText.slice(closeParen + 1).match(/^\s*\.\s*([A-Za-z_]\w*)\s*\(/);
		if (!tail) {
			continue;
		}
		const methodStart = normalizedText.indexOf(tail[1], closeParen + 1);
		results.push({
			superglobal: "Actor",
			method: tail[1],
			methodStart,
			openParen: closeParen + tail[0].length
		});
	}

	return results;
};

// checkSuperglobalMethodCalls validates calls on Environment, Invocation,
// Builtins and Actor(...): the method has to exist, be available on the target
// PISA version, and be called with the arguments it declares.
// stripCommentsAndStrings blanks out everything the compiler would not read as
// code on a line, so keyword scans never trip over `// mutate` or "observe".
const stripCommentsAndStrings = (line: string): string => {
	let result = "";
	let quote: string | null = null;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (quote) {
			result += " ";
			if (ch === "\\") { result += " "; i++; continue; }
			if (ch === quote) { quote = null; }
			continue;
		}
		if (ch === '"' || ch === "'") { quote = ch; result += " "; continue; }
		if (ch === "/" && line[i + 1] === "/") { break; }
		result += ch;
	}
	return result;
};

type QualifierCallable = {
	kind: "endpoint" | "function";
	name: string;
	lifecycle: string | null;
	// `asset` is a state qualifier too, but the compiler exempts it from the
	// requirement check, so it is tracked apart from pure/static/dynamic.
	declared: StateQualifier | null;
	isAssetQualified: boolean;
	line: number;
	nameStart: number;
	bodyStart: number;
	bodyEnd: number;
};

// buildInterfaceMemberQualifiers records the qualifier each interface member
// declares. An `endpoint:` member without one reads external state, so it counts
// as `static`; every `asset:` member counts as `dynamic`.
const buildInterfaceMemberQualifiers = (text: string): Map<string, Map<string, StateQualifier>> => {
	const lines = text.split(/\r?\n/);
	const interfaces = new Map<string, Map<string, StateQualifier>>();

	let currentInterface: string | null = null;
	let interfaceIndent = 0;
	let section: "endpoint" | "asset" | null = null;
	let sectionIndent = 0;

	for (const rawLine of lines) {
		const line = stripCommentsAndStrings(rawLine);
		const isBlank = line.trim().length === 0;
		const indent = line.match(/^\s*/)?.[0].length ?? 0;

		const interfaceMatch = line.match(/^\s*interface\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*$/);
		if (interfaceMatch) {
			currentInterface = interfaceMatch[1];
			interfaceIndent = indent;
			section = null;
			interfaces.set(currentInterface, new Map());
			continue;
		}

		if (currentInterface && !isBlank && indent <= interfaceIndent) {
			currentInterface = null;
			section = null;
		}
		if (!currentInterface) {
			continue;
		}

		const sectionMatch = line.match(/^\s*(endpoint|asset)\s*:\s*$/);
		if (sectionMatch) {
			section = sectionMatch[1] === "asset" ? "asset" : "endpoint";
			sectionIndent = indent;
			continue;
		}
		if (section && !isBlank && indent <= sectionIndent) {
			section = null;
		}
		if (!section) {
			continue;
		}

		const memberMatch = line.match(/^\s*(?:(dynamic|static|pure)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
		if (!memberMatch) {
			continue;
		}

		const qualifier: StateQualifier = section === "asset"
			? "dynamic"
			: ((memberMatch[1] as StateQualifier | undefined) ?? "static");
		interfaces.get(currentInterface)?.set(memberMatch[2], qualifier);
	}

	return interfaces;
};

// collectQualifierCallables finds every top-level endpoint and function along
// with the body it owns.
const collectQualifierCallables = (lines: string[]): QualifierCallable[] => {
	const declarationPattern = /^(endpoint|function)\s+(?:(invoke|enlist|deploy|interact)\s+)?(?:(pure|static|dynamic|asset)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/;
	const results: QualifierCallable[] = [];

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = stripCommentsAndStrings(lines[lineIndex]);
		const match = line.match(declarationPattern);
		if (!match) {
			continue;
		}

		const qualifierWord = match[3];
		const isAssetQualified = qualifierWord === "asset";
		const declared = isAssetQualified ? null : ((qualifierWord as StateQualifier | undefined) ?? null);

		// A signature may wrap across lines, and its closing `):` often sits in
		// column 0 — walk the parentheses so the body starts after the header.
		let headerEnd = lineIndex;
		let depth = 0;
		for (let cursor = lineIndex; cursor < lines.length; cursor++) {
			for (const ch of stripCommentsAndStrings(lines[cursor])) {
				if (ch === "(") { depth++; }
				else if (ch === ")") { depth--; }
			}
			headerEnd = cursor;
			if (depth <= 0) {
				break;
			}
		}

		let bodyEnd = lines.length - 1;
		for (let next = headerEnd + 1; next < lines.length; next++) {
			const candidate = lines[next];
			if (candidate.trim().length === 0) {
				continue;
			}
			if (!/^\s/.test(candidate)) {
				bodyEnd = next - 1;
				break;
			}
		}

		results.push({
			kind: match[1] === "function" ? "function" : "endpoint",
			name: match[4],
			lifecycle: match[2] ?? null,
			declared,
			isAssetQualified,
			line: lineIndex,
			nameStart: line.indexOf(match[4], (match[2] ?? match[1]).length),
			bodyStart: headerEnd + 1,
			bodyEnd
		});
	}

	return results;
};

// checkStateQualifiers infers the qualifier each endpoint and function needs
// from what its body actually does — mutate, observe, asset methods, calls into
// other callables, and cross-logic interface calls — and reports any declaration
// that does not match exactly. `deploy` and `enlist` endpoints are exempt.
// checkReservedWordNames flags declarations that reuse a reserved word. The
// compiler reports these as `Unrecognized token`, which points at the token
// rather than explaining that the name itself is the problem.
const checkReservedWordNames = (
	text: string,
	diagnostics: Diagnostic[]
): void => {
	const lines = text.split(/\r?\n/);
	const callableIndex = buildCallableIndex(text);

	const report = (name: string, line: number, character: number, role: string): void => {
		if (!RESERVED_WORDS.has(name)) {
			return;
		}
		const alternatives = RESERVED_WORD_ALTERNATIVES.get(name);
		diagnostics.push({
			severity: DiagnosticSeverity.Error,
			range: {
				start: { line, character },
				end: { line, character: character + name.length }
			},
			message: `'${name}' is a reserved word and cannot be used as ${role}`
				+ (alternatives ? `. Try ${alternatives}` : ""),
			source: 'ex'
		});
	};

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const code = stripCommentsAndStrings(lines[lineIndex]);

		const declaration = code.match(/^(\s*)(memory|storage|const)\s+([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)/);
		if (declaration) {
			let cursor = declaration[1].length + declaration[2].length;
			for (const rawName of declaration[3].split(",")) {
				const name = rawName.trim();
				const nameStart = code.indexOf(name, cursor);
				if (nameStart >= 0) {
					report(name, lineIndex, nameStart, `a ${declaration[2]} variable name`);
					cursor = nameStart + name.length;
				}
			}
		}

		const member = code.match(/^(\s*)(field|topic)\s+([A-Za-z_][A-Za-z0-9_]*)/);
		if (member) {
			const nameStart = code.indexOf(member[3], member[1].length + member[2].length);
			if (nameStart >= 0) {
				report(member[3], lineIndex, nameStart, `a ${member[2]} name`);
			}
		}
	}

	for (const [callableName, callable] of callableIndex.callables.entries()) {
		report(callableName, callable.definition.line, callable.definition.character, "a callable name");
		for (const [name, location] of callable.params.entries()) {
			report(name, location.line, location.character, "an argument name");
		}
		for (const [name, location] of callable.returns.entries()) {
			report(name, location.line, location.character, "a return value name");
		}
	}
};

const checkStateQualifiers = (
	text: string,
	pisaVersion: PisaVersion,
	interfaceStateIndex: InterfaceStateIndex,
	diagnostics: Diagnostic[]
): void => {
	// PISA 0.3.2 predates the static/dynamic qualifiers entirely and has its own,
	// looser rules. Its vocabulary is no longer supported, so leave it alone.
	if (!isPisaAtLeast(pisaVersion, "0.4.0")) {
		return;
	}

	// `pure` only exists from PISA 0.6.0 (reported as 0.7.1) onwards. Below that
	// an omitted qualifier means `static`, and a body with no state access still
	// requires `static`.
	const supportsPure = isPisaAtLeast(pisaVersion, "0.7.1");
	const noAccessQualifier: StateQualifier = supportsPure ? "pure" : "static";

	const lines = text.split(/\r?\n/);
	const callables = collectQualifierCallables(lines);
	if (callables.length === 0) {
		return;
	}

	const callableIndex = buildCallableIndex(text);
	const interfaceMembers = buildInterfaceMemberQualifiers(text);
	const byName = new Map<string, QualifierCallable>();
	for (const callable of callables) {
		if (!byName.has(callable.name)) {
			byName.set(callable.name, callable);
		}
	}

	const direct = new Map<string, StateQualifier>();
	const callees = new Map<string, Set<string>>();

	for (const callable of callables) {
		let required: StateQualifier = "pure";
		const called = new Set<string>();

		for (let lineIndex = callable.bodyStart; lineIndex <= callable.bodyEnd && lineIndex < lines.length; lineIndex++) {
			const code = stripCommentsAndStrings(lines[lineIndex]);
			if (code.trim().length === 0) {
				continue;
			}

			if (/\bmutate\b/.test(code)) {
				required = "dynamic";
			} else if (/\b(?:observe|gather)\b/.test(code)) {
				required = strongerQualifier(required, "static");
			}

			// On PISA 0.4.0 emitting an event is itself a state change.
			if (pisaVersion === "0.4.0" && /\bemit\b/.test(code)) {
				required = "dynamic";
			}

			for (const assetCall of code.matchAll(/\basset\s*\.\s*([A-Za-z_]\w*)\s*\(/g)) {
				const assetMethod = ASSET_METHODS.get(assetCall[1]);
				if (assetMethod) {
					required = strongerQualifier(required, assetMethod.qualifier);
				}
			}

			for (const candidate of findCallCandidates(code)) {
				if (candidate.callee !== callable.name && byName.has(candidate.callee)) {
					called.add(candidate.callee);
				}
			}

			for (const memberCall of code.matchAll(/(?:^|[^A-Za-z0-9_.])([A-Za-z_]\w*)\s*(?:\([^()]*\))?\s*\.\s*([A-Za-z_]\w*)\s*\(/g)) {
				const receiver = memberCall[1];
				const member = memberCall[2];
				if (receiver === "asset" || receiver === "self" || SUPERGLOBAL_METHODS.has(receiver)) {
					continue;
				}

				let interfaceName: string | null = interfaceMembers.has(receiver) ? receiver : null;
				if (!interfaceName) {
					const receiverType = findTypeForReceiver(text, receiver, lineIndex, callableIndex)
						?? findAssignedTypeGlobal(text, receiver, lineIndex)
						?? resolveInterfaceReceiver(text, receiver, lineIndex, interfaceStateIndex);
					if (receiverType && interfaceMembers.has(receiverType)) {
						interfaceName = receiverType;
					}
				}

				const memberQualifier = interfaceName ? interfaceMembers.get(interfaceName)?.get(member) : undefined;
				if (memberQualifier) {
					required = strongerQualifier(required, memberQualifier);
				}
			}
		}

		direct.set(callable.name, strongerQualifier(direct.get(callable.name) ?? "pure", required));
		callees.set(callable.name, called);
	}

	// Requirements travel up the call graph, so keep folding callee requirements
	// into their callers until nothing changes.
	const resolved = new Map(direct);
	for (let pass = 0; pass < callables.length; pass++) {
		let changed = false;
		for (const callable of callables) {
			let required = resolved.get(callable.name) ?? "pure";
			for (const callee of callees.get(callable.name) ?? []) {
				required = strongerQualifier(required, resolved.get(callee) ?? "pure");
			}
			if (required !== resolved.get(callable.name)) {
				resolved.set(callable.name, required);
				changed = true;
			}
		}
		if (!changed) {
			break;
		}
	}

	for (const callable of callables) {
		// deploy and enlist are dynamic by definition, and `endpoint asset` is
		// exempt as well — the compiler skips all three.
		if (callable.lifecycle === "deploy" || callable.lifecycle === "enlist" || callable.isAssetQualified) {
			continue;
		}

		const inferred = resolved.get(callable.name) ?? "pure";
		const required = inferred === "pure" ? noAccessQualifier : inferred;
		const declared = callable.declared ?? noAccessQualifier;
		if (declared === required) {
			continue;
		}

		const hint = callable.declared === null
			? ` (an omitted qualifier means '${noAccessQualifier}', so write '${callable.kind} ${required} ${callable.name}')`
			: "";
		diagnostics.push({
			severity: DiagnosticSeverity.Error,
			range: {
				start: { line: callable.line, character: Math.max(0, callable.nameStart) },
				end: { line: callable.line, character: Math.max(0, callable.nameStart) + callable.name.length }
			},
			message: `${callable.kind} '${callable.name}' is declared as '${declared}', but it requires state qualifier '${required}'${hint}`,
			source: 'ex'
		});
	}
};

const checkSuperglobalMethodCalls = (
	text: string,
	pisaVersion: PisaVersion,
	classIndex: ClassIndex,
	diagnostics: Diagnostic[]
): void => {
	const lines = text.split(/\r?\n/);
	const offsets = buildLineOffsets(lines);
	const normalizedText = lines.join("\n");
	const callableIndex = buildCallableIndex(text);

	for (const call of findSuperglobalMethodCalls(normalizedText, lines, offsets)) {
		const table = SUPERGLOBAL_METHODS.get(call.superglobal);
		if (!table) {
			continue;
		}

		const methodPosition = offsetToPosition(offsets, call.methodStart);
		const methodRange = {
			start: methodPosition,
			end: { line: methodPosition.line, character: methodPosition.character + call.method.length }
		};

		// Actor is written `Actor(id).Method()`, so spell it that way in messages.
		const receiverLabel = call.superglobal === "Actor" ? "Actor(id)" : call.superglobal;

		const signature = table.get(call.method);
		if (!signature) {
			const known = [...table.keys()].join(", ");
			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				range: methodRange,
				message: call.superglobal === "Actor"
					? `'${call.method}' is not defined for type identifier. Actor methods are: ${known}`
					: `'${call.method}' is not a method of ${call.superglobal}. Known methods: ${known}`,
				source: 'ex'
			});
			continue;
		}

		if (signature.since && !isPisaAtLeast(pisaVersion, signature.since)) {
			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				range: methodRange,
				message: `${receiverLabel}.${call.method}() is not implemented in PISA v${pisaVersion}, implemented in v${signature.since}`,
				source: 'ex'
			});
			continue;
		}

		if (signature.until && isPisaAfter(pisaVersion, signature.until)) {
			const replacement = signature.replacedBy ? ` — use ${signature.replacedBy}` : "";
			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				range: methodRange,
				message: `${receiverLabel}.${call.method}() is not supported in PISA v${pisaVersion}, it exists only up to v${signature.until}${replacement}`,
				source: 'ex'
			});
			continue;
		}

		const closeParen = findMatchingCloseParen(normalizedText, call.openParen);
		if (closeParen < 0) {
			continue;
		}

		const argsText = normalizedText.slice(call.openParen + 1, closeParen);
		const args = splitCallArguments(argsText);
		if (args.length !== signature.args.length) {
			const names = signature.args.map(arg => arg.name).join(", ");
			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				range: methodRange,
				message: `${call.method} takes exactly ${signature.args.length} argument(s)${names ? ` (${names})` : ""}, found ${args.length}`,
				source: 'ex'
			});
			continue;
		}

		for (let index = 0; index < args.length; index++) {
			const expected = signature.args[index];
			const labelMatch = args[index].match(/^([A-Za-z_]\w*)\s*:\s*([\s\S]*)$/);
			const valueText = labelMatch ? labelMatch[2] : args[index];

			if (labelMatch && !signature.args.some(arg => arg.name === labelMatch[1])) {
				diagnostics.push({
					severity: DiagnosticSeverity.Warning,
					range: methodRange,
					message: `unknown argument '${labelMatch[1]}' for ${receiverLabel}.${call.method}(). Expected: ${signature.args.map(arg => arg.name).join(", ")}`,
					source: 'ex'
				});
				continue;
			}

			const expectedName = labelMatch
				? (signature.args.find(arg => arg.name === labelMatch[1])?.type ?? expected.type)
				: expected.type;
			const actual = inferExpressionType(valueText, methodPosition.line, text, callableIndex, classIndex);
			if (actual && !actual.isCollection && actual.typeName !== expectedName && builtinTypeNames.has(actual.typeName)) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					range: methodRange,
					message: `argument '${labelMatch ? labelMatch[1] : expected.name}' of '${call.method}' expects type ${expectedName}, found ${actual.typeName}`,
					source: 'ex'
				});
			}
		}
	}
};

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
	const endpointPattern = /^\s*endpoint\s+(?:(?:invoke|enlist|deploy)\s+)?(?:(?:pure|static|dynamic|asset)\s+)?([A-Za-z_][A-Za-z0-9_]*)\b/;
	const functionPattern = /^\s*function\s+(?:(?:pure|static|dynamic|asset)\s+)?([A-Za-z_][A-Za-z0-9_]*)\b/;
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

			for (const entry of parseLiteralEntries(literal.bodyText, literal.bodyStart)) {
				if (allowed.has(entry.name)) {
					continue;
				}

				// A bare name is the field-name shorthand, so the compiler reads it
				// as a field first and only then as the variable supplying the value.
				const message = entry.kind === "shorthand"
					? `field '${entry.name}' not found in ${literal.typeName}; use '<field>: ${entry.name}' to name the field explicitly`
					: `'${entry.name}' is not a member of ${literal.typeName}`;

				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					range: {
						start: { line: lineIndex, character: entry.start },
						end: { line: lineIndex, character: entry.start + entry.name.length }
					},
					message,
					source: 'ex'
				});
			}
		}
	}
};

const checkStateFieldReferences = (
	text: string,
	stateIndex: StateIndex,
	interfaceStateIndex: InterfaceStateIndex,
	classIndex: ClassIndex,
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

		const stateRefs = splitTopLevelSegments(info.stateRef, ",");
		const baseStart = info.stateRange?.start ?? scanLine.indexOf(info.stateRef);

		for (const ref of stateRefs) {
			const refStart = baseStart >= 0 ? baseStart + ref.start : -1;
			const parsedRef = parseStateFieldRef(ref.text);
			if (!parsedRef) {
				if (refStart >= 0) {
					diagnostics.push({
						severity: DiagnosticSeverity.Error,
						range: {
							start: { line: lineIndex, character: refStart },
							end: { line: lineIndex, character: refStart + ref.text.length }
						},
						message: `State field identifier must be <logic>.<Logic|Sender|Actor(Identifier expression)>.<field>`,
						source: 'ex'
					});
				}
				continue;
			}

			const identityError = validateStateIdentity(parsedRef.actorRef, lineIndex, refStart + parsedRef.actorStart, text, callableIndex, classIndex);
			if (identityError) {
				diagnostics.push(identityError);
				continue;
			}

			const { rootName, actorRef, fieldName } = parsedRef;
			const start = refStart >= 0 ? refStart : baseStart;

			if (stateIndex.moduleName && rootName === stateIndex.moduleName) {
				const isLogic = actorRef === "Logic";
				const fields = isLogic ? stateIndex.logicFields : stateIndex.actorFields;
				if (!fields.has(fieldName)) {
					if (start >= 0) {
						const fieldStart = start + parsedRef.fieldStart;
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

			const isLogic = actorRef === "Logic";
			const fields = isLogic ? interfaceState.logicFields : interfaceState.actorFields;
			if (!fields.has(fieldName)) {
				if (start >= 0) {
					const fieldStart = start + parsedRef.fieldStart;
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

		if (info.payerRef) {
			const payerStart = info.payerRange?.start ?? scanLine.indexOf(info.payerRef);
			const payerError = validateStateIdentity(info.payerRef, lineIndex, payerStart, text, callableIndex, classIndex);
			if (payerError) {
				diagnostics.push(payerError);
			}
		}
	}
};

// isAtomicStateType reports whether a state field lives in atomic storage —
// maps, arrays and classes are scattered across storage slots and can only be
// moved with `gather` / `disperse`, never assigned whole.
const isAtomicStateType = (fieldType: string, classIndex: ClassIndex): boolean => {
	const trimmed = fieldType.trim();
	if (trimmed.startsWith("Map[") || trimmed.startsWith("[")) {
		return true;
	}
	const bareName = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)$/);
	return bareName !== null && classIndex.classes.has(bareName[1]);
};

// checkWholeStateWrites catches `mutate value -> Module.Logic.collection`, where
// the target is a map, array or class. The compiler answers that with "Can't
// store a non-dispersable value into variable '<field>'"; the read-modify-write
// block form (`mutate c <- ...:` with `disperse` inside) is the way to do it.
const checkWholeStateWrites = (
	text: string,
	stateIndex: StateIndex,
	classIndex: ClassIndex,
	diagnostics: Diagnostic[]
): void => {
	if (!stateIndex.moduleName) {
		return;
	}

	const lines = text.split(/\r?\n/);

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const scanLine = stripCommentsAndStrings(lines[lineIndex]);
		const info = extractMutateObserveInfo(scanLine);
		if (info.verb !== "mutate" || !info.stateRef || !info.stateRange) {
			continue;
		}

		// Only the direct write form assigns a whole value; `mutate x <- path:`
		// opens a block that modifies the field in place, which is allowed.
		const arrows = findMutateObserveArrows(scanLine, 0);
		if (arrows.length === 0 || arrows[arrows.length - 1].token !== "->") {
			continue;
		}

		for (const ref of splitTopLevelSegments(info.stateRef, ",")) {
			const parsedRef = parseStateFieldRef(ref.text);
			if (!parsedRef || parsedRef.rootName !== stateIndex.moduleName) {
				continue;
			}

			const isLogic = parsedRef.actorRef === "Logic";
			const fieldTypes = isLogic ? stateIndex.logicFieldTypes : stateIndex.actorFieldTypes;
			const fieldType = fieldTypes.get(parsedRef.fieldName);
			if (!fieldType || !isAtomicStateType(fieldType, classIndex)) {
				continue;
			}

			const fieldStart = info.stateRange.start + ref.start + parsedRef.fieldStart;
			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				range: {
					start: { line: lineIndex, character: fieldStart },
					end: { line: lineIndex, character: fieldStart + parsedRef.fieldName.length }
				},
				message: `'${parsedRef.fieldName}' is ${fieldType}, which lives in atomic storage and cannot be assigned whole`
					+ `. Open a block instead — 'mutate ${parsedRef.fieldName} <- ${ref.text}:' — and use 'disperse' inside it`,
				source: 'ex'
			});
		}
	}
};

// checkPayerClauses enforces the rules around the `payer` clause the compiler
// gained with PISA 0.8.0: it is a mutate-only clause, it may only re-bill a
// logic-state write, and it needs a 0.8.0 target. The payer expression itself
// (Logic / Sender / Actor(...)) is validated alongside state identities in
// checkStateFieldReferences.
const checkPayerClauses = (
	text: string,
	pisaVersion: PisaVersion,
	diagnostics: Diagnostic[]
): void => {
	const lines = text.split(/\r?\n/);

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex];
		const commentIndex = line.indexOf("//");
		const scanLine = commentIndex >= 0 ? line.slice(0, commentIndex) : line;
		const info = extractMutateObserveInfo(scanLine);
		if (!info.payerRef || !info.payerRange) {
			continue;
		}

		const payerKeyword = scanLine.lastIndexOf("payer", info.payerRange.start);
		const range = {
			start: { line: lineIndex, character: payerKeyword >= 0 ? payerKeyword : info.payerRange.start },
			end: { line: lineIndex, character: info.payerRange.end }
		};

		if (info.verb === "observe") {
			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				range,
				message: "payer is only allowed on mutate; observe does not consume storage",
				source: 'ex'
			});
			continue;
		}

		if (!isPisaAtLeast(pisaVersion, "0.8.0")) {
			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				range,
				message: `payer for state logic volume is not supported in PISA version ${pisaVersion}, requires 0.8.0`,
				source: 'ex'
			});
			continue;
		}

		if (!info.stateRef) {
			continue;
		}

		for (const ref of splitTopLevelSegments(info.stateRef, ",")) {
			const parsedRef = parseStateFieldRef(ref.text);
			if (parsedRef && parsedRef.actorRef !== "Logic") {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					range,
					message: "type mismatch: payer can only be set on logic state",
					source: 'ex'
				});
				break;
			}
		}
	}
};

const splitTopLevelSegments = (text: string, separator: "," | "."): Segment[] => {
	const results: Segment[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i <= text.length; i++) {
		const ch = text[i];
		if (ch === "(" || ch === "[" || ch === "{") { depth++; }
		if (ch === ")" || ch === "]" || ch === "}") { depth--; }
		const isEnd = i === text.length || (ch === separator && depth === 0);
		if (!isEnd) {
			continue;
		}
		const segment = trimSegment(text, start, i);
		if (segment.text.length > 0) {
			results.push(segment);
		}
		start = i + 1;
	}
	return results;
};

const parseStateFieldRef = (ref: string): StateRefParts | null => {
	const parts = splitTopLevelSegments(ref, ".");
	if (parts.length !== 3) {
		return null;
	}
	const [root, actor, field] = parts;
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(root.text) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(field.text)) {
		return null;
	}
	if (!isValidStateIdentitySyntax(actor.text)) {
		return null;
	}
	return {
		rootName: root.text,
		actorRef: actor.text,
		fieldName: field.text,
		rootStart: root.start,
		actorStart: actor.start,
		fieldStart: field.start
	};
};

const isValidStateIdentitySyntax = (value: string): boolean => {
	if (value === "Logic" || value === "Sender") {
		return true;
	}
	return /^Actor\s*\(.+\)$/.test(value);
};

const validateStateIdentity = (
	value: string,
	lineIndex: number,
	start: number,
	text: string,
	callableIndex: CallableIndex,
	classIndex: ClassIndex
): Diagnostic | null => {
	if (value === "Logic" || value === "Sender") {
		return null;
	}

	const actorMatch = value.match(/^Actor\s*\((.*)\)$/);
	if (!actorMatch || actorMatch[1].trim().length === 0) {
		return {
			severity: DiagnosticSeverity.Error,
			range: {
				start: { line: lineIndex, character: start },
				end: { line: lineIndex, character: start + value.length }
			},
			message: `Actor must be Logic, Sender, or Actor(Identifier expression)`,
			source: 'ex'
		};
	}

	const expr = actorMatch[1].trim();
	const exprOffset = value.indexOf(actorMatch[1]) + actorMatch[1].indexOf(expr);
	const exprType = inferExpressionType(expr, lineIndex, text, callableIndex, classIndex);
	if (exprType && exprType.typeName !== "Identifier") {
		return {
			severity: DiagnosticSeverity.Error,
			range: {
				start: { line: lineIndex, character: start + exprOffset },
				end: { line: lineIndex, character: start + exprOffset + expr.length }
			},
			message: `Actor argument must be an Identifier expression`,
			source: 'ex'
		};
	}

	return null;
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
	["Identifier", new Set(["String", "Bytes", "U64", "I64", "U256", "Identifier", "Invocation"])],
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

// inferSuperglobalReturnType types a whole-expression call on a superglobal.
// Only single-return methods produce a type: StorageResult yields a pair, which
// the caller destructures rather than assigning as one value.
const inferSuperglobalReturnType = (
	trimmed: string
): { typeName: string; isCollection: boolean } | null => {
	const plain = trimmed.match(/^(Environment|Invocation|Builtins)\s*\.\s*([A-Za-z_]\w*)\s*\(/);
	if (plain) {
		const signature = SUPERGLOBAL_METHODS.get(plain[1])?.get(plain[2]);
		return signature && signature.returns.length === 1
			? { typeName: signature.returns[0], isCollection: false }
			: null;
	}

	const actor = trimmed.match(/^Actor\s*\(/);
	if (actor) {
		const closeParen = findMatchingCloseParen(trimmed, actor[0].length - 1);
		if (closeParen < 0) {
			return null;
		}
		const tail = trimmed.slice(closeParen + 1).match(/^\s*\.\s*([A-Za-z_]\w*)\s*\(/);
		const signature = tail ? ACTOR_METHODS.get(tail[1]) : undefined;
		return signature && signature.returns.length === 1
			? { typeName: signature.returns[0], isCollection: false }
			: null;
	}

	return null;
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

	if (/^\d+$/.test(trimmed)) {
		return { typeName: "U64", isCollection: false };
	}

	if (/^"[^"]*"$/.test(trimmed) || /^'[^']*'$/.test(trimmed)) {
		return { typeName: "String", isCollection: false };
	}

	// Known typecast call → return type
	const castMatch = trimmed.match(/^(Bool|String|Identifier|U64|I64|U256|Bytes)\s*\(/);
	if (castMatch) {
		return { typeName: castMatch[1], isCollection: false };
	}

	// Superglobal method call: Environment.Timestamp(), Actor(id).Exists(), ...
	const superglobalReturn = inferSuperglobalReturnType(trimmed);
	if (superglobalReturn) {
		return superglobalReturn;
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
				const identEnd = beforeDot + 1;
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
					const identEnd = beforeDot + 1;
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
		if (!trimmed || trimmed.startsWith("//")) {continue;}
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
