/**
 * Regression tests for ResilientStdioServerTransport: framing edge cases and
 * the memory bounds that keep a malformed-input flood from growing the heap.
 *
 * The transport is driven in-process through fake streams, which makes the
 * failure modes (a client that stops reading, a frame split byte by byte)
 * deterministic. One test at the end repeats the flood against the real
 * server process.
 */
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { describe, test } from "node:test";
import v8 from "node:v8";
import vm from "node:vm";

import {
  MAX_CONSECUTIVE_INVALID_FRAMES,
  MAX_ECHOED_REQUEST_ID_LENGTH,
} from "../dist/constants.js";
import { ResilientStdioServerTransport } from "../dist/server/ResilientStdioServerTransport.js";
import { INITIALIZE_REQUEST, spawnRawServer, tick } from "./helpers.mjs";

// Lets the heap test measure *retained* memory instead of garbage awaiting collection.
v8.setFlagsFromString("--expose-gc");
const collectGarbage = vm.runInNewContext("gc");

// ---------------------------------------------------------------------------
// Fake streams
// ---------------------------------------------------------------------------

/** A stdout that acknowledges every write immediately and records what it got. */
function collectingStdout() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  const messages = () =>
    Buffer.concat(chunks)
      .toString("utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
  return { stream, messages };
}

/** A stdout whose reader has stopped: it takes one write and never acknowledges it. */
function stalledStdout() {
  return new Writable({ highWaterMark: 1, write() {} });
}

/** A stdout whose write acknowledgements are released by the test. */
class ManualStdout extends Writable {
  constructor() {
    super({ highWaterMark: 1024 });
    this.pendingCallback = undefined;
    this.receivedBytes = 0;
  }

  _write(chunk, _encoding, callback) {
    this.receivedBytes += chunk.length;
    this.pendingCallback = callback;
  }

  /** Acknowledges writes one by one until nothing is buffered or in flight. */
  async drainAll() {
    for (let round = 0; this.pendingCallback !== undefined || this.writableLength > 0; round += 1) {
      assert.ok(round < 10_000, "stdout never drained");
      const callback = this.pendingCallback;
      this.pendingCallback = undefined;
      callback?.();
      await tick();
    }
  }
}

function createHarness(stdout, options = {}) {
  const stdin = new PassThrough();
  const transport = new ResilientStdioServerTransport({ stdin, stdout, ...options });
  const messages = [];
  const errors = [];
  transport.onmessage = (message) => messages.push(message);
  transport.onerror = (error) => errors.push(error.message);
  return { stdin, transport, messages, errors };
}

const frame = (payload) => `${JSON.stringify(payload)}\n`;
const ping = (id = 1) => frame({ jsonrpc: "2.0", id, method: "ping" });

/**
 * Fails fast when a send() promise never settles. A transport that leaks its
 * pending promises would otherwise hang the suite instead of failing it.
 */
function settlesWithin(promise, label, milliseconds = 2_000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${milliseconds} ms`)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** A valid JSON-RPC request whose serialised form is exactly `bytes` long. */
function requestOfExactSize(bytes) {
  const overhead = Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "" }));
  const line = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "m".repeat(bytes - overhead) });
  assert.equal(Buffer.byteLength(line), bytes);
  return line;
}

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

describe("transport framing", () => {
  test("reassembles a frame delivered one byte per chunk", async (t) => {
    const { stdin, transport, messages, errors } = createHarness(collectingStdout().stream);
    t.after(() => transport.close());
    await transport.start();

    for (const byte of Buffer.from(ping(1))) {
      stdin.write(Buffer.from([byte]));
    }
    await tick();

    assert.deepEqual(messages.map((message) => message.method), ["ping"]);
    assert.deepEqual(errors, []);
  });

  test("decodes a multi-byte UTF-8 character split across two chunks", async (t) => {
    const { stdin, transport, messages } = createHarness(collectingStdout().stream);
    t.after(() => transport.close());
    await transport.start();

    const bytes = Buffer.from(frame({ jsonrpc: "2.0", id: 1, method: "café" }));
    const splitInsideCharacter = bytes.indexOf(0xc3) + 1;
    stdin.write(bytes.subarray(0, splitInsideCharacter));
    stdin.write(bytes.subarray(splitInsideCharacter));
    await tick();

    assert.equal(messages[0]?.method, "café");
  });

  test("accepts CRLF, ignores blank keep-alive lines and splits batched frames", async (t) => {
    const { stdin, transport, messages, errors } = createHarness(collectingStdout().stream);
    t.after(() => transport.close());
    await transport.start();

    stdin.write(`\r\n   \n\t\n${ping(1).replace("\n", "\r\n")}${ping(2)}`);
    await tick();

    assert.deepEqual(messages.map((message) => message.id), [1, 2]);
    assert.deepEqual(errors, [], "blank lines are neither valid nor invalid frames");
  });

  test("accepts a frame of exactly maxFrameBytes, in one chunk or split before the newline", async (t) => {
    const { stdin, transport, messages, errors } = createHarness(collectingStdout().stream, { maxFrameBytes: 200 });
    t.after(() => transport.close());
    await transport.start();

    const atLimit = requestOfExactSize(200);
    stdin.write(`${atLimit}\n`);
    stdin.write(atLimit); // buffered as a partial frame...
    stdin.write("\n"); // ...and completed by a newline-only chunk
    await tick();

    assert.equal(messages.length, 2);
    assert.deepEqual(errors, []);
  });

  test("rejects a frame one byte over the limit exactly once, in either delivery shape", async (t) => {
    const out = collectingStdout();
    const { stdin, transport, messages, errors } = createHarness(out.stream, { maxFrameBytes: 200 });
    t.after(() => transport.close());
    await transport.start();

    stdin.write(`${"y".repeat(201)}\n`); // complete line, over the limit
    stdin.write("y".repeat(201)); // partial frame, over the limit before any newline
    stdin.write(`\n${ping(5)}`);
    await tick();

    assert.equal(errors.filter((message) => /exceeds 200 bytes/.test(message)).length, 2);
    assert.equal(out.messages().filter((message) => message.error?.code === -32600).length, 2);
    assert.deepEqual(messages.map((message) => message.id), [5], "the stream recovers after each discarded frame");
  });

  test("discards an oversized frame spread over many chunks with a single error", async (t) => {
    const { stdin, transport, messages, errors } = createHarness(collectingStdout().stream, { maxFrameBytes: 1024 });
    t.after(() => transport.close());
    await transport.start();

    for (let index = 0; index < 50; index += 1) {
      stdin.write(Buffer.alloc(1024, 0x61)); // 50 KiB, no newline
    }
    stdin.write(`\n${ping(9)}`);
    await tick();

    assert.equal(errors.filter((message) => /exceeds/.test(message)).length, 1);
    assert.deepEqual(messages.map((message) => message.id), [9]);
  });

  test("echoes request ids up to the length limit and drops longer ones", async (t) => {
    const out = collectingStdout();
    const { stdin, transport } = createHarness(out.stream);
    t.after(() => transport.close());
    await transport.start();

    const invalid = (id) => frame({ jsonrpc: "2.0", id, method: 42 });
    const longestEchoed = "i".repeat(MAX_ECHOED_REQUEST_ID_LENGTH);
    stdin.write(invalid(longestEchoed));
    stdin.write(invalid(`${longestEchoed}i`));
    stdin.write(invalid("z".repeat(100_000)));
    stdin.write(invalid(7));
    await tick();

    const replies = out.messages();
    assert.deepEqual(
      replies.map((reply) => reply.id),
      [longestEchoed, undefined, undefined, 7],
    );
    assert.ok(
      replies.every((reply) => Buffer.byteLength(JSON.stringify(reply)) < 1024),
      "an oversized id must not be reflected back into the reply",
    );
  });
});

// ---------------------------------------------------------------------------
// Memory bounds
// ---------------------------------------------------------------------------

describe("transport memory bounds", () => {
  test("a malformed flood leaves one drain listener and a bounded number of replies", async () => {
    const stdout = stalledStdout();
    const { stdin, transport, errors } = createHarness(stdout);
    await transport.start();

    stdin.write(Buffer.from("x\n".repeat(200_000)));
    await tick();

    // Before the fix: one 'drain' listener and one onerror call per bad line.
    assert.ok(stdout.listenerCount("drain") <= 1, `${stdout.listenerCount("drain")} drain listeners`);
    assert.equal(errors.length, MAX_CONSECUTIVE_INVALID_FRAMES + 1, "budgeted replies plus one flood notice");
    assert.match(errors.at(-1), /Malformed input flood/);

    await transport.close();
    assert.equal(stdout.listenerCount("drain"), 0, "close() must detach the drain listener");
  });

  test("retained heap stays flat after a flood of malformed frames", async (t) => {
    if (typeof collectGarbage !== "function") {
      t.skip("gc() is unavailable in this runtime");
      return;
    }
    const { stdin, transport } = createHarness(stalledStdout());
    t.after(() => transport.close());
    await transport.start();

    collectGarbage();
    const before = process.memoryUsage().heapUsed;
    stdin.write(Buffer.from("x\n".repeat(200_000)));
    await tick();
    collectGarbage();
    const retainedMiB = (process.memoryUsage().heapUsed - before) / (1024 * 1024);

    // Measured: ~0.1 MiB. The unbounded implementation retained >150 MiB for this same flood.
    assert.ok(retainedMiB < 16, `retained ${retainedMiB.toFixed(1)} MiB`);
  });

  test("the error-reply budget re-arms after a valid message", async (t) => {
    const out = collectingStdout();
    const { stdin, transport, messages, errors } = createHarness(out.stream, { maxConsecutiveInvalidFrames: 3 });
    t.after(() => transport.close());
    await transport.start();

    stdin.write("bad\n".repeat(10));
    await tick();
    assert.equal(out.messages().length, 3, "only the budgeted replies are sent");

    stdin.write(ping(1));
    await tick();
    assert.equal(messages.length, 1);
    assert.match(errors.at(-1), /7 invalid frames were dropped/);

    stdin.write("bad\n");
    await tick();
    assert.equal(out.messages().length, 4, "a new run gets a fresh budget");
  });

  test("send() rejects instead of queueing without bound when the client stops reading", async (t) => {
    const maxOutboundBytes = 64 * 1024;
    const { transport } = createHarness(stalledStdout(), { maxOutboundBytes });
    t.after(() => transport.close());
    await transport.start();

    const response = (id) => ({ jsonrpc: "2.0", id, result: { pad: "p".repeat(200) } });
    const smallestFrame = Buffer.byteLength(frame(response(0)));
    const total = 5_000;
    const failures = [];
    // Not awaited: on a stalled stream the in-flight write never completes. That
    // is the intended backpressure; what matters is that the queue stops growing.
    for (let id = 0; id < total; id += 1) {
      transport.send(response(id)).catch((error) => failures.push(error.message));
    }
    await tick();

    const maxQueued = Math.floor(maxOutboundBytes / smallestFrame) + 1; // + the one in flight
    assert.ok(failures.length >= total - maxQueued, `only ${failures.length} of ${total} sends were refused`);
    assert.match(failures[0], /client has stopped reading/);
  });

  test("stdin is paused while stdout is backed up and resumed once it drains", async (t) => {
    const stdout = new ManualStdout();
    const { stdin, transport } = createHarness(stdout);
    t.after(() => transport.close());
    await transport.start();
    assert.equal(stdin.isPaused(), false);

    const megabyte = "p".repeat(1024 * 1024);
    const sends = Array.from({ length: 6 }, (_, id) => transport.send({ jsonrpc: "2.0", id, result: { megabyte } }));
    await tick();
    assert.equal(stdin.isPaused(), true, "~5 MiB queued is over the high-water mark");

    await stdout.drainAll();
    await settlesWithin(Promise.all(sends), "the drained sends");
    assert.equal(stdin.isPaused(), false, "reading resumes once the queue drains");
    assert.ok(stdout.receivedBytes > 6 * megabyte.length);
  });

  test("close() detaches every listener and rejects queued sends", async () => {
    const stdout = stalledStdout();
    const { stdin, transport } = createHarness(stdout);
    await transport.start();

    void transport.send(JSON.parse(ping(1))); // in flight forever on a stalled stream
    const queued = [transport.send(JSON.parse(ping(2))), transport.send(JSON.parse(ping(3)))];

    await transport.close();

    for (const send of queued) {
      await assert.rejects(settlesWithin(send, "a queued send after close()"), /closed before the message reached stdout/);
    }
    assert.equal(stdout.listenerCount("drain"), 0);
    assert.equal(stdin.listenerCount("data"), 0);
    assert.equal(stdin.listenerCount("error"), 0);
    await assert.rejects(transport.send(JSON.parse(ping(4))), /transport is closed/);
  });
});

// ---------------------------------------------------------------------------
// Real process
// ---------------------------------------------------------------------------

describe("server process under a malformed flood", () => {
  test("bounds replies and log lines, then keeps serving", async () => {
    const server = spawnRawServer();
    try {
      server.write("x\n".repeat(20_000));
      server.send(INITIALIZE_REQUEST);
      const initialized = await server.waitFor((message) => message.id === 1, "initialize result");
      assert.equal(initialized.result.serverInfo.name, "ast-navigator-mcp-server");

      // Replies share one ordered queue, so every flood reply precedes the initialize result.
      const parseErrors = server.messages.filter((message) => message.error?.code === -32700);
      assert.equal(parseErrors.length, MAX_CONSECUTIVE_INVALID_FRAMES);

      server.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      server.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      const toolList = await server.waitFor((message) => message.id === 2, "tools/list after the flood");
      assert.equal(toolList.result.tools.length, 2);
      assert.deepEqual(server.nonJsonLines, [], "stdout must carry JSON-RPC only");
    } finally {
      assert.equal(await server.stop(), 0, "server should exit cleanly when stdin closes");
    }

    const protocolWarnings = server.stderr.split("\n").filter((line) => line.includes("Protocol error contained"));
    // The budgeted replies, the flood notice and the flood-ended summary.
    assert.ok(
      protocolWarnings.length <= MAX_CONSECUTIVE_INVALID_FRAMES + 2,
      `${protocolWarnings.length} protocol warnings logged for a 20k-line flood`,
    );
  });
});
