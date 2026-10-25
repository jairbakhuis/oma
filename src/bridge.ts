import { LettaAgentClient } from "@letta-ai/letta-agent-sdk";
import { loadConfig } from "./config.js";
import { fileURLToPath } from "node:url";
import { clearTurnMarker, handleBatch, startTurnMarker, takeUnfinishedTurn } from "./poll.js";
import { REPLY_FAILED, replyFor, runTurn, splitForTelegram } from "./turn.js";

/**
 * oma-bridge: Telegram long-poll -> Letta cloud agent -> Telegram reply.
 *
 * - Only OMA_TELEGRAM_CHAT_ID may talk to the bot; everyone else is ignored.
 * - One turn at a time per chat; extra messages queue inside the Letta runtime.
 * - Every turn has a hard time limit (src/turn.ts); she always gets a reply.
 * - Photos she sends are forwarded to the agent as images (letters, documents).
 * - Each update is confirmed to Telegram before it is handled (src/poll.ts), so
 *   a message that crashes the bridge cannot come back after every restart.
 */

const TELEGRAM_API = "https://api.telegram.org/bot";
// Next to .env (gitignored): exists only while a turn for her runs.
const TURN_MARKER = fileURLToPath(new URL("../.oma_turn_in_progress", import.meta.url));

interface TelegramUpdate {
  update_id: number;
  message?: {
    chat: { id: number };
    text?: string;
    caption?: string;
    photo?: { file_id: string }[]; // largest is last
    document?: { file_id: string; file_name?: string };
  };
}

async function telegram(
  token: string,
  method: string,
  body?: Record<string, unknown>,
): Promise<any> {
  const response = await fetch(`${TELEGRAM_API}${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
    // getUpdates long-polls 30 s; nothing to Telegram should take longer than this.
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    console.error(`Telegram ${method} failed: ${response.status}`);
    return null;
  }
  const json = await response.json();
  return json.result ?? null;
}

async function downloadFile(token: string, fileId: string): Promise<Buffer> {
  const file = await telegram(token, "getFile", { file_id: fileId });
  const path = file?.file_path;
  if (!path) throw new Error("Telegram getFile returned no file_path");
  const response = await fetch(`https://api.telegram.org/file/bot${token}/${path}`, {
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Telegram file download failed: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function handleUpdate(
  update: TelegramUpdate,
  token: string,
  client: LettaAgentClient,
  agentId: string,
  allowedChatId: string,
): Promise<void> {
  const message = update.message;
  if (!message) return;

  if (String(message.chat.id) !== allowedChatId) {
    // Not her chat: ignore silently. No information leak to strangers.
    console.log(`Ignoring chat ${message.chat.id} (not allowlisted).`);
    return;
  }

  const text = message.text ?? message.caption ?? "";
  const hasPhoto = message.photo && message.photo.length > 0;
  if (!text && !hasPhoto && !message.document) return;

  console.log(`[${new Date().toISOString()}] question received`);
  startTurnMarker(TURN_MARKER);

  try {
    await telegram(token, "sendChatAction", {
      chat_id: allowedChatId,
      action: "typing",
    });

    // Photos: letters, bank statements, official forms. Send as image content
    // so the agent can read them.
    const content: Array<Record<string, unknown>> = [];
    if (hasPhoto) {
      const largest = message.photo![message.photo!.length - 1];
      const bytes = await downloadFile(token, largest.file_id);
      content.push({
        type: "image",
        // base64 data URL - accepted by the SDK as image content
        source: {
          type: "base64",
          media_type: "image/jpeg",
          data: bytes.toString("base64"),
        },
      });
    }
    if (message.document) {
      const bytes = await downloadFile(token, message.document.file_id);
      content.push({
        type: "text",
        text: `[Bijlage: ${message.document.file_name ?? "document"} - kon niet als foto worden doorgestuurd]`,
      });
      // Non-image documents (PDFs) are not forwarded; note this to the agent.
      void bytes;
    }
    content.push({ type: "text", text: text || "Wat staat er in deze brief?" });

    // runTurn closes the session; no `await using`, whose dispose can hang.
    const session = client.resumeSession(agentId);
    const outcome = await runTurn(session, content, {
      log: (line) => console.log(`[${new Date().toISOString()}] ${line}`),
    });
    for (const part of splitForTelegram(replyFor(outcome))) {
      await telegram(token, "sendMessage", { chat_id: allowedChatId, text: part });
    }
  } catch (error) {
    console.error("Error handling update:", error);
    await telegram(token, "sendMessage", {
      chat_id: allowedChatId,
      text: "Sorry, er ging iets mis. Probeer het over een paar minuten nog eens.",
    }).catch((sendError) => console.error("Could not send the error reply:", sendError));
  } finally {
    clearTurnMarker(TURN_MARKER);
  }
}

async function main() {
  // A crash inside the SDK (a timer, a socket) bypasses every try/catch. Log it
  // with a timestamp so the journal names the cause, then let systemd restart.
  for (const kind of ["uncaughtException", "unhandledRejection"] as const) {
    process.on(kind, (error) => {
      console.error(`[${new Date().toISOString()}] ${kind} - the bridge restarts:`, error);
      process.exit(1);
    });
  }

  const { lettaApiKey, agentId, telegramToken, allowedChatId, computer } =
    loadConfig();

  const client = new LettaAgentClient({
    backend: "cloud",
    apiKey: lettaApiKey,
    ...(computer ? { computer } : {}),
  });

  // Validate the bot token before starting the loop.
  const me = await telegram(telegramToken, "getMe");
  if (!me) {
    console.error("Telegram bot token invalid.");
    process.exit(1);
  }
  console.log(`oma-bridge started - bot is @${me.username}`);
  console.log(`Agent: ${agentId}`);
  console.log(`Only chat ${allowedChatId} is allowlisted.`);

  if (takeUnfinishedTurn(TURN_MARKER)) {
    console.error("The previous run stopped mid-turn - sending her an apology.");
    await telegram(telegramToken, "sendMessage", { chat_id: allowedChatId, text: REPLY_FAILED });
  }

  let offset = 0;
  for (;;) {
    let updates: TelegramUpdate[] = [];
    try {
      updates = (await telegram(telegramToken, "getUpdates", {
        offset,
        timeout: 30,
        allowed_updates: ["message"],
      })) ?? [];
    } catch {
      // network hiccup - retry after a pause
      await new Promise((resolve) => setTimeout(resolve, 5000));
      continue;
    }

    offset =
      (await handleBatch(
        updates,
        async (next) => {
          await telegram(telegramToken, "getUpdates", { offset: next, timeout: 0, limit: 1 });
        },
        (update) => handleUpdate(update, telegramToken, client, agentId, allowedChatId),
      )) ?? offset;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
