"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.completionDetails = exports.completionItems = void 0;
const node_1 = require("vscode-languageserver/node");
function completionItems() {
    return [
        {
            label: 'mutate',
            kind: node_1.CompletionItemKind.Text,
            data: 1
        },
        {
            label: 'observe',
            kind: node_1.CompletionItemKind.Text,
            data: 2
        },
        {
            label: 'func',
            kind: node_1.CompletionItemKind.Text,
            data: 3
        },
        {
            label: 'deployer',
            kind: node_1.CompletionItemKind.Text,
            data: 4
        },
        {
            label: 'invokable',
            kind: node_1.CompletionItemKind.Text,
            data: 5
        },
        {
            label: 'endpoint',
            kind: node_1.CompletionItemKind.Text,
            data: 6
        },
        {
            label: 'state',
            kind: node_1.CompletionItemKind.Text,
            data: 7
        },
        {
            label: 'persistent',
            kind: node_1.CompletionItemKind.Text,
            data: 8
        }
    ];
}
exports.completionItems = completionItems;
function completionDetails(item) {
    if (item.data === 1) {
        item.detail = 'mutation action';
        item.documentation = 'Mutation documentation';
    }
    else if (item.data === 2) {
        item.detail = 'observe action';
        item.documentation = 'Observe documentation';
    }
    else if (item.data == 3) {
        item.detail = 'func decalration';
        item.documentation = 'Function documentation';
    }
    else if (item.data == 4) {
        item.detail = 'deployer decalration';
        item.documentation = 'Deployer documentation';
    }
    else if (item.data == 5) {
        item.detail = 'invokable decalration';
        item.documentation = 'Invokable documentation';
    }
    else if (item.data == 6) {
        item.detail = 'endpoint decalration';
        item.documentation = 'Endpoint documentation';
    }
    else if (item.data == 7) {
        item.detail = 'state decalration';
        item.documentation = 'State documentation';
    }
    else if (item.data == 8) {
        item.detail = 'persistent state';
        item.documentation = 'State modifier';
    }
    return item;
}
exports.completionDetails = completionDetails;
//# sourceMappingURL=completion.js.map