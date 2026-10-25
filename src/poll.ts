import { existsSync, rmSync, writeFileSync } from "node:fs";

/**
 * One batch of Telegram updates, each confirmed BEFORE it is handled.
 *
 * Telegram only forgets an update once getUpdates is called with a higher
 * offset. Without an early confirm, a message that crashes the bridge comes
 * back after every systemd restart: the log shows "question received" again
 * and again and she never gets a reply. Kept apart from bridge.ts so it can be
 * tested without Telegram.
 */

export async function handleBatch<U extends { update_id: number }>(
  updates: U[],
  confirm: (offset: number) => Promise<void>,
  handle: (update: U) => Promise<void>,
): Promise<number | undefined> {
  let offset: number | undefined;
  for (const update of updates) {
    offset = update.update_id + 1;
    try {
      await confirm(offset);
    } catch (error) {
      // Not fatal: the next getUpdates confirms it as well.
      console.error("Could not confirm the update:", error);
    }
    await handle(update);
  }
  return offset;
}

/**
 * A marker file that exists only while a turn runs. Found at startup, it means
 * the bridge died mid-turn (crash, OOM, a restart): she still gets an apology
 * instead of silence, because the early confirm means the message never returns.
 */
export function startTurnMarker(path: string): void {
  try {
    writeFileSync(path, new Date().toISOString());
  } catch (error) {
    console.error("Could not write the turn marker:", error);
  }
}

export function clearTurnMarker(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch (error) {
    console.error("Could not remove the turn marker:", error);
  }
}

/** True once if the previous run died mid-turn; clears the marker. */
export function takeUnfinishedTurn(path: string): boolean {
  if (!existsSync(path)) return false;
  clearTurnMarker(path);
  return true;
}
