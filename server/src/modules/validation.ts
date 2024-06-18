import {
	Diagnostic,
	DiagnosticSeverity,
} from 'vscode-languageserver/node';

// checkNames ensures that every callable's name begins with alphanumeric or underscore
export const checkNames = (text: String, diagnostics: Diagnostic[]) => {
	const endpointPattern = /^(endpoint)\s+(invoke|enlist|deploy)\s+((persistent|ephemeral|readonly)\s+)?(\w+)/;
	const functionPattern = /^(func)\s+(persistent|ephemeral|readonly)\s+(\w+)/;
	const lines = text.split(/\r?\n/);

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex];
		const patternMatch = line.match(endpointPattern) || line.match(functionPattern);
		let callableName = ""

		if (patternMatch){
			if(patternMatch[1]=="endpoint"){
				 callableName = patternMatch[5];
			}

			if(patternMatch[1]=="func"){
				callableName = patternMatch[3]
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

// getCallableTypeMap obtains a map containing all persistent functions and endpoints
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

// statefulValidation ensures that endpoint type is persistent when mutation is performed
export const statefulValidation = (text: string, diagnostics: Diagnostic[], typeMap: Map<string, boolean>) => {
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

// bodyCheck checks the body of a routine for any mutation or stateful function calls
const bodyCheck = (lines: string[], lineIndex: number, typeMap: Map<string, boolean>):boolean => {

	const mutatePattern = /^\s*mutate\s*(.*)?$/;
	const statefulFuncPattern = /\s*\w+\([^)]*\)/;

	let hasMutateKeyword = false;
	let hasStatefulFunc = false;

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

// checkMutation ensures that no mutation is performed as a whole on a collection type in the persistent state
export const checkMutation = (text: string, diagnostics: Diagnostic[], mutateMap: Map<string, boolean>) => {
	const lines = text.split(/\r?\n/);
	const mutatePattern = /^\s*mutate\s*(.*)?$/;

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const bodyLine = lines[lineIndex];

		const mutateStatement = bodyLine.match(mutatePattern);
		if (mutateStatement) {
			if(mutateStatement[1] && !mutateStatement[1].endsWith(":")){
				let stateLoc  = mutateStatement[1].split(" ")[2]
				if(stateLoc && stateLoc.split(".")[2]){
					let location = stateLoc.split(".")[2]
					if(mutateMap.get(location)){
						const diagnostic: Diagnostic = {
							severity: DiagnosticSeverity.Error,
							range: {
								start: { line: lineIndex, character: 0 },
								end: { line: lineIndex, character: bodyLine.length }
							},
							message: `'${location}' is a collection and can't be mutated as a whole`,
							source: 'ex'
						};
						diagnostics.push(diagnostic);
					}
				}
			}
		}
	}
}

// getCollections obtains all the collection objects in the persistent state
export const getCollections = (text: String): Map<string, boolean>=> {
	let collectionMap: Map<string, boolean> = new Map();
	const statePattern = /^(state)\s+(persistent)/;
	const lines = text.split(/\r?\n/);
	
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex];
		const stateMatch = line.match(statePattern);
		const typeDecPattern = /^(?!(\s*\/\/)).*/;

		if(stateMatch){
			// check all variables in the persistent state
			for (let bodyLineIndex = lineIndex + 1; bodyLineIndex < lines.length; bodyLineIndex++) {
				const bodyLine = lines[bodyLineIndex];

				if(/^(?!\s*$)[^\t ]/.test(bodyLine)){
					break;
				}
				
				// Skip empty lines
				if (!(/^\s*$/.test(bodyLine))) { 
					const typePattern = bodyLine.match(typeDecPattern);
					if (typePattern) {
						let words = typePattern[0].trimStart().split(" ")
						if(words[1] && (words[1].startsWith("Map") || words[1].startsWith("["))){
							collectionMap.set(words[0], true)
						}
						
					}
				}
			}
		}
	}

	return collectionMap;
}