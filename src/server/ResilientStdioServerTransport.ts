/**
 * stdio transport hardened against malformed input.
 *
 * Wire format is identical to the SDK's `StdioServerTransport`
 * (newline-delimited JSON-RPC 2.0, one message per line), but the failure
 * behaviour differs where it matters for a long-lived local server:
 *
 *  - Invalid JSON          -> JSON-RPC error -32700 is sent back; the stream continues.
 *  - Valid JSON, not a
 *    JSON-RPC 2.0 message  -> JSON-RPC error -32600 is sent back; the stream continues.
 *  - Oversized frame       -> the frame is discarded up to the next newline and
 *                             -32600 is sent back. The SDK transport *closes the
 *                             connection* in this case, which kills the session.
 *  - Throwing handler      -> reported through `onerror`; the stream continues.
 *
 * Everything the transport retains is bounded, because "keep serving" must not
 * mean "keep allocating". A peer that floods stdin cannot grow our memory:
 *
 *  - the partial frame is capped at `maxFrameBytes` and accumulated as a chunk
 *    list, so re-buffering a split frame costs one copy instead of one per chunk;
 *  - outbound frames go through a single-writer queue with one `drain` listener
 *    at a time, capped at `maxOutboundBytes` - the previous implementation added
 *    a fresh `drain` listener per `send`, so a burst of malformed lines left
 *    hundreds of thousands of listeners and unsettled promises behind;
 *  - stdin is paused while stdout is backed up, so backpressure reaches the peer;
 *  - a run of invalid frames only produces `maxConsecutiveInvalidFrames` error
 *    replies, which stops a short malformed line from being amplified into a
 *    much larger response (and into an equally large stderr log);
 *  - `close` detaches every listener and settles every queued promise.
 */
import process from "node:process";
import type { Readable, Writable } from "node:stream";

import { serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import {
  MAX_CONSECUTIVE_INVALID_FRAMES,
  MAX_ECHOED_REQUEST_ID_LENGTH,
  MAX_OUTBOUND_QUEUE_BYTES,
  MAX_STDIO_FRAME_BYTES,
  OUTBOUND_HIGH_WATER_BYTES,
  OUTBOUND_LOW_WATER_BYTES,
} from "../constants.js";
import { toError } from "../errors.js";

/** JSON-RPC 2.0 reserved error codes. */
const JsonRpcErrorCode = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
} as const;

type JsonRpcErrorCode = (typeof JsonRpcErrorCode)[keyof typeof JsonRpcErrorCode];

type RequestId = string | number;

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const DRAIN = "drain";

interface OutboundFrame {
  readonly frame: Buffer;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

export interface ResilientStdioServerTransportOptions {
  readonly stdin?: Readable;
  readonly stdout?: Writable;
  readonly maxFrameBytes?: number;
  readonly maxOutboundBytes?: number;
  readonly maxConsecutiveInvalidFrames?: number;
}

/**
 * Best-effort extraction of a usable request id from an invalid payload.
 * Long string ids are dropped rather than echoed: the reply must not be a
 * multiplier for whatever the peer put in the field.
 */
function extractRequestId(payload: unknown): RequestId | undefined {
  if (typeof payload !== "object" || payload === null || !("id" in payload)) {
    return undefined;
  }
  const { id } = payload;
  if (typeof id === "string") {
    return id.length <= MAX_ECHOED_REQUEST_ID_LENGTH ? id : undefined;
  }
  return typeof id === "number" && Number.isFinite(id) ? id : undefined;
}

export class ResilientStdioServerTransport implements Transport {
  public onclose?: NonNullable<Transport["onclose"]>;
  public onerror?: NonNullable<Transport["onerror"]>;
  public onmessage?: NonNullable<Transport["onmessage"]>;

  private readonly stdin: Readable;
  private readonly stdout: Writable;
  private readonly maxFrameBytes: number;
  private readonly maxOutboundBytes: number;
  private readonly maxConsecutiveInvalidFrames: number;

  // Inbound framing state: inherently mutable, kept private and minimal.
  private readonly pendingChunks: Buffer[] = [];
  private pendingBytes = 0;
  private discardingOversizedFrame = false;

  // Outbound queue state: exactly one write and one 'drain' listener in flight.
  private readonly outbound: OutboundFrame[] = [];
  private outboundBytes = 0;
  private awaitingDrain = false;
  private pausedForBackpressure = false;

  // Flood control for malformed input.
  private consecutiveInvalidFrames = 0;
  private suppressedInvalidFrames = 0;

  private started = false;
  private closed = false;

  public constructor(options: ResilientStdioServerTransportOptions = {}) {
    this.stdin = options.stdin ?? process.stdin;
    this.stdout = options.stdout ?? process.stdout;
    this.maxFrameBytes = options.maxFrameBytes ?? MAX_STDIO_FRAME_BYTES;
    this.maxOutboundBytes = options.maxOutboundBytes ?? MAX_OUTBOUND_QUEUE_BYTES;
    this.maxConsecutiveInvalidFrames = options.maxConsecutiveInvalidFrames ?? MAX_CONSECUTIVE_INVALID_FRAMES;
  }

  public async start(): Promise<void> {
    if (this.started) {
      throw new Error("ResilientStdioServerTransport already started (McpServer.connect() starts it automatically).");
    }
    this.started = true;
    this.stdin.on("data", this.handleData);
    this.stdin.on("error", this.handleStreamError);
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.stdin.off("data", this.handleData);
    this.stdin.off("error", this.handleStreamError);
    this.stdout.off(DRAIN, this.handleDrain);
    this.awaitingDrain = false;
    this.pausedForBackpressure = false;
    if (this.stdin.listenerCount("data") === 0) {
      this.stdin.pause();
    }
    this.resetFraming();
    this.discardOutbound(new Error("Transport closed before the message reached stdout."));
    this.onclose?.();
  }

  public send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("Cannot send: transport is closed."));
    }
    const frame = Buffer.from(serializeMessage(message), "utf8");
    if (this.outboundBytes + frame.length > this.maxOutboundBytes) {
      return Promise.reject(
        new Error(
          `Cannot send: ${this.outboundBytes} bytes are already queued for stdout (limit ${this.maxOutboundBytes}); the client has stopped reading.`,
        ),
      );
    }
    return new Promise<void>((resolve, reject) => {
      this.outbound.push({ frame, resolve, reject });
      this.outboundBytes += frame.length;
      this.flush();
    });
  }

  // -------------------------------------------------------------------------
  // Outbound
  // -------------------------------------------------------------------------

  /** Writes queued frames until the stream asks us to wait. Never reentrant. */
  private flush(): void {
    while (!this.awaitingDrain && this.outbound.length > 0) {
      const entry = this.outbound.shift();
      if (entry === undefined) {
        break;
      }
      this.outboundBytes -= entry.frame.length;

      let accepted: boolean;
      try {
        accepted = this.stdout.write(entry.frame, (error) => {
          if (error === null || error === undefined) {
            entry.resolve();
          } else {
            entry.reject(toError(error));
          }
        });
      } catch (error) {
        entry.reject(toError(error));
        continue;
      }

      if (!accepted) {
        // One listener, replaced only after it fires: this is the leak that was.
        this.awaitingDrain = true;
        this.stdout.once(DRAIN, this.handleDrain);
      }
    }
    this.applyInputBackpressure();
  }

  private readonly handleDrain = (): void => {
    this.awaitingDrain = false;
    if (!this.closed) {
      this.flush();
    }
  };

  /** Stops reading stdin while stdout is backed up, so the peer feels the pressure. */
  private applyInputBackpressure(): void {
    if (this.closed) {
      return;
    }
    if (!this.pausedForBackpressure && this.outboundBytes > OUTBOUND_HIGH_WATER_BYTES) {
      this.pausedForBackpressure = true;
      this.stdin.pause();
    } else if (this.pausedForBackpressure && this.outboundBytes <= OUTBOUND_LOW_WATER_BYTES) {
      this.pausedForBackpressure = false;
      this.stdin.resume();
    }
  }

  private discardOutbound(reason: Error): void {
    const queued = this.outbound.splice(0, this.outbound.length);
    this.outboundBytes = 0;
    for (const entry of queued) {
      entry.reject(reason);
    }
  }

  // -------------------------------------------------------------------------
  // Inbound
  // -------------------------------------------------------------------------

  private readonly handleStreamError = (error: Error): void => {
    this.onerror?.(error);
  };

  private readonly handleData = (chunk: Buffer | string): void => {
    if (this.closed) {
      return;
    }
    let data = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;

    while (data.length > 0) {
      const newlineIndex = data.indexOf(NEWLINE);

      if (this.discardingOversizedFrame) {
        if (newlineIndex === -1) {
          return; // Still inside the oversized frame: drop it.
        }
        this.discardingOversizedFrame = false;
        data = data.subarray(newlineIndex + 1);
        continue;
      }

      if (newlineIndex === -1) {
        if (this.pendingBytes + data.length > this.maxFrameBytes) {
          this.resetFraming();
          this.discardingOversizedFrame = true;
          this.rejectOversizedFrame();
          return;
        }
        // Copy: the chunk's memory belongs to the stream and must not be retained.
        this.pendingChunks.push(Buffer.from(data));
        this.pendingBytes += data.length;
        return;
      }

      const head = data.subarray(0, newlineIndex);
      data = data.subarray(newlineIndex + 1);

      let frame: Buffer;
      if (this.pendingBytes === 0) {
        frame = head;
      } else {
        // concat copies synchronously, so pushing the borrowed view is safe here.
        this.pendingChunks.push(head);
        frame = Buffer.concat(this.pendingChunks, this.pendingBytes + head.length);
        this.resetFraming();
      }

      if (frame.length > this.maxFrameBytes) {
        this.rejectOversizedFrame();
        continue;
      }
      this.processFrame(frame);
    }
  };

  private resetFraming(): void {
    this.pendingChunks.length = 0;
    this.pendingBytes = 0;
  }

  private processFrame(frame: Buffer): void {
    const body = frame.length > 0 && frame[frame.length - 1] === CARRIAGE_RETURN ? frame.subarray(0, frame.length - 1) : frame;
    if (isBlank(body)) {
      return; // Tolerate blank keep-alive lines; neither valid nor invalid.
    }
    const line = body.toString("utf8");

    let payload: unknown;
    try {
      payload = JSON.parse(line);
    } catch (error) {
      this.rejectFrame(undefined, JsonRpcErrorCode.PARSE_ERROR, "Parse error: message is not valid JSON.", error);
      return;
    }

    const parsed = JSONRPCMessageSchema.safeParse(payload);
    if (!parsed.success) {
      this.rejectFrame(
        extractRequestId(payload),
        JsonRpcErrorCode.INVALID_REQUEST,
        "Invalid Request: message is not a valid JSON-RPC 2.0 request, notification or response.",
      );
      return;
    }

    this.noteValidFrame();
    try {
      this.onmessage?.(parsed.data);
    } catch (error) {
      this.onerror?.(toError(error));
    }
  }

  private rejectOversizedFrame(): void {
    this.rejectFrame(
      undefined,
      JsonRpcErrorCode.INVALID_REQUEST,
      `Invalid Request: message exceeds ${this.maxFrameBytes} bytes and was discarded.`,
    );
  }

  /**
   * Reports a rejected frame locally and answers the peer with a JSON-RPC error,
   * up to the per-run budget. Beyond it the frame is still dropped, but silently:
   * a flood of bad lines must not turn into a flood of replies and log lines.
   */
  private rejectFrame(id: RequestId | undefined, code: JsonRpcErrorCode, message: string, cause?: unknown): void {
    this.consecutiveInvalidFrames += 1;
    if (this.consecutiveInvalidFrames > this.maxConsecutiveInvalidFrames) {
      this.suppressedInvalidFrames += 1;
      if (this.suppressedInvalidFrames === 1) {
        this.onerror?.(
          new Error(
            `Malformed input flood: more than ${this.maxConsecutiveInvalidFrames} consecutive invalid frames. Further error replies are suppressed until a valid message arrives.`,
          ),
        );
      }
      return;
    }

    const error = new Error(message, cause === undefined ? undefined : { cause });
    this.onerror?.(error);

    const response: JSONRPCMessage = {
      jsonrpc: "2.0",
      ...(id === undefined ? {} : { id }),
      error: { code, message },
    };
    this.send(response).catch((sendError: unknown) => {
      this.onerror?.(toError(sendError));
    });
  }

  /** A valid message ends a run of invalid frames and re-arms the budget. */
  private noteValidFrame(): void {
    if (this.suppressedInvalidFrames > 0) {
      const suppressed = this.suppressedInvalidFrames;
      this.suppressedInvalidFrames = 0;
      this.onerror?.(new Error(`Malformed input flood ended: ${suppressed} invalid frames were dropped without a reply.`));
    }
    this.consecutiveInvalidFrames = 0;
  }
}

function isBlank(body: Buffer): boolean {
  for (const byte of body) {
    // Space, tab, LF, CR, VT, FF.
    if (byte !== 0x20 && (byte < 0x09 || byte > 0x0d)) {
      return false;
    }
  }
  return true;
}
