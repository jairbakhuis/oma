import { LettaAgentClient } from "@letta-ai/letta-agent-sdk";
import { loadConfig } from "./config.js";

/**
 * oma-bridge: Telegram long-poll -> Letta cloud agent -> Telegram reply.
 *
 * - Only OMA_TELEGRAM_CHAT_ID may talk to the bot; everyone else is ignored.
 * - One turn at a time per chat; extra messages queue inside the Letta runtime.
 * - Photos she sends are forwarded to the agent as images (letters, documents).
 */

const TELEGRAM_API = "https://api.telegram.org/bot";

// A home connection drops a packet now and then. She must never be told
// "something went wrong" because one call lost half a second.
const TELEGRAM_ATTEMPTS = 3;
const TELEGRAM_BACKOFF_MS = 1500;

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
  let lastError: unknown;
  for (let attempt = 1; attempt <= TELEGRAM_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(`${TELEGRAM_API}${token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      if (!response.ok) {
        // An HTTP status is an answer, not a hiccup: retrying a 401 or a 400
        // only repeats it. Report and give up, exactly as before.
        console.error(`Telegram ${method} failed: ${response.status}`);
        return null;
      }
      const json = await response.json();
      return json.result ?? null;
    } catch (error) {
      // fetch threw: DNS, TCP or TLS. That is the transient case, and the one
      // that cost her an answer on 2026-09-30.
      lastError = error;
      if (attempt < TELEGRAM_ATTEMPTS) {
        await new Promise((resolve) =>
          setTimeout(resolve, attempt * TELEGRAM_BACKOFF_MS),
        );
      }
    }
  }
  console.error(
    `Telegram ${method} unreachable after ${TELEGRAM_ATTEMPTS} attempts:`,
    lastError,
  );
  return null;
}

async function downloadFile(token: string, fileId: string): Promise<Buffer> {
  const file = await telegram(token, "getFile", { file_id: fileId });
  const path = file?.file_path;
  if (!path) throw new Error("Telegram getFile returned no file_path");
  const response = await fetch(`https://api.telegram.org/file/bot${token}/${path}`);
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

  try {
    await telegram(token, "sendChatAction", {
      chat_id: allowedChatId,
      action: "typing",
    });

    await using session = client.resumeSession(agentId);

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

    await session.send(content as any);

    let answer = "";
    for await (const event of session.stream()) {
      if (event.type === "assistant") answer += event.content;
      if (event.type === "result" && !event.success) {
        console.error("Turn failed:", event.errorCode, event.errorDetail);
        answer = "Sorry, er ging iets mis aan mijn kant. Probeer het nog eens.";
      }
    }

    if (answer.trim()) {
      // Telegram messages cap at 4096 chars; split long answers.
      for (let i = 0; i < answer.length; i += 4000) {
        await telegram(token, "sendMessage", {
          chat_id: allowedChatId,
          text: answer.slice(i, i + 4000),
        });
      }
    }
  } catch (error) {
    console.error("Error handling update:", error);
    await telegram(token, "sendMessage", {
      chat_id: allowedChatId,
      text: "Sorry, er ging iets mis. Probeer het over een paar minuten nog eens.",
    });
  }
}

async function main() {
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

    for (const update of updates) {
      offset = update.update_id + 1;
      await handleUpdate(update, telegramToken, client, agentId, allowedChatId);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
