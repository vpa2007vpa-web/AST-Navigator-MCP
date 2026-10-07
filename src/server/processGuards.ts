/**
 * Process-level safety net.
 *
 * Request-level failures are already contained (the SDK turns tool exceptions
 * into `isError` results and the transport rejects malformed frames). These
 * guards cover what escapes that: stray async errors and the lifecycle of the
 * stdio pipes.
 *
 * Policy: keep serving after `uncaughtException` / `unhandledRejection`. The
 * server is stateless and read-only (every tool call re-reads its inputs from
 * disk), so there is no shared state a stray error could leave corrupted, and
 * dying would silently disconnect the client mid-session.
 */
import process from "node:process";

import { isErrnoException } from "../errors.js";
import type { Logger } from "./logger.js";

export type ShutdownHandler = (reason: string) => Promise<void>;

const FORCED_EXIT_TIMEOUT_MS = 3_000;

export function installProcessGuards(logger: Logger, shutdown: ShutdownHandler): void {
  let exiting = false;

  const exitGracefully = (reason: string, exitCode = 0): void => {
    if (exiting) {
      return;
    }
    exiting = true;
    logger.info("Shutting down", { reason });
    // Never hang on a stuck close(): force the exit after a grace period.
    setTimeout(() => process.exit(exitCode), FORCED_EXIT_TIMEOUT_MS).unref();
    shutdown(reason)
      .catch((error: unknown) => logger.error("Error during shutdown", { error }))
      .finally(() => process.exit(exitCode));
  };

  process.on("uncaughtException", (error, origin) => {
    logger.error("Uncaught exception contained; server keeps running", { origin, error });
  });

  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled promise rejection contained; server keeps running", { reason });
  });

  // The client closed our stdout: nobody can receive responses any more.
  process.stdout.on("error", (error) => {
    if (isErrnoException(error) && (error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED")) {
      exitGracefully("stdout closed by client");
      return;
    }
    logger.error("stdout error", { error });
  });

  // The client closed our stdin: the session is over.
  process.stdin.once("end", () => exitGracefully("stdin closed by client"));

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => exitGracefully(`received ${signal}`));
  }
}
