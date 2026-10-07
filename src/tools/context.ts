import type { Logger } from "../server/logger.js";
import type { PathPolicy } from "./pathPolicy.js";

/** Dependencies injected into every tool (keeps tools free of global state). */
export interface ToolContext {
  readonly pathPolicy: PathPolicy;
  readonly logger: Logger;
}
