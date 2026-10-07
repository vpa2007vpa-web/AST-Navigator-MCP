/**
 * Resolves user-supplied paths and enforces the optional allowed-roots sandbox.
 *
 * A restricted path has to clear two checks:
 *
 *  1. *lexical* containment of the normalised absolute path, computed without
 *     touching the filesystem at all;
 *  2. *canonical* containment of its realpath, so a symlink inside a root can
 *     never be used to step outside it.
 *
 * Check 2 is the authority on whether a path is allowed (a root that is itself
 * reached through a symlink keeps working, because a canonical path inside a
 * root is accepted even when check 1 failed). Check 1 decides what we are
 * allowed to *say* about a rejected path: anything that is not lexically
 * contained can only ever produce PATH_OUTSIDE_ROOTS, so the filesystem error
 * codes (FILE_NOT_FOUND / PERMISSION_DENIED) cannot be used as an existence
 * oracle for the parts of the disk the sandbox is meant to hide.
 */
import { realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { AstNavigatorError, ErrorCode } from "../errors.js";
import { toFileAccessError } from "../parser/index.js";

function isWithin(root: string, target: string): boolean {
  if (root.length === 0) {
    return false;
  }
  // path.relative is case-insensitive on Windows and yields an absolute path across drives.
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export class PathPolicy {
  private readonly roots: readonly string[];

  /** @param roots canonical absolute directories (see server/config.ts); empty = unrestricted. */
  public constructor(roots: readonly string[]) {
    this.roots = Object.freeze([...roots]);
  }

  public get allowedRoots(): readonly string[] {
    return this.roots;
  }

  public get isRestricted(): boolean {
    return this.roots.length > 0;
  }

  /** Directory used when a tool call omits one. */
  public get defaultDirectory(): string | undefined {
    return this.roots[0];
  }

  /** Absolute, normalised path. Relative input resolves against the first root, else the process cwd. */
  public toAbsolute(input: string): string {
    // Defence in depth: the tool schemas reject these, but this class is the
    // security boundary and must not depend on its callers having validated.
    if (input.includes("\0")) {
      throw new AstNavigatorError(ErrorCode.INVALID_PATH, "Path must not contain NUL characters.");
    }
    if (input.trim().length === 0) {
      throw new AstNavigatorError(ErrorCode.INVALID_PATH, "Path must not be empty.");
    }
    return path.isAbsolute(input) ? path.normalize(input) : path.resolve(this.roots[0] ?? process.cwd(), input);
  }

  /**
   * Returns the path to operate on, or throws:
   *  - INVALID_PATH when the input is not a usable path at all;
   *  - FILE_NOT_FOUND / PERMISSION_DENIED when a path *inside* the sandbox cannot be canonicalised;
   *  - PATH_OUTSIDE_ROOTS for everything outside it, whether or not it exists.
   */
  public async resolve(input: string): Promise<string> {
    const absolute = this.toAbsolute(input);
    if (!this.isRestricted) {
      return absolute;
    }

    const lexicallyContained = this.contains(absolute);

    let canonical: string;
    try {
      canonical = await realpath(absolute);
    } catch (error) {
      // Outside the sandbox: never disclose *why* resolution failed, or the
      // error code tells the caller which paths exist out there.
      throw lexicallyContained ? toFileAccessError(error, absolute) : this.outsideRootsError(absolute);
    }

    if (!this.contains(canonical)) {
      throw this.outsideRootsError(absolute);
    }
    return canonical;
  }

  /** True when `target` is lexically inside one of the roots. No filesystem access. */
  public contains(target: string): boolean {
    return this.roots.some((root) => isWithin(root, target));
  }

  private outsideRootsError(requested: string): AstNavigatorError {
    return new AstNavigatorError(ErrorCode.PATH_OUTSIDE_ROOTS, `Path is outside the allowed roots: ${requested}`, {
      hint: `This server may only read inside: ${this.roots.join(", ")}.`,
    });
  }
}
