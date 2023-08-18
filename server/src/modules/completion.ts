import {
	CompletionItem,
	CompletionItemKind,
} from 'vscode-languageserver/node';

export function completionItems(): CompletionItem[] {
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
			label: 'func',
			kind: CompletionItemKind.Text,
			data: 3
		},
		{
			label: 'deployer',
			kind: CompletionItemKind.Text,
			data: 4
		},
		{
			label: 'invokable',
			kind: CompletionItemKind.Text,
			data: 5
		},
		{
			label: 'endpoint',
			kind: CompletionItemKind.Text,
			data: 6
		},
		{
			label: 'state',
			kind: CompletionItemKind.Text,
			data: 7
		},
		{
			label: 'persistent',
			kind: CompletionItemKind.Text,
			data: 8
		},
		{
			label: 'class',
			kind: CompletionItemKind.Text,
			data: 9
		},
		{
			label: 'method',
			kind: CompletionItemKind.Text,
			data: 10
		},
		{
			label: 'method',
			kind: CompletionItemKind.Text,
			data: 10
		},
		{
			label: 'coco',
			kind: CompletionItemKind.Text,
			data: 11
		}
	]
}

export function completionDetails(item: CompletionItem): CompletionItem {
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
			item.detail = 'func declaration';
			item.documentation = 'Functions are used for code reusability and maintainability. They only exist within the module scope.';
			break;
		case 4:
			item.detail = 'deployer declaration';
			item.documentation = 'Deployers are endpoints used to initialize a persistent state and can be thought of as the constructor of the module.';
			break;
		case 5:
			item.detail = 'invokable declaration';
			item.documentation = 'Invokables are endpoints that can only be invoked externally by a single participant. ';
			break;
		case 6:
			item.detail = 'endpoint declaration';
			item.documentation = 'A endpoint in Coco is a callable element for code organization and reusability.';
			break;
		case 7:
			item.detail = 'state declaration';
			item.documentation = 'Coco supports persistent and ephemeral state types.';
			break;
		case 8:
			item.detail = 'persistent state';
			item.documentation = 'Persistent state is the state of the module and ephemeral state refers to the state of the participant.';
			break;
		case 9:
			item.detail = 'class declaration';
			item.documentation = 'Classes in Coco allows you to simplify the handling of complex structures. Each class is made up of fields and methods.';
			break;
		case 10:
			item.detail = 'method declaration';
			item.documentation = 'Methods can be declared within the class block using the method keyword followed by the name of the method, input parameters and output parameters.';
			break;
		case 11:
			item.detail = 'module declaration';
			item.documentation = 'The name of the module is one of Coco’s superglobals. It can be used to access the state information of the module as well as other information about the logic module.';
			break;
		default:
			break;
	}

	return item;
}

