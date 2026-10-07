/**
 * Module references of one file: every place where it names another module.
 *
 * Unlike the structure outline, which stops at the module's top level, this
 * walks the *whole* tree: a `require` inside a function or a lazy `import()`
 * loads a module just the same, so it is a dependency just the same.
 *
 * Only the syntax is examined here; deciding which specifiers are local files
 * (and where they live) is the tool layer's job, because it needs the sandbox.
 */
import type { LanguageId } from "./model.js";
import { hasKeyword, stringLiteralValue } from "./structureExtractor.js";
import type { SyntaxNode, SyntaxTree } from "./treeSitterParser.js";

export const MODULE_REFERENCE_KINDS = ["import", "re-export", "require", "dynamic-import"] as const;
export type ModuleReferenceKind = (typeof MODULE_REFERENCE_KINDS)[number];

export interface ModuleReference {
  /** The module specifier exactly as written, e.g. "./util.js" or "node:fs". */
  readonly specifier: string;
  readonly kind: ModuleReferenceKind;
  /** `import type` / `export type ... from`: erased at compile time, never loaded at runtime. */
  readonly typeOnly: boolean;
  /** 1-based line of the statement or call. */
  readonly line: number;
}

export interface ModuleReferenceScan {
  /** In source order. */
  readonly references: readonly ModuleReference[];
  /** `require(x)` / `import(\`./${x}\`)` calls whose target is computed and cannot be followed statically. */
  readonly nonLiteralCount: number;
  readonly hasSyntaxErrors: boolean;
}

export interface ModuleReferenceFile extends ModuleReferenceScan {
  readonly filePath: string;
  readonly language: LanguageId;
}

const REFERENCE_NODE_TYPES = ["import_statement", "export_statement", "call_expression"];

/** `require(...)` and `import(...)` calls; any other call is not a module load. */
function loaderKind(call: SyntaxNode): ModuleReferenceKind | undefined {
  const callee = call.childForFieldName("function");
  if (callee?.type === "import") {
    return "dynamic-import";
  }
  return callee?.type === "identifier" && callee.text === "require" ? "require" : undefined;
}

export function listModuleReferences(tree: SyntaxTree): ModuleReferenceScan {
  const references: ModuleReference[] = [];
  let nonLiteralCount = 0;

  // descendantsOfType walks the tree natively and yields nodes in document order.
  for (const node of tree.rootNode.descendantsOfType(REFERENCE_NODE_TYPES)) {
    const line = node.startPosition.row + 1;

    switch (node.type) {
      case "import_statement": {
        // TypeScript `import x = require("y")` is a CommonJS load, not an ES import.
        const requireClause = node.namedChildren.find((child) => child.type === "import_require_clause");
        const specifier = stringLiteralValue((requireClause ?? node).childForFieldName("source"));
        if (specifier !== undefined) {
          references.push(
            requireClause === undefined
              ? { specifier, kind: "import", typeOnly: hasKeyword(node, "type"), line }
              : { specifier, kind: "require", typeOnly: false, line },
          );
        }
        break;
      }
      case "export_statement": {
        // Only `export ... from "x"` names a module; local exports have no source.
        const specifier = stringLiteralValue(node.childForFieldName("source"));
        if (specifier !== undefined) {
          references.push({ specifier, kind: "re-export", typeOnly: hasKeyword(node, "type"), line });
        }
        break;
      }
      case "call_expression": {
        const kind = loaderKind(node);
        if (kind === undefined) {
          break;
        }
        const specifier = stringLiteralValue(node.childForFieldName("arguments")?.namedChildren[0]);
        if (specifier === undefined) {
          nonLiteralCount += 1;
        } else {
          references.push({ specifier, kind, typeOnly: false, line });
        }
        break;
      }
    }
  }

  return { references, nonLiteralCount, hasSyntaxErrors: tree.rootNode.hasError };
}
