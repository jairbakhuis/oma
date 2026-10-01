// Regression tests for the retry behaviour in telegram().
//
// The bug these exist for: on 2026-09-30 a single ETIMEDOUT on the "typing..."
// call threw, bubbled to handleUpdate's outer catch, and oma got
// "Sorry, er ging iets mis." instead of her answer. So the contract is:
// retry transient failures, and NEVER throw.

import { test } from "node:test";
import assert from "node:assert/strict";
import { telegram } from "./telegram.js";

const noSleep = async () => {};
const quiet = () => {};

function okResponse(result: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, result }),
  } as unknown as Response;
}

function errorResponse(status: number): Response {
  return {
    ok: false,
    status,
    json: async () => ({ ok: false }),
  } as unknown as Response;
}

test("returns the result field on a first-try success", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return okResponse({ username: "Yvonne_Bakhuis_bot" });
  }) as unknown as typeof fetch;

  const result = await telegram("tok", "getMe", undefined, {
    fetchImpl,
    sleep: noSleep,
    log: quiet,
  });

  assert.deepEqual(result, { username: "Yvonne_Bakhuis_bot" });
  assert.equal(calls, 1);
});

test("a thrown fetch is retried and the second attempt wins", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    if (calls === 1) throw new Error("ETIMEDOUT");
    return okResponse(true);
  }) as unknown as typeof fetch;

  const result = await telegram("tok", "sendChatAction", {}, {
    fetchImpl,
    sleep: noSleep,
    log: quiet,
  });

  assert.equal(result, true);
  assert.equal(calls, 2);
});

test("never throws when every attempt fails - it returns null", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    throw new Error("ETIMEDOUT");
  }) as unknown as typeof fetch;

  const result = await telegram("tok", "sendChatAction", {}, {
    fetchImpl,
    sleep: noSleep,
    log: quiet,
  });

  assert.equal(result, null);
  assert.equal(calls, 3);
});

test("a 500 is retried", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    if (calls < 3) return errorResponse(500);
    return okResponse("recovered");
  }) as unknown as typeof fetch;

  const result = await telegram("tok", "sendMessage", {}, {
    fetchImpl,
    sleep: noSleep,
    log: quiet,
  });

  assert.equal(result, "recovered");
  assert.equal(calls, 3);
});

test("a 429 is retried", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    if (calls === 1) return errorResponse(429);
    return okResponse("recovered");
  }) as unknown as typeof fetch;

  const result = await telegram("tok", "sendMessage", {}, {
    fetchImpl,
    sleep: noSleep,
    log: quiet,
  });

  assert.equal(result, "recovered");
  assert.equal(calls, 2);
});

test("a 400 is not retried - the request itself is wrong", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return errorResponse(400);
  }) as unknown as typeof fetch;

  const result = await telegram("tok", "sendMessage", {}, {
    fetchImpl,
    sleep: noSleep,
    log: quiet,
  });

  assert.equal(result, null);
  assert.equal(calls, 1);
});

test("backoff grows linearly and is not slept on the final failure", async () => {
  const waits: number[] = [];
  const fetchImpl = (async () => {
    throw new Error("ETIMEDOUT");
  }) as unknown as typeof fetch;

  await telegram("tok", "getUpdates", {}, {
    fetchImpl,
    baseDelayMs: 100,
    sleep: async (ms: number) => {
      waits.push(ms);
    },
    log: quiet,
  });

  assert.deepEqual(waits, [100, 200]);
});

test("a missing result field reads as null, not undefined", async () => {
  const fetchImpl = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    }) as unknown as Response) as unknown as typeof fetch;

  const result = await telegram("tok", "getUpdates", {}, {
    fetchImpl,
    sleep: noSleep,
    log: quiet,
  });

  assert.equal(result, null);
});
