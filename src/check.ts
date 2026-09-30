import { LettaAgentClient } from "@letta-ai/letta-agent-sdk";
import { loadConfig } from "./config.js";

/**
 * Smoke test: one question straight to the agent, no Telegram involved.
 */
async function main() {
  const { lettaApiKey, agentId, computer } = loadConfig();

  const client = new LettaAgentClient({
    backend: "cloud",
    apiKey: lettaApiKey,
    ...(computer ? { computer } : {}),
  });

  await using session = client.resumeSession(agentId);

  await session.send(
    "Dit is een test. Antwoord met een korte begroeting zodat we weten dat alles werkt.",
  );

  for await (const message of session.stream()) {
    if (message.type === "assistant") {
      process.stdout.write(message.content);
    }
    if (message.type === "result") {
      if (!message.success) {
        console.error("\nTurn failed:", message.errorCode, message.errorDetail);
        process.exit(1);
      }
      console.log("\n[OK] agent responded.");
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
