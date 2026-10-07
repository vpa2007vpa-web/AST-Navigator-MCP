/**
 * stderr-only structured logger.
 *
 * With the stdio transport, stdout is the JSON-RPC channel: a single stray
 * byte written there corrupts the protocol stream. Every diagnostic therefore
 * goes to stderr, which MCP clients surface as server logs.
 */
import { Console } from "node:console";
import process from "node:process";
import { inspect } from "node:util";

import { z } from "zod";

/** The log level comes from the environment (external input), so it is validated like any other. */
const LogLevelSchema = z.enum(["debug", "info", "warn", "error"]);

export type LogLevel = z.infer<typeof LogLevelSchema>;

export type LogContext = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  child(scope: string): Logger;
}

const LEVEL_WEIGHT: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export const LOG_LEVEL_ENV_VAR = "AST_NAVIGATOR_LOG_LEVEL";

/** Unknown or missing values fall back to "info" instead of failing startup. */
export function resolveLogLevel(raw: string | undefined): LogLevel {
  return LogLevelSchema.catch("info").parse(raw?.trim().toLowerCase());
}

/** Makes `Error` instances (which have non-enumerable fields) serialisable. */
function serialiseContextValue(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  return value;
}

function formatContext(context: LogContext | undefined): string {
  if (context === undefined || Object.keys(context).length === 0) {
    return "";
  }
  try {
    return ` ${JSON.stringify(context, serialiseContextValue)}`;
  } catch {
    // Circular structures and other exotic values: fall back to util.inspect.
    return ` ${inspect(context, { depth: 4, breakLength: Infinity })}`;
  }
}

class StderrLogger implements Logger {
  private readonly scope: string;
  private readonly threshold: number;
  private readonly level: LogLevel;

  public constructor(scope: string, level: LogLevel) {
    this.scope = scope;
    this.level = level;
    this.threshold = LEVEL_WEIGHT[level];
  }

  public debug(message: string, context?: LogContext): void {
    this.write("debug", message, context);
  }

  public info(message: string, context?: LogContext): void {
    this.write("info", message, context);
  }

  public warn(message: string, context?: LogContext): void {
    this.write("warn", message, context);
  }

  public error(message: string, context?: LogContext): void {
    this.write("error", message, context);
  }

  public child(scope: string): Logger {
    return new StderrLogger(`${this.scope}:${scope}`, this.level);
  }

  private write(level: LogLevel, message: string, context: LogContext | undefined): void {
    if (LEVEL_WEIGHT[level] < this.threshold) {
      return;
    }
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${this.scope}] ${message}${formatContext(context)}\n`;
    try {
      process.stderr.write(line);
    } catch {
      // stderr is gone (parent died): nothing sensible left to do with a log line.
    }
  }
}

export function createLogger(scope: string, level: LogLevel = resolveLogLevel(process.env[LOG_LEVEL_ENV_VAR])): Logger {
  return new StderrLogger(scope, level);
}

/**
 * Defensive measure: replaces the global console with one bound to stderr on
 * both streams, so an accidental `console.log` (ours or a dependency's) can
 * never corrupt the JSON-RPC stream on stdout.
 */
export function redirectConsoleToStderr(): void {
  globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
}
