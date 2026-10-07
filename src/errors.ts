/**
 * Domain errors shared by the parser and tool layers.
 *
 * Every expected failure is an `AstNavigatorError` carrying a stable machine
 * readable `code` plus an actionable `hint` for the calling model. Anything
 * else reaching the tool boundary is treated as an internal error.
 */

export const ErrorCode = {
  FILE_NOT_FOUND: "FILE_NOT_FOUND",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  NOT_A_FILE: "NOT_A_FILE",
  NOT_A_DIRECTORY: "NOT_A_DIRECTORY",
  FILE_TOO_LARGE: "FILE_TOO_LARGE",
  UNSUPPORTED_LANGUAGE: "UNSUPPORTED_LANGUAGE",
  PATH_OUTSIDE_ROOTS: "PATH_OUTSIDE_ROOTS",
  INVALID_PATH: "INVALID_PATH",
  MISSING_DIRECTORY: "MISSING_DIRECTORY",
  READ_FAILED: "READ_FAILED",
  PARSE_FAILED: "PARSE_FAILED",
  INVALID_CONFIGURATION: "INVALID_CONFIGURATION",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface AstNavigatorErrorOptions {
  readonly hint?: string;
  readonly cause?: unknown;
}

export class AstNavigatorError extends Error {
  public readonly code: ErrorCode;
  public readonly hint: string | undefined;

  public constructor(code: ErrorCode, message: string, options: AstNavigatorErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AstNavigatorError";
    this.code = code;
    this.hint = options.hint;
  }
}

/** Type guard for Node.js system errors (`fs`, `net`, ...), which expose a string `code`. */
export function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string";
}

/** Normalises any thrown value into an `Error` instance. */
export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
