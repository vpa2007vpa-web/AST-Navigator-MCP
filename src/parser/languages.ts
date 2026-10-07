/**
 * Registry of supported grammars, keyed by file extension.
 * Adding a language = installing its tree-sitter grammar and adding one entry.
 */
import path from "node:path";

import type Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import TypeScript from "tree-sitter-typescript";

import type { LanguageId } from "./model.js";

interface LanguageDefinition {
  readonly id: LanguageId;
  readonly grammar: Parser.Language;
  readonly extensions: readonly string[];
}

const LANGUAGE_DEFINITIONS: readonly LanguageDefinition[] = [
  // tree-sitter-javascript also covers JSX.
  { id: "javascript", grammar: JavaScript, extensions: [".js", ".mjs", ".cjs", ".jsx"] },
  // `.d.ts`, `.d.mts`, ... resolve through their final extension.
  { id: "typescript", grammar: TypeScript.typescript, extensions: [".ts", ".mts", ".cts"] },
  { id: "tsx", grammar: TypeScript.tsx, extensions: [".tsx"] },
];

const LANGUAGE_BY_EXTENSION: ReadonlyMap<string, LanguageDefinition> = new Map(
  LANGUAGE_DEFINITIONS.flatMap((definition) => definition.extensions.map((extension) => [extension, definition] as const)),
);

const GRAMMAR_BY_ID: ReadonlyMap<LanguageId, Parser.Language> = new Map(
  LANGUAGE_DEFINITIONS.map((definition) => [definition.id, definition.grammar] as const),
);

export const SUPPORTED_EXTENSIONS: readonly string[] = [...LANGUAGE_BY_EXTENSION.keys()];

export function detectLanguage(filePath: string): LanguageId | undefined {
  return LANGUAGE_BY_EXTENSION.get(path.extname(filePath).toLowerCase())?.id;
}

export function isSupportedSourceFile(filePath: string): boolean {
  return detectLanguage(filePath) !== undefined;
}

export function getGrammar(language: LanguageId): Parser.Language {
  const grammar = GRAMMAR_BY_ID.get(language);
  if (grammar === undefined) {
    // Unreachable while LanguageId and LANGUAGE_DEFINITIONS stay in sync.
    throw new Error(`No grammar registered for language '${language}'.`);
  }
  return grammar;
}
