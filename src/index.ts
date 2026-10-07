#!/usr/bin/env node
/**
 * Entry point of AST-Navigator-MCP.
 *
 * stdout is reserved for JSON-RPC traffic; every log line goes to stderr.
 */
import process from "node:process";

import { AstNavigatorError } from "./errors.js";
import { AstNavigatorServer } from "./server/AstNavigatorServer.js";
import { parseCommandLine } from "./server/config.js";
import { createLogger, redirectConsoleToStderr } from "./server/logger.js";
import { installProcessGuards } from "./server/processGuards.js";

redirectConsoleToStderr();

const logger = createLogger("ast-navigator");

async function main(): Promise<void> {
  const command = await parseCommandLine(process.argv.slice(2));
  if (command.kind === "print") {
    // --help / --version: printed to stderr so stdout stays protocol-only even here.
    process.stderr.write(command.text);
    return;
  }

  const server = new AstNavigatorServer(command.config, logger);
  installProcessGuards(logger, () => server.close());
  await server.start();
}

main().catch((error: unknown) => {
  if (error instanceof AstNavigatorError) {
    logger.error(`Startup failed: ${error.message}`, { code: error.code });
  } else {
    logger.error("Startup failed", { error });
  }
  process.exitCode = 1;
});
