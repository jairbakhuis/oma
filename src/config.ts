import { readFileSync } from "node:fs";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name} - copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return value;
}

export function loadConfig(): {
  lettaApiKey: string;
  agentId: string;
  telegramToken: string;
  allowedChatId: string;
  computer?: string;
} {
  // .env is plain KEY=VALUE; parse it ourselves so there are no extra deps.
  try {
    const envFile = readFileSync(new URL("../.env", import.meta.url), "utf8");
    for (const line of envFile.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (match && process.env[match[1]] === undefined) {
        process.env[match[1]] = match[2];
      }
    }
  } catch {
    // no .env file - rely on real environment variables
  }

  return {
    lettaApiKey: requireEnv("LETTA_API_KEY"),
    agentId: requireEnv("OMA_AGENT_ID"),
    telegramToken: requireEnv("TELEGRAM_BOT_TOKEN"),
    allowedChatId: requireEnv("OMA_TELEGRAM_CHAT_ID"),
    computer: process.env.OMA_COMPUTER || undefined,
  };
}
