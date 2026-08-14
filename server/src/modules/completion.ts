import {
	CompletionItem,
	CompletionItemKind,
} from 'vscode-languageserver/node';

export const completionItems = (): CompletionItem[] => {
	return [
		{
			label: 'mutate',
			kind: CompletionItemKind.Text,
			data: 1
		},
		{
			label: 'observe',
			kind: CompletionItemKind.Text,
			data: 2
		},
		{
			label: 'function',
			kind: CompletionItemKind.Text,
			data: 3
		},
		{
			label: 'deploy',
			kind: CompletionItemKind.Text,
			data: 4
		},
		{
			label: 'invoke',
			kind: CompletionItemKind.Text,
			data: 5
		},
		{
			label: 'enlist',
			kind: CompletionItemKind.Text,
			data: 6
		},
		{
			label: 'endpoint',
			kind: CompletionItemKind.Text,
			data: 7
		},
		{
			label: 'state',
			kind: CompletionItemKind.Text,
			data: 8
		},
		{
			label: 'class',
			kind: CompletionItemKind.Text,
			data: 12
		},
		{
			label: 'method',
			kind: CompletionItemKind.Text,
			data: 13
		},
		{
			label: 'coco',
			kind: CompletionItemKind.Text,
			data: 14
		},
		{
			label: 'memory',
			kind: CompletionItemKind.Text,
			data: 15
		},
		{
			label: 'storage',
			kind: CompletionItemKind.Text,
			data: 16
		},
		{
			label: 'const',
			kind: CompletionItemKind.Text,
			data: 17
		},
		{
			label: 'logic',
			kind: CompletionItemKind.Text,
			data: 18
		},
		{
			label: 'actor',
			kind: CompletionItemKind.Text,
			data: 19
		},
		{
			label: 'dynamic',
			kind: CompletionItemKind.Text,
			data: 20
		},
		{
			label: 'static',
			kind: CompletionItemKind.Text,
			data: 21
		},
		{
			label: 'emit',
			kind: CompletionItemKind.Text,
			data: 22
		},
		{
			label: 'event',
			kind: CompletionItemKind.Text,
			data: 23
		},
		{
			label: 'interface',
			kind: CompletionItemKind.Text,
			data: 24
		},
		{
			label: 'asset',
			kind: CompletionItemKind.Text,
			data: 25
		},
		{
			label: 'payer',
			kind: CompletionItemKind.Text,
			data: 26
		},
		{
			label: 'pure',
			kind: CompletionItemKind.Text,
			data: 27
		},
		{
			label: 'gather',
			kind: CompletionItemKind.Text,
			data: 28
		},
		{
			label: 'disperse',
			kind: CompletionItemKind.Text,
			data: 29
		},
		{
			label: 'yield',
			kind: CompletionItemKind.Text,
			data: 30
		},
		{
			label: 'throw',
			kind: CompletionItemKind.Text,
			data: 31
		},
		{
			label: 'Sender',
			kind: CompletionItemKind.Variable,
			data: 32
		},
		{
			label: 'Logic',
			kind: CompletionItemKind.Variable,
			data: 33
		},
		{
			label: 'Actor',
			kind: CompletionItemKind.Variable,
			data: 34
		},
		{
			label: 'Environment',
			kind: CompletionItemKind.Variable,
			data: 35
		},
		{
			label: 'Invocation',
			kind: CompletionItemKind.Variable,
			data: 36
		},
		{
			label: 'Builtins',
			kind: CompletionItemKind.Variable,
			data: 37
		}
	];
};

export const completionDetails = (item: CompletionItem): CompletionItem => {
	switch (item.data) {
		case 1:
			item.detail = 'mutation action';
			item.documentation = 'Mutate statement is used to set a module value to the state.';
			break;
		case 2:
			item.detail = 'observe action';
			item.documentation = 'Observe statement is used to capture values from the state and sets it to a value.';
			break;
		case 3:
			item.detail = 'function declaration';
			item.documentation = 'Functions are used for code reusability and maintainability. They only exist within the module scope.';
			break;
		case 4:
			item.detail = 'deployer declaration';
			item.documentation = 'Deployers run once, when the logic is deployed, and initialize logic state — the constructor of the module. They take no state qualifier.';
			break;
		case 5:
			item.detail = 'invokable declaration';
			item.documentation = 'Invokables are endpoints called externally by a single participant. This is the default lifecycle, so the keyword is usually omitted.';
			break;
		case 6:
			item.detail = 'enlister declaration';
			item.documentation = 'Enlisters run once per actor, when a participant joins the logic, and initialize that actor\'s state. They take no state qualifier.';
			break;
		case 7:
			item.detail = 'endpoint declaration';
			item.documentation = 'A endpoint in Coco is a callable element for code organization and reusability.';
			break;
		case 8:
			item.detail = 'state declaration';
			item.documentation = 'Coco has two state blocks: `state logic:` for the logic\'s own state, and `state actor:` for per-participant state.';
			break;
		case 12:
			item.detail = 'class declaration';
			item.documentation = 'Classes in Coco allows you to simplify the handling of complex structures. Each class is made up of fields and methods.';
			break;
		case 13:
			item.detail = 'method declaration';
			item.documentation = 'Methods can be declared within the class block using the method keyword followed by the name of the method, input parameters and output parameters.';
			break;
		case 14:
			item.detail = 'module declaration';
			item.documentation = 'The name of the module is one of Coco’s superglobals. It can be used to access the state information of the module as well as other information about the logic module.';
			break;
		case 15:
			item.detail = 'memory declaration';
			item.documentation = 'The memory keyword is used to declare named memory variables with a specific type assigned in Coco';
			break;
		case 16:
			item.detail = 'storage declaration';
			item.documentation = 'The memory keyword is used to declare named storage variables with a specific type assigned in Coco';
			break;
		case 17:
			item.detail = 'const declaration';
			item.documentation = 'The const keyword is used to declare named constant values of a specific type in Coco';
			break;
		case 18:
			item.detail = 'logic state';
			item.documentation = 'Logic state is the state of the module.';
			break;
		case 19:
			item.detail = 'actor state';
			item.documentation = 'Actor state refers to the state of the participant.';
			break;
		case 20:
			item.detail = 'dynamic qualifier';
			item.documentation = 'Endpoint qualifier dynamic allows modifying logic or actor state in endpoint';
			break;
		case 21:
			item.detail = 'static qualifier';
			item.documentation = 'Endpoint qualifier static means the endpoint reads state with observe but never mutates it. It must be written explicitly — an omitted qualifier means pure.';
			break;
		case 22:
			item.detail = 'emit event';
			item.documentation = 'Emit sends an event to a log; event can be a string or a complex object, defined using event keyword.';
			break;
		case 23:
			item.detail = 'event declaration';
			item.documentation = 'Events in Coco define complex type with multiple fields, similar to classes; they can be emitted using emit command.';
			break;
		case 24:
			item.detail = 'interface declaration';
			item.documentation = 'Interfaace defines state structure, endpoints and asset endpoints in external logic that can be called from the current logic.';
			break;
		case 25:
			item.detail = 'asset declaration';
			item.documentation = 'Asset is a qualifier of the coco file to denote an asset logic or a section of an interface that lists endpoints in an asset logic.';
			break;
		case 26:
			item.detail = 'mutation payer';
			item.documentation = 'Payer selects which actor pays for storage changes in a mutate statement. Logic-state mutate only, and requires a PISA 0.8.0 target: mutate v -> M.Logic.f payer Logic | Sender | Actor(id).';
			break;
		case 27:
			item.detail = 'pure qualifier';
			item.documentation = 'Endpoint qualifier pure means the callable touches no state at all. Omitting the qualifier means pure, not static — an endpoint that observes state must say static explicitly.';
			break;
		case 28:
			item.detail = 'gather action';
			item.documentation = 'Gather reads a complete map, array or class out of atomic storage into a memory variable, inside an observe block.';
			break;
		case 29:
			item.detail = 'disperse action';
			item.documentation = 'Disperse writes a complete map, array or class from memory back into atomic storage, inside a mutate block.';
			break;
		case 30:
			item.detail = 'yield statement';
			item.documentation = 'Yield assigns a value to a named return variable: yield out expression.';
			break;
		case 31:
			item.detail = 'throw statement';
			item.documentation = 'Throw aborts the interaction with an error message and reverts every state change made so far.';
			break;
		case 32:
			item.detail = 'Sender superglobal';
			item.documentation = 'The Identifier of the original interaction sender. Stays constant across cross-logic calls — use Invocation.Caller() for the immediate caller.';
			break;
		case 33:
			item.detail = 'Logic superglobal';
			item.documentation = 'The logic itself: the state path Module.Logic.field, and the storage payer in mutate ... payer Logic.';
			break;
		case 34:
			item.detail = 'Actor superglobal';
			item.documentation = 'A participant: the state path Module.Actor(id).field, the payer Actor(id) clause, and the actor methods Exists(), HasSigned() and Param(name) on PISA 0.8.0.';
			break;
		case 35:
			item.detail = 'Environment superglobal';
			item.documentation = 'Runtime context: Timestamp(), EffortCapacity(), EffortAvailable(), and StorageResult(account, payer) on PISA 0.8.0.';
			break;
		case 36:
			item.detail = 'Invocation superglobal';
			item.documentation = 'Current invocation: ID() and Caller(). Identifier(Invocation) converts it to an Identifier.';
			break;
		case 37:
			item.detail = 'Builtins superglobal';
			item.documentation = 'Cryptographic builtins: Sha256(), Keccak(), Blake2b() and Sigverify().';
			break;
		default:
			break;
	}

	return item;
};
