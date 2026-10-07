/**
 * Uniform construction of tool results (success and error).
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { CHARACTER_LIMIT } from "../constants.js";
import { AstNavigatorError, toError } from "../errors.js";
import type { Logger } from "../server/logger.js";

export function enforceCharacterLimit(text: string, limit: number = CHARACTER_LIMIT): string {
  if (text.length <= limit) {
    return text;
  }
  const notice =
    `\n\n[Truncated at ${limit} characters. structuredContent still holds the complete result. ` +
    "Narrow the request (smaller 'limit', a 'kinds' filter, a more specific name or directory) to read the rest.]";
  return `${text.slice(0, limit - notice.length)}${notice}`;
}

/** Text for the model + machine-readable `structuredContent` matching the tool's outputSchema. */
export function successResult(text: string, structuredContent: Readonly<Record<string, unknown>>): CallToolResult {
  return {
    content: [{ type: "text", text: enforceCharacterLimit(text) }],
    structuredContent: { ...structuredContent },
  };
}

/**
 * Expected failures become an actionable message (`Error [CODE]: ...` +
 * `Hint: ...`). Unexpected ones are logged with their stack to stderr and
 * reported generically. Either way the server keeps running.
 */
export function errorResult(error: unknown, logger: Logger): CallToolResult {
  if (error instanceof AstNavigatorError) {
    logger.debug("Tool call failed with an expected error", { code: error.code, message: error.message });
    const text = error.hint === undefined ? `Error [${error.code}]: ${error.message}` : `Error [${error.code}]: ${error.message}\nHint: ${error.hint}`;
    return { isError: true, content: [{ type: "text", text }] };
  }

  const unexpected = toError(error);
  logger.error("Tool call failed with an unexpected error", { error: unexpected });
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `Error [INTERNAL_ERROR]: ${unexpected.message}\nHint: Unexpected server failure; details were written to the server log (stderr). Retrying with different input may help.`,
      },
    ],
  };
}
