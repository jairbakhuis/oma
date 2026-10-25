import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearTurnMarker, handleBatch, startTurnMarker, takeUnfinishedTurn } from "./poll.js";

test("each update is confirmed before it is handled", async () => {
  const calls: string[] = [];
  const offset = await handleBatch(
    [{ update_id: 7 }, { update_id: 8 }],
    async (next) => {
      calls.push(`confirm ${next}`);
    },
    async (update) => {
      calls.push(`handle ${update.update_id}`);
    },
  );
  assert.deepEqual(calls, ["confirm 8", "handle 7", "confirm 9", "handle 8"]);
  assert.equal(offset, 9);
});

test("a handler that crashes the bridge leaves its update already confirmed", async () => {
  const confirmed: number[] = [];
  await assert.rejects(
    handleBatch(
      [{ update_id: 41 }],
      async (next) => {
        confirmed.push(next);
      },
      async () => {
        throw new Error("crash");
      },
    ),
  );
  assert.deepEqual(confirmed, [42]);
});

test("a failed confirm does not stop the question", async () => {
  const handled: number[] = [];
  const offset = await handleBatch(
    [{ update_id: 3 }],
    async () => {
      throw new Error("network");
    },
    async (update) => {
      handled.push(update.update_id);
    },
  );
  assert.deepEqual(handled, [3]);
  assert.equal(offset, 4);
});

test("an empty batch keeps the offset", async () => {
  assert.equal(await handleBatch([], async () => {}, async () => {}), undefined);
});

test("a turn that never finished is reported once at the next start", () => {
  const marker = join(mkdtempSync(join(tmpdir(), "oma-")), "turn");
  assert.equal(takeUnfinishedTurn(marker), false);
  startTurnMarker(marker);
  assert.equal(takeUnfinishedTurn(marker), true);
  assert.equal(takeUnfinishedTurn(marker), false);
});

test("a finished turn leaves no marker", () => {
  const marker = join(mkdtempSync(join(tmpdir(), "oma-")), "turn");
  startTurnMarker(marker);
  clearTurnMarker(marker);
  assert.equal(takeUnfinishedTurn(marker), false);
});
