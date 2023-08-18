"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.statefulValidation = void 0;
const node_1 = require("vscode-languageserver/node");
function statefulValidation(text, diagnostics) {
    const endpointPattern = /^\s*(endpoint|func)\s+(\w+)\s*(\w+)(!)?\s*\([^)]*\):\s*$/;
    const mutatePattern = /^\s*mutate\s*(.*)?$/;
    const statefulFuncPattern = /^\s*(\w+)!\(([^)]*)\)$/;
    const lines = text.split(/\r?\n/);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex];
        const endpointMatch = line.match(endpointPattern);
        if (endpointMatch) {
            const endpointName = endpointMatch[1];
            const hasExclamation = !!endpointMatch[4]; // Check if '!' is present
            let hasMutateKeyword = false;
            let hasStatefulFunc = false;
            // Check for 'mutate' keyword after the endpoint/func declaration
            for (let bodyLineIndex = lineIndex + 1; bodyLineIndex < lines.length; bodyLineIndex++) {
                const bodyLine = lines[bodyLineIndex];
                if (!(/^\s*$/.test(bodyLine))) { // Skip empty lines
                    if (bodyLine.match(mutatePattern)) {
                        hasMutateKeyword = true;
                        break;
                    }
                    if (bodyLine.match(statefulFuncPattern)) {
                        hasStatefulFunc = true;
                        break;
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
    return diagnostics;
}
exports.statefulValidation = statefulValidation;
//# sourceMappingURL=validation.js.map