import {
	Diagnostic,
	DiagnosticSeverity,
} from 'vscode-languageserver/node';


export const statefulValidation = (text: String, diagnostics: Diagnostic[]) => {
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

				if(/^(?!\s*$)[^\t ]/.test(bodyLine)){
					break;
				}

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
				const diagnostic: Diagnostic = {
					severity: DiagnosticSeverity.Error,
					range: {
						start: { line: lineIndex, character: 0 },
						end: { line: lineIndex, character: line.length }
					},
					message: `'${endpointName}' is missing the '!' stateful identifier while performing state modifications`,
					source: 'ex'
				};
				diagnostics.push(diagnostic);
			}
		}
	}

	return diagnostics;
}