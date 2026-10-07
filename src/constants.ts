/**
 * Shared, compile-time constants. Every operational limit lives here so the
 * behaviour of the server can be audited (and tuned) from a single place.
 */

export const SERVER_NAME = "ast-navigator-mcp-server";
export const SERVER_VERSION = "1.0.0";

/** Upper bound for the text returned to the model in a single tool response. */
export const CHARACTER_LIMIT = 25_000;

/** Source files larger than this are rejected instead of being parsed. */
export const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024;

/** Hard cap on files visited by a single directory scan (find_definition). */
export const MAX_FILES_SCANNED = 20_000;

/** Maximum directory nesting followed during a scan (protects against pathological trees). */
export const MAX_DIRECTORY_DEPTH = 32;

/** Number of files read from disk concurrently during a directory scan. */
export const READ_CONCURRENCY = 16;

/** Signatures (params + return type) longer than this are truncated. */
export const MAX_SIGNATURE_LENGTH = 240;

/** Number of syntax-error locations reported per file. */
export const MAX_REPORTED_SYNTAX_ERRORS = 10;

/** Largest single JSON-RPC frame accepted on stdin (same default as the official SDK). */
export const MAX_STDIO_FRAME_BYTES = 10 * 1024 * 1024;

/**
 * Hard cap on JSON-RPC bytes queued for stdout. Reached only when the client
 * has stopped reading; `send` then fails fast instead of buffering without end.
 */
export const MAX_OUTBOUND_QUEUE_BYTES = 32 * 1024 * 1024;

/** Queued-byte thresholds at which stdin is paused and resumed again. */
export const OUTBOUND_HIGH_WATER_BYTES = 4 * 1024 * 1024;
export const OUTBOUND_LOW_WATER_BYTES = 1 * 1024 * 1024;

/**
 * Error replies emitted for a run of consecutive invalid frames. Past this,
 * replies are counted but not sent: a malformed-input flood must not be
 * amplified into unbounded output (one short bad line produces a much larger
 * error response). The run resets on the first valid message.
 */
export const MAX_CONSECUTIVE_INVALID_FRAMES = 64;

/** Longest client-supplied request id echoed back in an error reply. */
export const MAX_ECHOED_REQUEST_ID_LENGTH = 256;

/**
 * Directory names never descended into while scanning. Dot-directories
 * (".git", ".next", ".cache", ...) are skipped separately by the walker.
 */
export const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules",
  "bower_components",
  "jspm_packages",
  "dist",
  "build",
  "out",
  "coverage",
  "vendor",
  "tmp",
]);

/** File-name suffixes that are never worth parsing (generated / minified output). */
export const IGNORED_FILE_SUFFIXES: readonly string[] = [".min.js", ".min.mjs", ".min.cjs", ".bundle.js"];
