import { readFile } from "node:fs/promises";

export interface TypeDeclaration {
  name: string;
  kind: "class" | "struct" | "enum" | "protocol" | "actor";
  filePath: string;
  line: number;
  referencedTypes: string[];
  inherits: string[];
  properties: PropertyInfo[];
}

export interface PropertyInfo {
  name: string;
  typeName: string;
  isWeak: boolean;
  isOptional: boolean;
  line: number;
}

/**
 * Parse Swift source to extract type declarations and their references.
 * Detects: class, struct, enum, protocol, actor declarations
 * and what types they reference (properties, inheritance, generic constraints).
 */
export function parseTypesFromSource(source: string, filePath: string): TypeDeclaration[] {
  const types: TypeDeclaration[] = [];
  const lines = source.split("\n");

  let inBlockComment = false;
  let currentType: TypeDeclaration | null = null;
  let braceDepth = 0;
  let typeStartDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Handle block comments
    if (inBlockComment) {
      if (line.includes("*/")) {
        inBlockComment = false;
        line = line.substring(line.indexOf("*/") + 2);
      } else {
        continue;
      }
    }
    if (line.includes("/*")) {
      const blockEnd = line.indexOf("*/", line.indexOf("/*") + 2);
      if (blockEnd === -1) {
        inBlockComment = true;
        line = line.substring(0, line.indexOf("/*"));
      } else {
        line = line.substring(0, line.indexOf("/*")) + line.substring(blockEnd + 2);
      }
    }

    // Remove line comments
    const commentIdx = line.indexOf("//");
    if (commentIdx !== -1) {
      line = line.substring(0, commentIdx);
    }

    const trimmed = line.trim();

    // Track brace depth
    for (const ch of line) {
      if (ch === "{") braceDepth++;
      if (ch === "}") braceDepth--;
    }

    // End of current type
    if (currentType && braceDepth < typeStartDepth) {
      types.push(currentType);
      currentType = null;
    }

    // Detect type declarations
    const typeMatch = trimmed.match(
      /^(?:(?:public|internal|private|fileprivate|open|final)\s+)*(?:class|struct|enum|protocol|actor)\s+(\w+)/,
    );

    if (typeMatch && !trimmed.startsWith("func ") && !trimmed.startsWith("var ") && !trimmed.startsWith("let ")) {
      const kind = extractKind(trimmed);
      if (kind) {
        const inherits = extractInheritance(trimmed);

        currentType = {
          name: typeMatch[1],
          kind,
          filePath,
          line: i + 1,
          referencedTypes: [...inherits],
          inherits,
          properties: [],
        };
        typeStartDepth = braceDepth;
      }
    }

    // Detect properties inside current type
    if (currentType && braceDepth > typeStartDepth) {
      const propMatch = trimmed.match(
        /^(?:(?:public|internal|private|fileprivate|open|static|lazy)\s+)*(weak\s+)?(?:var|let)\s+(\w+)\s*:\s*(.+?)(?:\s*[={]|$)/,
      );

      if (propMatch) {
        const isWeak = !!propMatch[1];
        const propName = propMatch[2];
        const typeExpr = propMatch[3].trim();
        const extractedTypes = extractTypesFromExpression(typeExpr);

        const isOptional = typeExpr.includes("?") || typeExpr.startsWith("Optional<");

        currentType.properties.push({
          name: propName,
          typeName: typeExpr,
          isWeak,
          isOptional,
          line: i + 1,
        });

        for (const t of extractedTypes) {
          if (!currentType.referencedTypes.includes(t)) {
            currentType.referencedTypes.push(t);
          }
        }
      }

      // Also check for function parameter types and return types
      const funcMatch = trimmed.match(/^(?:(?:public|internal|private|fileprivate|open|static|override|class)\s+)*func\s+\w+.*?(?:\(([^)]*)\))?.*?(?:->\s*(.+?))?(?:\s*(?:where|{)|$)/);
      if (funcMatch) {
        const params = funcMatch[1] ?? "";
        const returnType = funcMatch[2] ?? "";
        for (const t of extractTypesFromExpression(params)) {
          if (!currentType.referencedTypes.includes(t)) {
            currentType.referencedTypes.push(t);
          }
        }
        for (const t of extractTypesFromExpression(returnType)) {
          if (!currentType.referencedTypes.includes(t)) {
            currentType.referencedTypes.push(t);
          }
        }
      }
    }
  }

  // Don't forget the last type
  if (currentType) {
    types.push(currentType);
  }

  return types;
}

export async function parseTypesFromFile(filePath: string): Promise<TypeDeclaration[]> {
  const source = await readFile(filePath, "utf-8");
  return parseTypesFromSource(source, filePath);
}

function extractKind(line: string): TypeDeclaration["kind"] | null {
  if (/\bclass\s+/.test(line) && !/\bfunc\b/.test(line)) return "class";
  if (/\bstruct\s+/.test(line)) return "struct";
  if (/\benum\s+/.test(line)) return "enum";
  if (/\bprotocol\s+/.test(line)) return "protocol";
  if (/\bactor\s+/.test(line)) return "actor";
  return null;
}

function extractInheritance(line: string): string[] {
  // Match `: TypeA, TypeB` or `: TypeA, TypeB {`
  const match = line.match(/:\s*([^{]+)/);
  if (!match) return [];

  return match[1]
    .split(",")
    .map((s) => s.trim())
    .map((s) => s.replace(/<.*>/, "")) // Remove generic params
    .filter((s) => s.length > 0 && /^[A-Z]/.test(s));
}

/**
 * Extract type names from a type expression.
 * e.g., "Dictionary<String, [MyType]>" → ["Dictionary", "String", "MyType"]
 */
function extractTypesFromExpression(expr: string): string[] {
  const types: string[] = [];
  // Match capitalized identifiers that look like type names
  const matches = expr.matchAll(/\b([A-Z][A-Za-z0-9_]*)\b/g);
  const builtinTypes = new Set([
    "String", "Int", "Double", "Float", "Bool", "Void", "Any", "AnyObject",
    "Array", "Dictionary", "Set", "Optional", "Result", "Error",
    "CGFloat", "CGRect", "CGPoint", "CGSize", "NSObject",
    "Self", "Type", "Protocol", "Never",
  ]);

  for (const match of matches) {
    if (!builtinTypes.has(match[1]) && !types.includes(match[1])) {
      types.push(match[1]);
    }
  }
  return types;
}
