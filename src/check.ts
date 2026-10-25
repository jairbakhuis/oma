import { LettaAgentClient } from "@letta-ai/letta-agent-sdk";
import { loadConfig } from "./config.js";
import { runTurn } from "./turn.js";

/**
 * Health check of her agent, no Telegram involved. Read-only, step by step,
 * so the first failing step names the cause:
 *   1. API key valid   2. agent exists   3. no stuck run or open approval
 *   4. session starts  5. one test question answered within the time limit
 * Exit code 0 only when everything passed.
 */

const API = (process.env.LETTA_BASE_URL || "https://api.letta.com").replace(/\/$/, "");

async function api(apiKey: string, path: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep the raw text
  }
  return { status: response.status, body };
}

function fail(step: string, detail: string): never {
  console.error(`\n[FAIL] ${step}: ${detail}`);
  process.exit(1);
}

async function main() {
  const { lettaApiKey, agentId, computer } = loadConfig();

  // 1 + 2: key and agent in one call - 401 is the key, 404 the agent.
  const agent = await api(lettaApiKey, `/v1/agents/${agentId}`);
  if (agent.status === 401 || agent.status === 403) fail("API key", `HTTP ${agent.status} - LETTA_API_KEY is invalid or revoked.`);
  if (agent.status === 404) fail("Agent", `${agentId} does not exist on this account.`);
  if (agent.status === 429) fail("Quota", `HTTP 429 - rate limit or free-tier quota reached: ${JSON.stringify(agent.body)}`);
  if (agent.status !== 200) fail("Agent", `HTTP ${agent.status}: ${JSON.stringify(agent.body).slice(0, 500)}`);
  console.log(`[OK] API key valid, agent "${agent.body.name}" found (model ${agent.body.model ?? agent.body.llm_config?.model ?? "?"}).`);

  // 3: a run that never finished, or a tool call waiting for approval, blocks new turns.
  const runs = await api(lettaApiKey, `/v1/runs/?agent_id=${agentId}&active=true&limit=10`);
  if (runs.status === 200 && Array.isArray(runs.body)) {
    if (runs.body.length > 0) {
      console.log(`[WARN] ${runs.body.length} active run(s) - a stuck run blocks new questions:`);
      for (const run of runs.body) console.log(`       ${run.id} status=${run.status} since ${run.created_at}`);
    } else {
      console.log("[OK] no active runs.");
    }
  } else {
    console.log(`[WARN] could not list runs: HTTP ${runs.status}`);
  }
  const messages = await api(lettaApiKey, `/v1/agents/${agentId}/messages?limit=5&order=desc`);
  if (messages.status === 200 && Array.isArray(messages.body)) {
    const last = messages.body[0];
    if (last?.message_type === "approval_request_message") {
      console.log(`[WARN] the last message is an open approval request (tool ${last.tool_call?.name ?? "?"}) - the agent waits for an approval nobody gives.`);
    } else {
      console.log(`[OK] last message: ${last?.message_type ?? "none"} at ${last?.date ?? "-"}.`);
    }
  } else {
    console.log(`[WARN] could not read recent messages: HTTP ${messages.status}`);
  }

  const client = new LettaAgentClient({
    backend: "cloud",
    apiKey: lettaApiKey,
    ...(computer ? { computer } : {}),
  });
  const session = client.resumeSession(agentId);

  // 4: session start (sandbox or computer connection) on its own clock.
  const started = Date.now();
  try {
    await Promise.race([
      session.ready(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("no ready after 60 s")), 60_000)),
    ]);
  } catch (error) {
    session.close();
    fail("Session start", `${error instanceof Error ? error.message : String(error)} (computer: ${computer ?? "SDK-managed sandbox"})`);
  }
  console.log(`[OK] session started in ${Date.now() - started} ms.`);

  // 5: one real question, with the same limit and event log as the bridge.
  const outcome = await runTurn(
    session,
    "Dit is een test. Antwoord met een korte begroeting zodat we weten dat alles werkt.",
    { log: (line) => console.log(`       ${line}`) },
  );
  if (outcome.kind !== "answer") fail("Test question", `outcome ${outcome.kind}${outcome.kind === "failed" ? ` (${outcome.reason})` : ""}`);
  console.log(`\n${outcome.text}\n\n[OK] agent responded.`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
