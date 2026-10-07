/**
 * Tree-sitter parser instances.
 *
 * One `Parser` per language is created lazily and reused: creating parsers is
 * cheap but not free, and `setLanguage` on every call would be wasteful.
 * Node.js runs JavaScript on a single thread and `parse` is synchronous, so a
 * shared instance can never be used by two parses at the same time.
 */
import Parser from "tree-sitter";

import { AstNavigatorError, ErrorCode } from "../errors.js";
import { getGrammar } from "./languages.js";
import type { LanguageId } from "./model.js";

export type SyntaxTree = Parser.Tree;
export type SyntaxNode = Parser.SyntaxNode;

const parsers = new Map<LanguageId, Parser>();

function getParser(language: LanguageId): Parser {
  const cached = parsers.get(language);
  if (cached !== undefined) {
    return cached;
  }
  const parser = new Parser();
  parser.setLanguage(getGrammar(language));
  parsers.set(language, parser);
  return parser;
}

/**
 * Parses source text into a concrete syntax tree. Tree-sitter is error
 * tolerant: invalid code still yields a tree containing ERROR nodes, so this
 * only throws if the native parser itself fails.
 */
export function parseSource(source: string, language: LanguageId, filePath: string): SyntaxTree {
  try {
    return getParser(language).parse(source);
  } catch (error) {
    throw new AstNavigatorError(ErrorCode.PARSE_FAILED, `Tree-sitter failed to parse ${filePath}.`, {
      hint: "The file may be binary or use an encoding other than UTF-8.",
      cause: error,
    });
  }
}
