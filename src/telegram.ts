// One place for every Telegram Bot API call, with retries.
//
// WHY THIS EXISTS (2026-09-30): the bridge used a bare fetch here. A single
// ETIMEDOUT on the sendChatAction ("typing...") call propagated out of
// handleUpdate's try block, hit the outer catch, and replaced a perfectly good
// answer with "Sorry, er ging iets mis." - over a half-second network hiccup.
// Oma lost her answer because the typing indicator failed.
//
// Two rules follow from that, and they are what the tests pin down:
//   1. Transient failures are retried with a short linear backoff.
//   2. This function NEVER throws. It returns null when it gives up, so a
//      failed side-call (typing indicator, getFile) can never cost her the
//      answer. Callers that need the result check for null.

export const TELEGRAM_API = "https://api.telegram.org/bot";

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;

export interface TelegramOptions {
  // Total attempts, including the first. Default 3.
  attempts?: number;
  // Linear backoff step: 500ms, then 1000ms, then 1500ms. Default 500.
  baseDelayMs?: number;
  // Injectable for tests.
  fetchImpl?: typeof fetch;
  // Injectable for tests, so they do not actually sleep.
  sleep?: (ms: number) => Promise<void>;
  // Injectable for tests.
  log?: (message: string) => void;
}

// 429 and 5xx are worth another try; a 4xx means the request itself is wrong.
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export async function telegram(
  token: string,
  method: string,
  body?: Record<string, unknown>,
  options: TelegramOptions = {},
): Promise<any> {
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
  const backoffStepMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const doFetch = options.fetchImpl ?? fetch;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = options.log ?? ((message: string) => console.error(message));

  let delayMs = backoffStepMs;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const lastAttempt = attempt === attempts;
    try {
      const response = await doFetch(`${TELEGRAM_API}${token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });

      if (!response.ok) {
        if (isRetryableStatus(response.status) && !lastAttempt) {
          log(
            `Telegram ${method} failed: ${response.status} - retrying (${attempt}/${attempts})`,
          );
          await sleep(delayMs);
          delayMs += backoffStepMs;
          continue;
        }
        log(`Telegram ${method} failed: ${response.status}`);
        return null;
      }

      const json: any = await response.json();
      return json?.result ?? null;
    } catch (error) {
      if (lastAttempt) {
        log(
          `Telegram ${method} unreachable after ${attempts} attempts: ${String(error)}`,
        );
        return null;
      }
      log(
        `Telegram ${method} threw: ${String(error)} - retrying (${attempt}/${attempts})`,
      );
      await sleep(delayMs);
      delayMs += backoffStepMs;
    }
  }

  return null;
}
