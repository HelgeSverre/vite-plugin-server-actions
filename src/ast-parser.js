import { parse } from "@babel/parser";
import traverse from "@babel/traverse";

/**
 * Extract exported functions from JavaScript/TypeScript code using AST parsing
 * @param {string} code - The source code to parse
 * @param {string} filename - The filename (for better error messages)
 * @returns {Array<{name: string, isAsync: boolean, isDefault: boolean, type: string, params: Array, returnType: string|null, jsdoc: string|null}>}
 */
export function extractExportedFunctions(code, filename = "unknown") {
	const functions = [];

	try {
		// Parse the code into an AST
		const ast = parse(code, {
			sourceType: "module",
			plugins: [
				"typescript",
				"jsx",
				"decorators-legacy",
				"dynamicImport",
				"exportDefaultFrom",
				"exportNamespaceFrom",
				"topLevelAwait",
				"classProperties",
				"classPrivateProperties",
				"classPrivateMethods",
			],
		});

		// Traverse the AST to find exported functions
		const traverseFn = traverse.default || traverse;
		traverseFn(ast, {
			// Handle: export function name() {} or export async function name() {}
			ExportNamedDeclaration(path) {
				const declaration = path.node.declaration;

				// Re-exports (export { x } from './other') are not supported: the whole
				// module is replaced by a generated proxy, so re-exported names would be
				// silently dropped.
				if (path.node.source) {
					const droppedNames = path.node.specifiers
						.map((spec) => (spec.exported ? spec.exported.name || spec.exported.value : null))
						.filter(Boolean);
					console.warn(
						`[Vite Server Actions] Warning: Re-exports are not supported and will be dropped in ${filename}: ` +
							`export { ${droppedNames.join(", ")} } from "${path.node.source.value}". ` +
							`Define and export these functions directly in this file.`,
					);
					path.skip();
					return;
				}

				if (declaration && declaration.type === "FunctionDeclaration") {
					if (declaration.id) {
						functions.push({
							name: declaration.id.name,
							isAsync: declaration.async || false,
							isDefault: false,
							type: "function",
							params: extractDetailedParams(declaration.params),
							returnType: extractTypeAnnotation(declaration.returnType),
							jsdoc: extractJSDoc(path.node.leadingComments),
						});
					}
				}

				// Handle: export const name = () => {} or export const name = async () => {}
				if (declaration && declaration.type === "VariableDeclaration") {
					declaration.declarations.forEach((decl) => {
						if (
							decl.init &&
							(decl.init.type === "ArrowFunctionExpression" || decl.init.type === "FunctionExpression")
						) {
							functions.push({
								name: decl.id.name,
								isAsync: decl.init.async || false,
								isDefault: false,
								type: "arrow",
								params: extractDetailedParams(decl.init.params),
								returnType: extractTypeAnnotation(decl.init.returnType),
								jsdoc: extractJSDoc(path.node.leadingComments),
							});
						}
					});
				}
			},

			// Handle: export default function() {} or export default async function name() {}
			ExportDefaultDeclaration(path) {
				const declaration = path.node.declaration;

				if (declaration.type === "FunctionDeclaration") {
					functions.push({
						name: declaration.id ? declaration.id.name : "default",
						isAsync: declaration.async || false,
						isDefault: true,
						type: "function",
						params: extractDetailedParams(declaration.params),
						returnType: extractTypeAnnotation(declaration.returnType),
						jsdoc: extractJSDoc(path.node.leadingComments),
					});
				}

				// Handle: export default () => {} or export default async () => {}
				if (declaration.type === "ArrowFunctionExpression" || declaration.type === "FunctionExpression") {
					functions.push({
						name: "default",
						isAsync: declaration.async || false,
						isDefault: true,
						type: "arrow",
						params: extractDetailedParams(declaration.params),
						returnType: extractTypeAnnotation(declaration.returnType),
						jsdoc: extractJSDoc(path.node.leadingComments),
					});
				}
			},

			// Handle: export * from './other' - not supported, warn loudly
			ExportAllDeclaration(path) {
				console.warn(
					`[Vite Server Actions] Warning: 'export * from "${path.node.source.value}"' in ${filename} is not supported ` +
						`and its exports will be dropped. Define and export the functions directly in this file.`,
				);
			},

			// Handle: export { functionName } or export { internalName as publicName }
			ExportSpecifier(path) {
				// We need to track these and match them with function declarations
				const localName = path.node.local.name;
				// The exported name can be an Identifier or a StringLiteral (export { foo as "bar baz" })
				const exportedName =
					path.node.exported.type === "Identifier" ? path.node.exported.name : path.node.exported.value;
				// export { foo as default } is a default export and must be treated as such
				const isDefault = exportedName === "default";

				// Look for the function in the module scope
				const binding = path.scope.getBinding(localName);
				if (binding && binding.path.isFunctionDeclaration()) {
					functions.push({
						name: exportedName,
						isAsync: binding.path.node.async || false,
						isDefault,
						type: "renamed",
						params: extractDetailedParams(binding.path.node.params),
						returnType: extractTypeAnnotation(binding.path.node.returnType),
						jsdoc: extractJSDoc(binding.path.node.leadingComments),
					});
				}

				// Check if it's a variable with arrow function
				if (binding && binding.path.isVariableDeclarator()) {
					const init = binding.path.node.init;
					if (init && (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression")) {
						functions.push({
							name: exportedName,
							isAsync: init.async || false,
							isDefault,
							type: "renamed-arrow",
							params: extractDetailedParams(init.params),
							returnType: extractTypeAnnotation(init.returnType),
							jsdoc: extractJSDoc(binding.path.node.leadingComments),
						});
					}
				}
			},
		});
	} catch (error) {
		console.error(`Failed to parse ${filename}: ${error.message}`);
		// Return empty array on parse error rather than throwing
		return [];
	}

	// Remove duplicates and return
	const uniqueFunctions = Array.from(new Map(functions.map((fn) => [fn.name, fn])).values());

	return uniqueFunctions;
}

// Reserved words that cannot be used as function names in the generated client code
// (module code is always strict, so strict-mode reserved words are included)
const RESERVED_WORDS = new Set([
	"await",
	"break",
	"case",
	"catch",
	"class",
	"const",
	"continue",
	"debugger",
	"default",
	"delete",
	"do",
	"else",
	"enum",
	"export",
	"extends",
	"false",
	"finally",
	"for",
	"function",
	"if",
	"implements",
	"import",
	"in",
	"instanceof",
	"interface",
	"let",
	"new",
	"null",
	"package",
	"private",
	"protected",
	"public",
	"return",
	"static",
	"super",
	"switch",
	"this",
	"throw",
	"true",
	"try",
	"typeof",
	"var",
	"void",
	"while",
	"with",
	"yield",
]);

/**
 * Validate if a function name is valid JavaScript identifier
 * @param {string} name - The function name to validate
 * @returns {boolean}
 */
export function isValidFunctionName(name) {
	// Check if it's a valid JavaScript identifier and not a reserved word
	return typeof name === "string" && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name) && !RESERVED_WORDS.has(name);
}

/**
 * Extract detailed parameter information from function parameters
 * @param {Array} params - Array of parameter AST nodes
 * @returns {Array<{name: string, type: string|null, defaultValue: string|null, isOptional: boolean, isRest: boolean}>}
 */
export function extractDetailedParams(params) {
	if (!params) return [];

	return params.map((param) => {
		const paramInfo = {
			name: "",
			type: null,
			defaultValue: null,
			isOptional: false,
			isRest: false,
		};

		if (param.type === "Identifier") {
			paramInfo.name = param.name;
			paramInfo.type = extractTypeAnnotation(param.typeAnnotation);
			paramInfo.isOptional = param.optional || false;
		} else if (param.type === "AssignmentPattern") {
			// Handle default parameters: function(name = 'default') or destructured
			// patterns with defaults: function({opts} = {}), function([a, b] = [])
			paramInfo.name = param.left.type === "Identifier" ? param.left.name : generateCode(param.left);
			paramInfo.type = extractTypeAnnotation(param.left.typeAnnotation);
			paramInfo.defaultValue = generateCode(param.right);
			paramInfo.isOptional = true;
		} else if (param.type === "RestElement") {
			// Handle rest parameters: function(...args)
			paramInfo.name = `...${param.argument.name}`;
			paramInfo.type = extractTypeAnnotation(param.typeAnnotation);
			paramInfo.isRest = true;
		} else if (param.type === "ObjectPattern") {
			// Handle destructuring: function({name, age})
			paramInfo.name = generateCode(param);
			paramInfo.type = extractTypeAnnotation(param.typeAnnotation);
			paramInfo.isOptional = param.optional || false;
		} else if (param.type === "ArrayPattern") {
			// Handle array destructuring: function([first, second])
			paramInfo.name = generateCode(param);
			paramInfo.type = extractTypeAnnotation(param.typeAnnotation);
			paramInfo.isOptional = param.optional || false;
		}

		return paramInfo;
	});
}

/**
 * Extract type annotation as string
 * @param {object} typeAnnotation - Type annotation AST node
 * @returns {string|null}
 */
export function extractTypeAnnotation(typeAnnotation) {
	if (!typeAnnotation || !typeAnnotation.typeAnnotation) return null;

	return generateCode(typeAnnotation.typeAnnotation);
}

/**
 * Extract JSDoc comments
 * @param {Array} comments - Array of comment nodes
 * @returns {string|null}
 */
export function extractJSDoc(comments) {
	if (!comments) return null;

	const jsdocComment = comments.find((comment) => comment.type === "CommentBlock" && comment.value.startsWith("*"));

	return jsdocComment ? `/*${jsdocComment.value}*/` : null;
}

/**
 * Generate code string from AST node (simplified)
 * @param {object} node - AST node
 * @returns {string}
 */
function generateCode(node) {
	if (!node) return "";

	try {
		// Simple code generation for common cases
		switch (node.type) {
			case "Identifier":
				return node.name;
			case "StringLiteral":
				return `"${node.value}"`;
			case "NumericLiteral":
				return String(node.value);
			case "BooleanLiteral":
				return String(node.value);
			case "NullLiteral":
				return "null";
			case "ObjectExpression":
				// Common default values like `= {}`
				return node.properties.length === 0 ? "{}" : "object";
			case "ArrayExpression":
				// Common default values like `= []`
				return node.elements.length === 0 ? "[]" : "array";
			case "TSStringKeyword":
				return "string";
			case "TSNumberKeyword":
				return "number";
			case "TSBooleanKeyword":
				return "boolean";
			case "TSAnyKeyword":
				return "any";
			case "TSUnknownKeyword":
				return "unknown";
			case "TSVoidKeyword":
				return "void";
			case "TSArrayType":
				return `${generateCode(node.elementType)}[]`;
			case "TSUnionType":
				return node.types.map((type) => generateCode(type)).join(" | ");
			case "TSLiteralType":
				return generateCode(node.literal);
			case "ObjectPattern":
				const props = node.properties
					.map((prop) => {
						if (prop.type === "ObjectProperty") {
							return prop.key.name;
						} else if (prop.type === "RestElement") {
							return `...${prop.argument.name}`;
						}
						return "";
					})
					.filter(Boolean);
				return `{${props.join(", ")}}`;
			case "ArrayPattern":
				const elements = node.elements.map((elem, i) =>
					elem ? (elem.type === "Identifier" ? elem.name : `_${i}`) : `_${i}`,
				);
				return `[${elements.join(", ")}]`;
			case "TSTypeReference":
				// Handle type references like Todo, CreateTodoInput, etc.
				if (node.typeName) {
					let typeName = "";

					// Handle qualified names like z.infer
					if (node.typeName.type === "TSQualifiedName") {
						typeName = generateCode(node.typeName);
					} else if (node.typeName.type === "Identifier") {
						typeName = node.typeName.name;
					} else {
						return "unknown";
					}

					// Handle generic types like Promise<T>, Array<T>
					if (node.typeParameters && node.typeParameters.params && node.typeParameters.params.length > 0) {
						const typeArgs = node.typeParameters.params.map((param) => generateCode(param)).join(", ");
						return `${typeName}<${typeArgs}>`;
					}
					return typeName;
				}
				return "unknown";
			case "TSTypeLiteral":
				// Handle object type literals
				if (node.members && node.members.length > 0) {
					const members = node.members
						.map((member) => {
							if (member.type === "TSPropertySignature" && member.key) {
								const key = member.key.type === "Identifier" ? member.key.name : "unknown";
								const type = member.typeAnnotation ? generateCode(member.typeAnnotation.typeAnnotation) : "any";
								const optional = member.optional ? "?" : "";
								return `${key}${optional}: ${type}`;
							}
							return "";
						})
						.filter(Boolean);
					return `{ ${members.join("; ")} }`;
				}
				return "{}";
			case "TSInterfaceDeclaration":
				// Handle interface declarations
				return node.id ? node.id.name : "unknown";
			case "TSNullKeyword":
				return "null";
			case "TSUndefinedKeyword":
				return "undefined";
			case "TSFunctionType":
				// Handle function type signatures
				const funcParams = node.parameters
					.map((param) => {
						let paramStr = "";
						const paramName = param.name ? param.name : "_";
						const paramType = param.typeAnnotation ? generateCode(param.typeAnnotation.typeAnnotation) : "any";

						// Handle rest parameters
						if (param.type === "RestElement") {
							paramStr = `...${param.argument.name}: ${paramType}`;
						} else {
							paramStr = `${paramName}`;
							// Handle optional parameters
							if (param.optional) {
								paramStr += "?";
							}
							paramStr += `: ${paramType}`;
						}

						return paramStr;
					})
					.join(", ");
				const funcReturn = node.typeAnnotation ? generateCode(node.typeAnnotation.typeAnnotation) : "void";
				return `(${funcParams}) => ${funcReturn}`;
			case "TSIntersectionType":
				// Handle intersection types: A & B & C
				return node.types.map((type) => generateCode(type)).join(" & ");
			case "TSTupleType":
				// Handle tuple types: [string, number, boolean]
				const tupleElements = node.elementTypes.map((elem) => generateCode(elem)).join(", ");
				return `[${tupleElements}]`;
			case "TSIndexSignature":
				// Handle index signatures: { [key: string]: any }
				if (node.parameters && node.parameters.length > 0) {
					const param = node.parameters[0];
					const keyName = param.name || "key";
					const keyType = param.typeAnnotation ? generateCode(param.typeAnnotation.typeAnnotation) : "string";
					const valueType = node.typeAnnotation ? generateCode(node.typeAnnotation.typeAnnotation) : "any";
					return `[${keyName}: ${keyType}]: ${valueType}`;
				}
				return "[key: string]: any";
			case "TSBigIntKeyword":
				return "bigint";
			case "TSSymbolKeyword":
				return "symbol";
			case "TSNeverKeyword":
				return "never";
			case "TSThisType":
				return "this";
			case "TSTemplateLiteralType":
				// Handle template literal types
				if (node.quasis && node.types) {
					let result = "";
					for (let i = 0; i < node.quasis.length; i++) {
						result += node.quasis[i].value.raw;
						if (i < node.types.length) {
							result += "${" + generateCode(node.types[i]) + "}";
						}
					}
					return "`" + result + "`";
				}
				return "`${string}`";
			case "TemplateLiteral":
				// Handle template literals (non-type version)
				if (node.quasis && node.expressions) {
					let result = "";
					for (let i = 0; i < node.quasis.length; i++) {
						result += node.quasis[i].value.raw;
						if (i < node.expressions.length) {
							result += "${" + generateCode(node.expressions[i]) + "}";
						}
					}
					return "`" + result + "`";
				}
				return "`${string}`";
			case "TSConditionalType":
				// Handle conditional types: T extends U ? X : Y
				const checkType = generateCode(node.checkType);
				const extendsType = generateCode(node.extendsType);
				const trueType = generateCode(node.trueType);
				const falseType = generateCode(node.falseType);
				return `${checkType} extends ${extendsType} ? ${trueType} : ${falseType}`;
			case "TSTypeOperator":
				// Handle type operators like readonly, keyof
				const operator = node.operator;
				const typeArg = generateCode(node.typeAnnotation);
				return `${operator} ${typeArg}`;
			case "TSIndexedAccessType":
				// Handle indexed access types: T[K]
				const objectType = generateCode(node.objectType);
				const indexType = generateCode(node.indexType);
				return `${objectType}[${indexType}]`;
			case "TSMappedType":
				// Handle mapped types: { [K in T]: U }
				let mapped = "{";
				if (node.readonly) {
					mapped += node.readonly === "+" ? "readonly " : "-readonly ";
				}
				mapped += "[";
				if (node.typeParameter) {
					mapped += node.typeParameter.name;
					if (node.typeParameter.constraint) {
						mapped += " in " + generateCode(node.typeParameter.constraint);
					}
				}
				mapped += "]";
				if (node.optional) {
					mapped += node.optional === "+" ? "?" : "-?";
				}
				mapped += ": ";
				if (node.typeAnnotation) {
					mapped += generateCode(node.typeAnnotation);
				}
				mapped += "}";
				return mapped;
			case "TSTypePredicate":
				// Handle type predicates: value is Type
				const paramName = node.parameterName ? node.parameterName.name : "value";
				const predicateType = node.typeAnnotation ? generateCode(node.typeAnnotation.typeAnnotation) : "unknown";
				return `${paramName} is ${predicateType}`;
			case "TSParenthesizedType":
				// Handle parenthesized types: (string | number)
				return `(${generateCode(node.typeAnnotation)})`;
			case "TSTypeQuery":
				// Handle typeof operator: typeof someValue
				const exprName = node.exprName;
				if (exprName.type === "Identifier") {
					return `typeof ${exprName.name}`;
				}
				return "typeof unknown";
			case "TSQualifiedName":
				// Handle qualified names like A.B.C
				if (node.left.type === "TSQualifiedName") {
					return generateCode(node.left) + "." + node.right.name;
				} else if (node.left.type === "Identifier") {
					return node.left.name + "." + node.right.name;
				}
				return "unknown";
			case "TSOptionalType":
				// Handle optional types in function parameters
				return generateCode(node.typeAnnotation);
			case "TSRestType":
				// Handle rest types: ...Type[]
				return "..." + generateCode(node.typeAnnotation);
			case "TSNamedTupleMember":
				// Handle named tuple members
				let namedTuple = "";
				if (node.label) {
					namedTuple += node.label.name + ": ";
				}
				namedTuple += generateCode(node.elementType);
				if (node.optional) {
					namedTuple += "?";
				}
				return namedTuple;
			case "TSInferType":
				// Handle infer types: infer T
				return `infer ${node.typeParameter.name}`;
			case "TSImportType":
				// Handle import types: import("module").Type
				let importStr = `import("${node.argument.value}")`;
				if (node.qualifier) {
					// Handle nested qualifiers like import("./types").users.Admin
					if (node.qualifier.type === "TSQualifiedName") {
						// Recursively build the qualified name
						const buildQualifiedName = (qName) => {
							if (qName.left.type === "TSQualifiedName") {
								return buildQualifiedName(qName.left) + "." + qName.right.name;
							} else {
								return qName.left.name + "." + qName.right.name;
							}
						};
						importStr += "." + buildQualifiedName(node.qualifier);
					} else {
						importStr += "." + node.qualifier.name;
					}
				}
				if (node.typeParameters) {
					const typeArgs = node.typeParameters.params.map((param) => generateCode(param)).join(", ");
					importStr += `<${typeArgs}>`;
				}
				return importStr;
			default:
				// Fallback for complex types
				return node.type || "unknown";
		}
	} catch (error) {
		return "unknown";
	}
}

/**
 * Extract function parameter names from AST (legacy compatibility)
 * @param {object} functionNode - The function AST node
 * @returns {Array<string>}
 */
export function extractFunctionParams(functionNode) {
	return extractDetailedParams(functionNode.params).map((param) => param.name);
}
