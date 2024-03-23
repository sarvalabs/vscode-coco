import {
	Diagnostic,
	DiagnosticSeverity,
} from 'vscode-languageserver/node';

export const checkNames = (text: String, diagnostics: Diagnostic[]) => {
	const endpointInvokablePattern = /^(endpoint)\s+(invokable)\s+(persistent|readonly)\s+(\w+)/;
	const endpointDeployerPattern = /^(endpoint)\s+(deployer)\s+(\w+)/;
	const functionPattern = /^(func)\s+(persistent|readonly)\s+(\w+)/;
	const lines = text.split(/\r?\n/);

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex];
		const patternMatch = line.match(endpointDeployerPattern) || line.match(endpointInvokablePattern) || line.match(functionPattern);
		if (patternMatch){
			let callableName = null;
			if(patternMatch[1] == "func" || patternMatch[2] == "deployer"){
				callableName = patternMatch[3];
			}
			if(patternMatch[1] == "endpoint" && patternMatch[2] == "invokable"){
				callableName = patternMatch[4];
			}

			if(callableName && !/^[A-Za-z_]/.test(callableName)){
				const diagnostic: Diagnostic = {
					severity: DiagnosticSeverity.Error,
					range: {
						start: { line: lineIndex, character: 0 },
						end: { line: lineIndex, character: line.length }
					},
					message: `'${callableName}' begins with invalid characters in the ${patternMatch[1]} name`,
					source: 'ex'
				};
				diagnostics.push(diagnostic);
			}
		}
	}
}

export const getCallableTypeMap = (text: String): Map<string, boolean> => {
	const statefulEndpoint = /^(endpoint)\s+(invokable)\s+(persistent)\s+(\w+)$/;
	const statefulFunction = /^(func)\s+(persistent)\s+(\w+)/;
	const lines = text.split(/\r?\n/);
	let statefulMap: Map<string, boolean> = new Map();
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex];
		const statefulMatch = line.match(statefulEndpoint) || line.match(statefulFunction);
		if (statefulMatch){
			if(statefulMatch[1] == "func"){
				statefulMap.set(statefulMatch[3], true)
			}else{
				statefulMap.set(statefulMatch[4], true)
			}
		}
	}

	return statefulMap
}

export const statefulValidation = (text: String, diagnostics: Diagnostic[], typeMap: Map<string, boolean>) => {
	const endpointPattern = /^(endpoint)\s+(invokable)\s+(persistent|readonly)\s+(\w+)/;
	const functionPattern = /^(func)\s+(persistent|readonly)\s+(\w+)/;
	const lines = text.split(/\r?\n/);
	
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex];
		const endpointMatch = line.match(endpointPattern);
		const funcMatch = line.match(functionPattern);
		const isStateful = bodyCheck(lines, lineIndex, typeMap);
		let hasPersistent = false;
		let callableName = null;
		if (endpointMatch) {
			callableName = endpointMatch[4];
			hasPersistent = endpointMatch[3] == "persistent";
		}
		
		if(funcMatch){
			callableName = funcMatch[3];
			hasPersistent = funcMatch[2] == "persistent";
		}


		if (isStateful && !hasPersistent && callableName) {
			const diagnostic: Diagnostic = {
				severity: DiagnosticSeverity.Error,
				range: {
					start: { line: lineIndex, character: 0 },
					end: { line: lineIndex, character: line.length }
				},
				message: `'${callableName}' is missing the 'persistent' stateful identifier while performing state modifications`,
				source: 'ex'
			};
			diagnostics.push(diagnostic);
		}
	}

	return diagnostics;
}

const bodyCheck = (lines: string[], lineIndex: number, typeMap: Map<string, boolean>):boolean => {

	const mutatePattern = /^\s*mutate\s*(.*)?$/;
	const statefulFuncPattern = /\s*\w+\([^)]*\)/;

	let hasMutateKeyword = false;
	let hasStatefulFunc = false;

	// Check for 'mutate' keyword after the endpoint/func declaration
	for (let bodyLineIndex = lineIndex + 1; bodyLineIndex < lines.length; bodyLineIndex++) {
		const bodyLine = lines[bodyLineIndex];

		if(/^(?!\s*$)[^\t ]/.test(bodyLine)){
			break;
		}
		
		// Skip empty lines
		if (!(/^\s*$/.test(bodyLine))) { 
			if (bodyLine.match(mutatePattern)) {

				hasMutateKeyword = true;
				break;
			}

			const funcPattern = bodyLine.match(statefulFuncPattern);
			
			if (funcPattern) {
				const funcName = funcPattern[0].trimStart().split("(")[0];
				if(typeMap.get(funcName)){
					hasStatefulFunc = true;
					break;
				}	
			}
		}
	}
	return (hasStatefulFunc || hasMutateKeyword);
}