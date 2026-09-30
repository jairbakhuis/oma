# Oma

Oma's personal assistant: a Telegram bot wired to a stateful Letta agent.

She asks ~2 questions a day (financial, governmental). The agent remembers every
question, which country's rules apply to her, and what "that pension letter" means.

**This README is an install runbook.** It is written so an agent (Vision) can
execute it top-to-bottom on the target machine (Arch Linux / Omarchy). Steps
that need a human are marked **[HUMAN]**.

## Architecture

```
Oma's phone (Telegram) -> @HerBot
        |  long-poll (outbound only, no port forwarding, no static IP)
        v
oma-bridge (this repo, runs on the Omarchy machine)
        |  Letta Agent SDK (backend: cloud)
        v
Her agent on Letta Cloud (free tier, her own account)
        |  tools execute on this machine (BYOM)
        v
web search -> current Curacao/Dutch rules, sources cited
```

- **Agent state lives in Letta Cloud** - memory, history, skills. If this
  machine is off, her messages queue at Telegram and arrive when it comes back.
- **Free tier**: her own Letta account, BYOK model key. 2 questions/day is
  roughly $1-3/month in tokens.
- **One chat only**: the bridge rejects every Telegram chat ID except hers.

## Install runbook (Arch Linux / Omarchy)

### 0. Requirements

- Node.js 22+ (`sudo pacman -S nodejs npm` if missing)
- The four secrets listed in `.env.example` - see step 2

### 1. Place the repo

```
git clone <this-repo-url> ~/oma
cd ~/oma
npm install
```

### 2. Configure **[HUMAN]**

```
cp .env.example .env
```

Fill in:

| Variable | Where to get it |
| --- | --- |
| `LETTA_API_KEY` | Her free Letta account at platform.letta.com -> API keys. The account must also have a model provider key connected via BYOK. |
| `TELEGRAM_BOT_TOKEN` | [@BotFather](https://t.me/BotFather) -> `/newbot` |
| `OMA_TELEGRAM_CHAT_ID` | Her phone sends one message to [@userinfobot](https://t.me/userinfobot); it replies with the chat ID. |
| `OMA_AGENT_ID` | Leave empty now; step 3 fills it. |

`.env` is gitignored - it never leaves the machine.

### 3. Create her agent (once)

```
npm run create-agent
```

Prints `OMA_AGENT_ID=agent-...` - paste that line into `.env`.

### 4. Smoke test (no Telegram)

```
npm run check
```

Expected: a short Dutch greeting and `[OK] agent responded.`
If it fails, fix before proceeding - do not start the bridge on a broken setup.

### 5. Run as a systemd user service

```
mkdir -p ~/.config/systemd/user
cp scripts/oma-bridge.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now oma-bridge
```

Verify:

```
systemctl --user status oma-bridge
journalctl --user -u oma-bridge -f   # expect "oma-bridge started - bot is @..."
```

The service auto-starts at login and restarts on crash (10s backoff).
Omarchy must stay logged in; suspend pauses the bot until wake - queued
Telegram messages arrive then. Disable suspend-on-idle if the machine is a
dedicated always-on box.

### 6. End-to-end test **[HUMAN]**

From her phone, send the bot any question. It should answer within a minute.
Send a photo of a letter; the agent should read it.

## Operations

```
systemctl --user restart oma-bridge    # after .env changes
journalctl --user -u oma-bridge -f     # live logs
npm run check                          # test the agent without Telegram
```

## Per-client reuse

This whole repo is the template for the assistant-service idea: per client,
change only `.env` (bot token, chat ID, agent ID, API key). Nothing else.
