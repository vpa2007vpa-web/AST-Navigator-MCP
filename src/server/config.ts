/**
 * Command-line configuration.
 *
 * Usage: ast-navigator-mcp-server [--help] [--version] [allowedRoot ...]
 *
 * Positional arguments are optional "allowed roots": when present, every path
 * received through a tool call must resolve (after following symlinks) inside
 * one of them. Without roots the server can read any path the OS user can.
 */
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { SERVER_NAME, SERVER_VERSION } from "../constants.js";
import { AstNavigatorError, ErrorCode, isErrnoException } from "../errors.js";
import { LOG_LEVEL_ENV_VAR } from "./logger.js";

export interface ServerConfig {
  /** Canonical (realpath) absolute directories. Empty means "unrestricted". */
  readonly allowedRoots: readonly string[];
}

export type CliCommand =
  | { readonly kind: "run"; readonly config: ServerConfig }
  | { readonly kind: "print"; readonly text: string };

export const USAGE = `${SERVER_NAME} ${SERVER_VERSION}

MCP server (stdio transport) that exposes the Tree-sitter AST of local
JavaScript / TypeScript code to language models.

Usage:
  node dist/index.js [allowedRoot ...]

Arguments:
  allowedRoot   Optional directories the server is allowed to read. When at
                least one is given, any path outside them is rejected and
                relative paths are resolved against the first root.

Options:
  -h, --help     Show this help and exit.
  -v, --version  Show the version and exit.

Environment:
  ${LOG_LEVEL_ENV_VAR}  debug | info | warn | error (default: info). Logs go to stderr.
`;

/** Positional CLI arguments are external input too: validated before touching the filesystem. */
const AllowedRootsSchema = z.array(
  z
    .string()
    .trim()
    .min(1, "Allowed root must not be empty.")
    .refine((value) => !value.includes("\0"), "Allowed root must not contain NUL characters."),
);

async function canonicaliseRoot(rawRoot: string): Promise<string> {
  const absolute = path.resolve(rawRoot);
  try {
    const canonical = await realpath(absolute);
    const stats = await stat(canonical);
    if (!stats.isDirectory()) {
      throw new AstNavigatorError(ErrorCode.INVALID_CONFIGURATION, `Allowed root is not a directory: ${absolute}`);
    }
    return canonical;
  } catch (error) {
    if (error instanceof AstNavigatorError) {
      throw error;
    }
    const reason = isErrnoException(error) ? error.code : String(error);
    throw new AstNavigatorError(ErrorCode.INVALID_CONFIGURATION, `Allowed root is not accessible: ${absolute} (${reason})`, {
      cause: error,
    });
  }
}

export async function parseCommandLine(argv: readonly string[]): Promise<CliCommand> {
  if (argv.includes("--help") || argv.includes("-h")) {
    return { kind: "print", text: USAGE };
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    return { kind: "print", text: `${SERVER_VERSION}\n` };
  }

  const unknownFlag = argv.find((argument) => argument.startsWith("-"));
  if (unknownFlag !== undefined) {
    throw new AstNavigatorError(ErrorCode.INVALID_CONFIGURATION, `Unknown option: ${unknownFlag}. Run with --help for usage.`);
  }

  const parsedRoots = AllowedRootsSchema.safeParse(argv);
  if (!parsedRoots.success) {
    const reason = parsedRoots.error.issues.map((issue) => issue.message).join(" ");
    throw new AstNavigatorError(ErrorCode.INVALID_CONFIGURATION, `Invalid allowed root argument: ${reason}`);
  }

  const canonicalRoots = await Promise.all(parsedRoots.data.map(canonicaliseRoot));
  const allowedRoots = [...new Set(canonicalRoots)];
  return { kind: "run", config: { allowedRoots } };
}
