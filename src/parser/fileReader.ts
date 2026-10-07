/**
 * Safe access to local source files, translating OS-level failures into
 * typed, actionable `AstNavigatorError`s.
 */
import { constants as fsConstants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

import { MAX_FILE_SIZE_BYTES } from "../constants.js";
import { AstNavigatorError, ErrorCode, isErrnoException } from "../errors.js";

export interface SourceFile {
  readonly absolutePath: string;
  readonly content: string;
  readonly sizeBytes: number;
}

export interface ReadSourceFileOptions {
  readonly maxBytes?: number;
  /**
   * Refuse to follow a symbolic link at the final path component. Used when the
   * caller has already canonicalised the path, so a link appearing there can
   * only be a swap performed after that check (POSIX only; no-op on Windows,
   * which has no O_NOFOLLOW).
   */
  readonly denySymlinks?: boolean;
}

const UTF8_BOM = "﻿";

// Not defined on Windows; 0 makes the bitwise OR a no-op there.
const O_NOFOLLOW: number = fsConstants.O_NOFOLLOW ?? 0;

/** Maps a Node.js fs error to a domain error with a hint for the model. */
export function toFileAccessError(error: unknown, filePath: string): AstNavigatorError {
  if (error instanceof AstNavigatorError) {
    return error;
  }
  if (!isErrnoException(error)) {
    return new AstNavigatorError(ErrorCode.READ_FAILED, `Could not read ${filePath}: ${String(error)}`, { cause: error });
  }
  switch (error.code) {
    case "ENOENT":
    case "ENOTDIR":
      return new AstNavigatorError(ErrorCode.FILE_NOT_FOUND, `Path does not exist: ${filePath}`, {
        hint: "Check the spelling and use an absolute path. find_definition can locate files that declare a given symbol.",
        cause: error,
      });
    case "EACCES":
    case "EPERM":
      return new AstNavigatorError(ErrorCode.PERMISSION_DENIED, `Permission denied reading: ${filePath}`, {
        hint: "The OS user running the MCP server cannot read this path.",
        cause: error,
      });
    case "EISDIR":
      return new AstNavigatorError(ErrorCode.NOT_A_FILE, `Expected a file but got a directory: ${filePath}`, {
        hint: "Use find_definition to search a directory.",
        cause: error,
      });
    case "ELOOP":
      return new AstNavigatorError(ErrorCode.READ_FAILED, `Refused to follow a symbolic link while resolving: ${filePath}`, {
        hint: "The path became a symbolic link after it was validated, or the links form a cycle.",
        cause: error,
      });
    case "EMFILE":
    case "ENFILE":
      return new AstNavigatorError(ErrorCode.READ_FAILED, `Too many open files while reading: ${filePath}`, {
        hint: "Transient OS limit; retry the call.",
        cause: error,
      });
    default:
      return new AstNavigatorError(ErrorCode.READ_FAILED, `Could not read ${filePath} (${error.code ?? "unknown error"}).`, {
        cause: error,
      });
  }
}

/**
 * Reads a source file through a single file handle.
 *
 * Opening once and then using `fstat` on the handle - rather than `stat(path)`
 * followed by `readFile(path)` - means the kind/size checks and the read apply
 * to the same inode: the path cannot be re-pointed between the two. The size is
 * re-checked against the bytes actually decoded, so a file that grows during
 * the read is rejected instead of silently exceeding the limit.
 */
export async function readSourceFile(absolutePath: string, options: ReadSourceFileOptions = {}): Promise<SourceFile> {
  const maxBytes = options.maxBytes ?? MAX_FILE_SIZE_BYTES;
  const flags = fsConstants.O_RDONLY | (options.denySymlinks === true ? O_NOFOLLOW : 0);

  let handle: FileHandle | undefined;
  try {
    handle = await open(absolutePath, flags);
    const stats = await handle.stat();
    if (stats.isDirectory()) {
      throw new AstNavigatorError(ErrorCode.NOT_A_FILE, `Expected a file but got a directory: ${absolutePath}`, {
        hint: "Use find_definition to search a directory.",
      });
    }
    if (!stats.isFile()) {
      throw new AstNavigatorError(ErrorCode.NOT_A_FILE, `Not a regular file: ${absolutePath}`);
    }
    if (stats.size > maxBytes) {
      throw tooLargeError(absolutePath, stats.size, maxBytes);
    }

    const raw = await handle.readFile("utf8");
    const sizeBytes = Buffer.byteLength(raw, "utf8");
    if (sizeBytes > maxBytes) {
      throw tooLargeError(absolutePath, sizeBytes, maxBytes);
    }
    const content = raw.startsWith(UTF8_BOM) ? raw.slice(UTF8_BOM.length) : raw;
    return { absolutePath, content, sizeBytes };
  } catch (error) {
    throw toFileAccessError(error, absolutePath);
  } finally {
    // A failed close must not mask the original error.
    await handle?.close().catch(() => undefined);
  }
}

function tooLargeError(absolutePath: string, sizeBytes: number, maxBytes: number): AstNavigatorError {
  return new AstNavigatorError(ErrorCode.FILE_TOO_LARGE, `File is ${sizeBytes} bytes; the limit is ${maxBytes} bytes: ${absolutePath}`, {
    hint: "Very large files are usually generated or bundled code and are not worth outlining.",
  });
}
