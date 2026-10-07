/**
 * Markdown renderers: compact, line-oriented outlines that cost the model
 * far fewer tokens than the equivalent JSON.
 */
import type {
  ClassInfo,
  Definition,
  FileStructure,
  FunctionInfo,
  ImportInfo,
  ImportSpecifier,
  MethodInfo,
  PropertyInfo,
  TypeInfo,
} from "../parser/index.js";
import type { FindDefinitionOutput } from "./schemas.js";

function lineRange(startLine: number, endLine: number): string {
  return startLine === endLine ? `L${startLine}` : `L${startLine}-${endLine}`;
}

function count(amount: number, singular: string, plural = `${singular}s`): string {
  return `${amount} ${amount === 1 ? singular : plural}`;
}

function exportPrefix(item: { readonly exported: boolean; readonly defaultExport?: boolean }): string {
  if (item.defaultExport === true) {
    return "export default ";
  }
  return item.exported ? "export " : "";
}

// ---------------------------------------------------------------------------
// get_file_structure
// ---------------------------------------------------------------------------

/** Renders specifiers in source order of kinds: `Default, * as ns, { a, b as c, type T }`. */
function formatSpecifiers(specifiers: readonly ImportSpecifier[]): string {
  const parts: string[] = [];
  const named: string[] = [];
  for (const specifier of specifiers) {
    const typePrefix = specifier.typeOnly === true ? "type " : "";
    switch (specifier.kind) {
      case "default":
        parts.push(`${typePrefix}${specifier.name}`);
        break;
      case "namespace":
        parts.push(specifier.name === "*" ? "*" : `* as ${specifier.name}`);
        break;
      case "named":
        named.push(
          specifier.importedName === undefined
            ? `${typePrefix}${specifier.name}`
            : `${typePrefix}${specifier.importedName} as ${specifier.name}`,
        );
        break;
    }
  }
  if (named.length > 0) {
    parts.push(`{ ${named.join(", ")} }`);
  }
  return parts.join(", ");
}

function formatImport(importInfo: ImportInfo): string {
  const verb = importInfo.kind === "esm" ? "import" : importInfo.kind === "commonjs" ? "require" : "re-export";
  const typeOnly = importInfo.typeOnly ? " type" : "";
  const bindings = importInfo.specifiers.length === 0 ? " (side effect)" : `: ${formatSpecifiers(importInfo.specifiers)}`;
  return `- L${importInfo.line} ${verb}${typeOnly} '${importInfo.source}'${bindings}`;
}

function formatProperty(property: PropertyInfo): string {
  const modifiers = [property.visibility, property.static ? "static" : undefined, property.readonly ? "readonly" : undefined]
    .filter((modifier) => modifier !== undefined)
    .join(" ");
  const type = property.type === undefined ? "" : `: ${property.type}`;
  return `${modifiers.length > 0 ? `${modifiers} ` : ""}${property.name}${type}`;
}

function formatMethod(method: MethodInfo): string {
  const modifiers = [
    method.visibility,
    method.static ? "static" : undefined,
    method.abstract ? "abstract" : undefined,
    method.async ? "async" : undefined,
    method.kind === "getter" ? "get" : method.kind === "setter" ? "set" : undefined,
  ]
    .filter((modifier) => modifier !== undefined)
    .join(" ");
  return `  - ${lineRange(method.startLine, method.endLine)} ${modifiers.length > 0 ? `${modifiers} ` : ""}${method.name}${method.signature}`;
}

function formatClass(classInfo: ClassInfo): string[] {
  const abstract = classInfo.abstract ? "abstract " : "";
  const heritage = [
    classInfo.extends === undefined ? "" : ` extends ${classInfo.extends}`,
    classInfo.implements.length === 0 ? "" : ` implements ${classInfo.implements.join(", ")}`,
  ].join("");
  const lines = [`- ${lineRange(classInfo.startLine, classInfo.endLine)} ${exportPrefix(classInfo)}${abstract}class ${classInfo.name}${heritage}`];
  if (classInfo.properties.length > 0) {
    lines.push(`  - properties: ${classInfo.properties.map(formatProperty).join("; ")}`);
  }
  lines.push(...classInfo.methods.map(formatMethod));
  return lines;
}

function formatFunction(fn: FunctionInfo): string {
  const range = lineRange(fn.startLine, fn.endLine);
  const prefix = exportPrefix(fn);
  const asyncKeyword = fn.async ? "async " : "";
  if (fn.defaultExport && fn.name === "default" && (fn.kind === "arrow" || fn.kind === "function_expression")) {
    // Anonymous `export default function () {}` / `export default () => {}`
    const body = fn.kind === "arrow" ? `${fn.signature} =>` : `function${fn.signature}`;
    return `- ${range} export default ${asyncKeyword}${body}`;
  }
  switch (fn.kind) {
    case "arrow":
      return `- ${range} ${prefix}const ${fn.name} = ${asyncKeyword}${fn.signature} =>`;
    case "function_expression":
      return `- ${range} ${prefix}const ${fn.name} = ${asyncKeyword}function${fn.signature}`;
    case "generator":
      return `- ${range} ${prefix}${asyncKeyword}function* ${fn.name}${fn.signature}`;
    case "signature":
      return `- ${range} ${prefix}declare function ${fn.name}${fn.signature}`;
    case "function":
      return `- ${range} ${prefix}${asyncKeyword}function ${fn.name}${fn.signature}`;
  }
}

function formatType(typeInfo: TypeInfo): string {
  const keyword = typeInfo.kind === "type_alias" ? "type" : typeInfo.kind;
  return `- ${lineRange(typeInfo.startLine, typeInfo.endLine)} ${typeInfo.exported ? "export " : ""}${keyword} ${typeInfo.name}`;
}

export function formatFileStructureMarkdown(structure: FileStructure): string {
  const lines: string[] = [
    `# ${structure.filePath}`,
    [
      structure.language,
      count(structure.lineCount, "line"),
      count(structure.imports.length, "import"),
      count(structure.classes.length, "class", "classes"),
      count(structure.functions.length, "function"),
      count(structure.types.length, "type"),
    ].join(" | "),
  ];

  if (structure.hasSyntaxErrors) {
    const where = structure.syntaxErrorLines.length > 0 ? ` near line(s) ${structure.syntaxErrorLines.join(", ")}` : "";
    lines.push(`Warning: syntax errors${where}; the outline may be incomplete.`);
  }

  const sections: readonly (readonly [string, readonly string[]])[] = [
    ["Imports", structure.imports.map(formatImport)],
    ["Classes", structure.classes.flatMap(formatClass)],
    ["Functions", structure.functions.map(formatFunction)],
    ["Types", structure.types.map(formatType)],
  ];

  let empty = true;
  for (const [title, body] of sections) {
    if (body.length > 0) {
      empty = false;
      lines.push("", `## ${title}`, ...body);
    }
  }
  if (empty) {
    lines.push("", "(no top-level imports or declarations found)");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// find_definition
// ---------------------------------------------------------------------------

function formatDefinition(definition: Definition): string {
  const signature = definition.signature ?? "";
  const exported = definition.exported ? " (exported)" : "";
  return `- [${definition.kind}] ${definition.qualifiedName}${signature}\n  ${definition.filePath}:${lineRange(definition.startLine, definition.endLine)}${exported}`;
}

export function formatFindDefinitionMarkdown(output: FindDefinitionOutput): string {
  const lines: string[] = [`# Definitions of '${output.query}' (${output.matchMode}) in ${output.directory}`];

  if (output.total === 0) {
    lines.push(
      "",
      `No definitions found (${count(output.filesScanned, "file")} scanned, ${count(output.filesParsed, "file")} parsed).`,
      "Try matchMode 'prefix' or 'contains', caseSensitive false, or a broader directory.",
    );
  } else {
    const first = output.offset + 1;
    const last = output.offset + output.count;
    lines.push(
      `Showing ${first}-${last} of ${output.total} | ${count(output.filesScanned, "file")} scanned, ${count(output.filesParsed, "file")} parsed`,
      "",
      ...output.results.map(formatDefinition),
    );
    if (output.count === 0) {
      lines.push(`(offset ${output.offset} is past the last result)`);
    }
  }

  if (output.hasMore && output.nextOffset !== undefined) {
    lines.push("", `More results available: call again with offset=${output.nextOffset}.`);
  }
  if (output.scanTruncated) {
    lines.push("", "Warning: the scan stopped at the file limit; results may be incomplete. Search a narrower directory.");
  }
  if (output.skippedFiles > 0) {
    lines.push("", `Note: ${count(output.skippedFiles, "file")} skipped (unreadable or larger than the size limit).`);
  }
  return lines.join("\n");
}
