import { LettaAgentClient } from "@letta-ai/letta-agent-sdk";
import { loadConfig } from "./config.js";

/**
 * Creates Oma's agent on her Letta account (free tier, cloud backend).
 * Run once; prints the agent ID to paste into .env as OMA_AGENT_ID.
 */
async function main() {
  const { lettaApiKey } = loadConfig();

  const client = new LettaAgentClient({
    backend: "cloud",
    apiKey: lettaApiKey,
  });

  const agentId = await client.createAgent({
    name: "Oma Assistant",
    description: "Oma's personal assistant for financial and governmental questions",
    persona: [
      "Je bent de persoonlijke assistent van Oma.",
      "Zij stelt zo'n twee vragen per dag over geldzaken en overheidszaken.",
      "",
      "Regels:",
      "- Antwoord in dezelfde taal als de vraag (Nederlands, Engels of Papiamentu).",
      "- Houd antwoorden kort en concreet: wat betekent dit, wat moet zij doen,",
      "  en waar kan ze het controleren (met bronvermelding).",
      "- Bij regels, bedragen of deadlines: zoek altijd eerst actuele informatie op.",
      "- Vermijd jargon; leg termen uit zoals je het aan een familielid uitlegt.",
      "- Als iets onzeker of juridisch ingewikkeld is, zeg dat eerlijk en",
      "  raad aan om het met het juiste loket of een adviseur te checken.",
      "- Onthoud wat zij eerder vroeg; bouw door op eerdere antwoorden.",
      "",
      "Context:",
      "- Zij woont in Curacao. Voor belasting- en overheidsvragen gelden de",
      "  Curacao-regels, tenzij de vraag duidelijk over Nederland gaat.",
      "- Geldbedragen noem je in de valuta die zij noemt (ANG/NAf of EUR).",
    ].join("\n"),
    human: [
      "De gebruiker is Oma: woont in Curacao, stelt zo'n twee vragen per dag",
      "over financiën en overheidszaken. Wil korte, duidelijke antwoorden zonder",
      "jargon, met bronnen die ze kan nakijken.",
    ].join(" "),
    // web_search + fetch_webpage are the default base tools; keep them so
    // governmental questions get current, sourced answers.
    // Model: defaults to the "auto" preset; override with a BYOK handle here
    // once her provider key is connected, e.g. model: "openai/gpt-5.2".
  });

  console.log("Agent created.");
  console.log("OMA_AGENT_ID=" + agentId);
  console.log("Paste the line above into .env, then run: npm run check");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
