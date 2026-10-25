/**
 * One question to the agent, with a hard time limit.
 *
 * Kept apart from bridge.ts so the turn logic can be tested without Telegram
 * or Letta: anything with send/stream/abort/close is a session here.
 */

export interface TurnSession {
  send(content: unknown): Promise<void>;
  stream(): AsyncIterable<any>;
  abort(): Promise<void>;
  close(): void;
}

export type TurnOutcome =
  | { kind: "answer"; text: string }
  | { kind: "empty" }
  | { kind: "failed"; reason: string }
  | { kind: "timeout" };

export const TURN_TIMEOUT_MS = 90_000;

export const REPLY_FAILED =
  "Sorry, er ging iets mis aan mijn kant. Probeer het over een paar minuten nog eens.";
export const REPLY_EMPTY =
  "Sorry, ik heb je vraag ontvangen maar kreeg geen antwoord terug. Wil je het nog eens vragen?";
export const REPLY_TIMEOUT =
  "Sorry, het duurt te lang voordat er een antwoord komt. Probeer het over een paar minuten nog eens.";

/** What she gets to read for each outcome. */
export function replyFor(outcome: TurnOutcome): string {
  switch (outcome.kind) {
    case "answer":
      return outcome.text;
    case "empty":
      return REPLY_EMPTY;
    case "failed":
      return REPLY_FAILED;
    case "timeout":
      return REPLY_TIMEOUT;
  }
}

/** Telegram messages cap at 4096 chars; split long answers. */
export function splitForTelegram(text: string, size = 4000): string[] {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
  return parts;
}

/** One log line per event, never the content itself (it is her private mail). */
function describe(event: any): string {
  switch (event?.type) {
    case "assistant":
    case "reasoning":
    case "tool_result":
      return `${event.type} (${String(event.content ?? "").length} chars)`;
    case "tool_call":
      return `tool_call ${event.toolName}`;
    case "error":
      return `error stopReason=${event.stopReason} code=${event.errorCode ?? "-"} message=${event.message ?? "-"} detail=${event.errorDetail ?? "-"}`;
    case "retry":
      return `retry ${event.attempt}/${event.maxAttempts} reason=${event.reason}`;
    case "result":
      return `result success=${event.success} code=${event.errorCode ?? "-"} stopReason=${event.stopReason ?? "-"} detail=${event.errorDetail ?? event.error ?? "-"} runs=${(event.runIds ?? []).join(",") || "-"}`;
    case "stream_event":
      return `stream_event ${event.event?.type ?? event.event?.message_type ?? "?"}`;
    case "loop_status":
      return `loop_status ${event.status}`;
    default:
      return String(event?.type ?? "unknown");
  }
}

async function collect(
  session: TurnSession,
  content: unknown,
  log: (line: string) => void,
): Promise<TurnOutcome> {
  await session.send(content);
  log("sent to agent");

  let answer = "";
  let failure: string | null = null;
  let finalText = "";
  let sawResult = false;
  for await (const event of session.stream()) {
    if (event.type === "error") console.error(`Agent error: ${describe(event)}`);
    else log(`event ${describe(event)}`);
    if (event.type === "assistant") answer += event.content ?? "";
    if (event.type === "result") {
      sawResult = true;
      if (!event.success) failure = event.errorCode ?? event.error ?? "error";
      else if (typeof event.result === "string") finalText = event.result;
    }
  }

  // Some turns carry their text only on the final result, not as assistant events.
  if (!answer.trim() && finalText.trim()) answer = finalText;
  log(`answer length ${answer.trim().length}`);

  if (failure) return { kind: "failed", reason: failure };
  if (!sawResult && !answer.trim()) return { kind: "failed", reason: "stream ended without result" };
  if (!answer.trim()) return { kind: "empty" };
  return { kind: "answer", text: answer };
}

/**
 * Send one question and wait for the answer, at most timeoutMs. On timeout the
 * run is aborted and the session closed, so a stuck turn never blocks the next one.
 */
export async function runTurn(
  session: TurnSession,
  content: unknown,
  options: { timeoutMs?: number; log?: (line: string) => void } = {},
): Promise<TurnOutcome> {
  const timeoutMs = options.timeoutMs ?? TURN_TIMEOUT_MS;
  const log = options.log ?? ((line: string) => console.log(line));
  const started = Date.now();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<TurnOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
  });
  const work = collect(session, content, log).catch((error: unknown): TurnOutcome => {
    console.error("Turn crashed:", error);
    return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
  });

  const outcome = await Promise.race([work, timeout]);
  clearTimeout(timer);

  if (outcome.kind === "timeout") {
    console.error(`Turn timed out after ${timeoutMs} ms - aborting the run.`);
    // abort() talks to the server and may itself hang; give it a few seconds.
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      session.abort().catch((error) => console.error("Abort failed:", error)),
      new Promise((resolve) => {
        abortTimer = setTimeout(resolve, 5_000);
      }),
    ]);
    clearTimeout(abortTimer);
  }
  try {
    session.close();
  } catch (error) {
    console.error("Closing the session failed:", error);
  }
  if (outcome.kind === "failed") console.error(`Turn failed: ${outcome.reason}`);
  log(`turn ${outcome.kind} in ${Date.now() - started} ms`);
  return outcome;
}
