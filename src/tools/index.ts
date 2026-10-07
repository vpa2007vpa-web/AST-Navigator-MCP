import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ToolContext } from "./context.js";
import { registerFindDefinitionTool } from "./findDefinition.js";
import { registerGetFileStructureTool } from "./getFileStructure.js";

export type { ToolContext } from "./context.js";
export { PathPolicy } from "./pathPolicy.js";

/** Single place where the server's tool surface is assembled. */
export function registerTools(server: McpServer, context: ToolContext): void {
  registerGetFileStructureTool(server, context);
  registerFindDefinitionTool(server, context);
}
