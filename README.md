# Oma

Oma's personal assistant: a Telegram bot wired to a stateful Letta agent.

She asks ~2 questions a day (financial, governmental). The agent remembers every
question, which country's rules apply to her, and what "that pension letter" means.

## Architecture

```
Oma's phone (Telegram) -> @HerBot
        |  long-poll (outbound only, no port forwarding)
        v
oma-bridge (this repo, runs on the laptop)
        |  Letta Agent SDK (backend: cloud)
        v
Her agent on Letta Cloud (free tier)
        |  tools execute on the laptop (BYOM)
        v
web search -> current Curaçao/Dutch rules, sources cited
``+

- **Agent state lives in Letta Cloud** - memory, history, skills. If the laptop
  is off, her messages queue at Telegram and arrive when it comes back.
- **Free tier**: her own Letta account, BYOK model key. 2 questions/day is
  roughly $1-3/month in tokens.
- **One chat only**: the bridge rejects every Telegram chat ID except hers.

## Setup

1. **Her Letta account** (free): create it at platform.letta.com, generate an
   API key, add your model provider key via BYOK.

2. **Telegram bot**: message [@BotFather](https://t.me/BotFather), `/newbot`,
   copy the token. Message [@userinfobot](https://t.me/userinfobot) from her
   phone to get her chat ID.

3. **Configure**:

   ```
   copy .env.example .env   # then fill in the values
   npm install
   ```

4. **Create her agent** (once):

   ```
   npm run create-agent
   ```

   Prints the agent ID - paste it into `.env` as `OMA_AGENT_ID`.

5. **Test the agent directly** (no Telegram):

   ```
   npm run check
   ```

6. **Run the bridge**:

   ```
   npm start
   ```

   Send her a message from her phone; the bot answers.

## Keeping it running on the laptop

The bridge must stay running. Simplest on Windows: a Task Scheduler task that
runs `npm start` at logon, restarts on failure. The repo includes
`scripts/oma-bridge-task.xml` you can import.

Laptop sleep kills the bot - set the power plan to never sleep while plugged in.

## Per-client reuse

This whole repo is the template for the assistant-service idea: per client,
change only `.env` (bot token, chat ID, agent ID, API key). Nothing else.
