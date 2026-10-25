import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REPLY_EMPTY,
  REPLY_FAILED,
  REPLY_TIMEOUT,
  replyFor,
  runTurn,
  splitForTelegram,
  type TurnSession,
} from "./turn.js";

function fakeSession(events: any[], options: { hang?: boolean } = {}) {
  const state = { aborted: false, closed: false, sent: [] as unknown[] };
  const session: TurnSession = {
    async send(content) {
      state.sent.push(content);
    },
    async *stream() {
      for (const event of events) yield event;
      if (options.hang) await new Promise(() => {}); // never resolves
    },
    async abort() {
      state.aborted = true;
    },
    close() {
      state.closed = true;
    },
  };
  return { session, state };
}

const quiet = { log: () => {} };
const ok = { type: "result", success: true, durationMs: 1, conversationId: null };

test("an answer is passed through and the session closed", async () => {
  const { session, state } = fakeSession([
    { type: "assistant", content: "Hallo " },
    { type: "assistant", content: "oma" },
    ok,
  ]);
  const outcome = await runTurn(session, "vraag", quiet);
  assert.deepEqual(outcome, { kind: "answer", text: "Hallo oma" });
  assert.equal(replyFor(outcome), "Hallo oma");
  assert.equal(state.closed, true);
});

test("an empty answer gets a fallback instead of silence", async () => {
  const { session } = fakeSession([{ type: "assistant", content: "  " }, ok]);
  const outcome = await runTurn(session, "vraag", quiet);
  assert.equal(outcome.kind, "empty");
  assert.equal(replyFor(outcome), REPLY_EMPTY);
});

test("text only on the final result still reaches her", async () => {
  const { session } = fakeSession([{ ...ok, result: "Antwoord uit result" }]);
  const outcome = await runTurn(session, "vraag", quiet);
  assert.deepEqual(outcome, { kind: "answer", text: "Antwoord uit result" });
});

test("a failed turn gets the error reply", async () => {
  const { session } = fakeSession([
    { type: "error", message: "quota", stopReason: "llm_api_error" },
    { type: "result", success: false, errorCode: "llm_api_error", durationMs: 1, conversationId: null },
  ]);
  const outcome = await runTurn(session, "vraag", quiet);
  assert.deepEqual(outcome, { kind: "failed", reason: "llm_api_error" });
  assert.equal(replyFor(outcome), REPLY_FAILED);
});

test("a stream that ends without a result is a failure, not silence", async () => {
  const { session } = fakeSession([]);
  const outcome = await runTurn(session, "vraag", quiet);
  assert.equal(outcome.kind, "failed");
});

test("a hanging stream times out, aborts the run and closes the session", async () => {
  const { session, state } = fakeSession([{ type: "reasoning", content: "..." }], { hang: true });
  const outcome = await runTurn(session, "vraag", { ...quiet, timeoutMs: 50 });
  assert.equal(outcome.kind, "timeout");
  assert.equal(replyFor(outcome), REPLY_TIMEOUT);
  assert.equal(state.aborted, true);
  assert.equal(state.closed, true);
});

test("a hanging send times out too", async () => {
  const { session } = fakeSession([]);
  session.send = () => new Promise(() => {});
  const outcome = await runTurn(session, "vraag", { ...quiet, timeoutMs: 50 });
  assert.equal(outcome.kind, "timeout");
});

test("a send that throws becomes a failure", async () => {
  const { session } = fakeSession([]);
  session.send = async () => {
    throw new Error("401 invalid api key");
  };
  const errors = console.error;
  console.error = () => {};
  try {
    const outcome = await runTurn(session, "vraag", quiet);
    assert.deepEqual(outcome, { kind: "failed", reason: "401 invalid api key" });
  } finally {
    console.error = errors;
  }
});

test("the log names event types and the answer length, never the content", async () => {
  const lines: string[] = [];
  const { session } = fakeSession([{ type: "assistant", content: "geheim" }, ok]);
  await runTurn(session, "vraag", { log: (line) => lines.push(line) });
  const all = lines.join("\n");
  assert.match(all, /event assistant \(6 chars\)/);
  assert.match(all, /event result success=true/);
  assert.match(all, /answer length 6/);
  assert.doesNotMatch(all, /geheim/);
});

test("long answers are split under the Telegram limit", () => {
  const parts = splitForTelegram("x".repeat(9000));
  assert.deepEqual(parts.map((p) => p.length), [4000, 4000, 1000]);
});
