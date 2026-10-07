/**
 * Recursive discovery of parseable source files under a directory.
 *
 * Traversal is depth-first in lexicographic order (deterministic results and
 * truncation), never follows symbolic links (no cycles, no sandbox escape) and
 * skips dependency / build / dot directories.
 */
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

import { IGNORED_DIRECTORIES, IGNORED_FILE_SUFFIXES, MAX_DIRECTORY_DEPTH, MAX_FILES_SCANNED } from "../constants.js";
import { isSupportedSourceFile } from "../parser/index.js";

export interface SourceFileScan {
  /** Absolute paths, sorted. */
  readonly files: readonly string[];
  /** True when the scan stopped at the file limit. */
  readonly truncated: boolean;
  /** Sub-directories that could not be listed (permissions, races). */
  readonly unreadableDirectories: number;
}

interface PendingDirectory {
  readonly directory: string;
  readonly depth: number;
}

export function isIgnoredDirectory(name: string): boolean {
  return name.startsWith(".") || IGNORED_DIRECTORIES.has(name);
}

export function isCandidateSourceFile(name: string): boolean {
  const lowerCaseName = name.toLowerCase();
  return isSupportedSourceFile(name) && !IGNORED_FILE_SUFFIXES.some((suffix) => lowerCaseName.endsWith(suffix));
}

const byName = (left: Dirent, right: Dirent): number => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0);

export async function scanSourceFiles(root: string, maxFiles: number = MAX_FILES_SCANNED): Promise<SourceFileScan> {
  const files: string[] = [];
  const stack: PendingDirectory[] = [{ directory: root, depth: 0 }];
  let unreadableDirectories = 0;
  let truncated = false;

  while (stack.length > 0 && !truncated) {
    const current = stack.pop();
    if (current === undefined) {
      break;
    }

    let entries: Dirent[];
    try {
      entries = await readdir(current.directory, { withFileTypes: true });
    } catch {
      unreadableDirectories += 1;
      continue;
    }
    entries.sort(byName);

    const subdirectories: string[] = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const fullPath = path.join(current.directory, entry.name);
      if (entry.isDirectory()) {
        if (!isIgnoredDirectory(entry.name) && current.depth < MAX_DIRECTORY_DEPTH) {
          subdirectories.push(fullPath);
        }
      } else if (entry.isFile() && isCandidateSourceFile(entry.name)) {
        if (files.length >= maxFiles) {
          truncated = true;
          break;
        }
        files.push(fullPath);
      }
    }

    // Reverse push so the stack pops sub-directories in lexicographic order.
    for (let index = subdirectories.length - 1; index >= 0; index -= 1) {
      const directory = subdirectories[index];
      if (directory !== undefined) {
        stack.push({ directory, depth: current.depth + 1 });
      }
    }
  }

  files.sort();
  return { files, truncated, unreadableDirectories };
}
