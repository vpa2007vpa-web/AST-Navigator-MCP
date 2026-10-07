/**
 * Flattens a FileStructure into a list of navigable definitions
 * (classes, methods, functions, interfaces, type aliases, enums).
 */
import type { Definition, FileStructure } from "./model.js";

export function listDefinitions(structure: FileStructure): readonly Definition[] {
  const { filePath } = structure;
  const definitions: Definition[] = [];

  for (const classInfo of structure.classes) {
    definitions.push({
      name: classInfo.name,
      qualifiedName: classInfo.name,
      kind: "class",
      exported: classInfo.exported,
      filePath,
      startLine: classInfo.startLine,
      endLine: classInfo.endLine,
    });
    for (const method of classInfo.methods) {
      definitions.push({
        name: method.name,
        qualifiedName: `${classInfo.name}.${method.name}`,
        kind: "method",
        container: classInfo.name,
        exported: classInfo.exported,
        signature: method.signature,
        filePath,
        startLine: method.startLine,
        endLine: method.endLine,
      });
    }
  }

  for (const fn of structure.functions) {
    definitions.push({
      name: fn.name,
      qualifiedName: fn.name,
      kind: "function",
      exported: fn.exported,
      signature: fn.signature,
      filePath,
      startLine: fn.startLine,
      endLine: fn.endLine,
    });
  }

  for (const typeInfo of structure.types) {
    definitions.push({
      name: typeInfo.name,
      qualifiedName: typeInfo.name,
      kind: typeInfo.kind,
      exported: typeInfo.exported,
      filePath,
      startLine: typeInfo.startLine,
      endLine: typeInfo.endLine,
    });
  }

  return definitions;
}
