/**
 * Composition root of the MCP server: owns the `McpServer`, wires the tools
 * and manages the stdio connection lifecycle.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { SERVER_NAME, SERVER_VERSION } from "../constants.js";
import { PathPolicy, registerTools } from "../tools/index.js";
import type { ServerConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { ResilientStdioServerTransport } from "./ResilientStdioServerTransport.js";

const SERVER_INSTRUCTIONS = `AST Navigator exposes the Tree-sitter syntax tree of local JavaScript/TypeScript code.
Typical workflow: find_definition to locate where a class/function/method/type is declared,
then get_file_structure on the returned filePath to see the file's imports and declarations with line ranges,
then read only the lines you need. Both tools are read-only.`;

export class AstNavigatorServer {
  private readonly mcp: McpServer;
  private readonly logger: Logger;
  private readonly config: ServerConfig;
  private connected = false;

  public constructor(config: ServerConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.mcp = new McpServer(
      { name: SERVER_NAME, version: SERVER_VERSION },
      { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
    );

    // Protocol-level problems (malformed frames, unknown messages, handler
    // crashes) surface here. They are logged and the session stays alive.
    this.mcp.server.onerror = (error: Error): void => {
      this.logger.warn("Protocol error contained; server keeps running", { error: error.message });
    };
    this.mcp.server.onclose = (): void => {
      this.logger.info("MCP connection closed");
    };

    registerTools(this.mcp, {
      pathPolicy: new PathPolicy(config.allowedRoots),
      logger: logger.child("tools"),
    });
  }

  public async start(): Promise<void> {
    await this.mcp.connect(new ResilientStdioServerTransport());
    this.connected = true;
    this.logger.info(`${SERVER_NAME} ${SERVER_VERSION} listening on stdio`, {
      allowedRoots: this.config.allowedRoots.length > 0 ? this.config.allowedRoots : "unrestricted",
    });
  }

  public async close(): Promise<void> {
    if (!this.connected) {
      return;
    }
    this.connected = false;
    await this.mcp.close();
  }
}
