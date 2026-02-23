import { loadState } from "./store";
import { startPolling } from "./telegram/poller";
import { handleUpdate } from "./telegram/handler";
import { api } from "./telegram/api";
import { getActiveAgentCount, restoreAllSessions } from "./acp/session-manager";
import { handleApiRequest, restoreCrons } from "./http-api";

const botToken = process.env.TELEGRAM_BOT_TOKEN;
if (!botToken) {
  console.error("Missing TELEGRAM_BOT_TOKEN in .env");
  process.exit(1);
}

// Load file-based state
await loadState();

// Get bot info
const me = await api("getMe");
const botUsername = me.ok ? me.result.username : "unknown";
console.log(`Bot: @${botUsername}`);

// Create dirs
await Bun.$`mkdir -p ${process.cwd()}/threads`;
await Bun.$`mkdir -p ${process.cwd()}/files`;

// Register bot commands
await api("setMyCommands", {
  commands: [
    { command: "claude", description: "Start Claude agent: /claude <path>" },
    { command: "codex", description: "Start Codex agent: /codex <path>" },
    { command: "mode", description: "Set agent mode (default/plan/acceptEdits/bypassPermissions)" },
    { command: "model", description: "Set model (default/sonnet/haiku)" },
    { command: "clear", description: "Kill current agent session" },
    { command: "cancel", description: "Cancel running prompt" },
  ],
});

// Health HTTP server
const port = parseInt(process.env.HTTP_PORT || "3034");
Bun.serve({
  port,
  routes: {
    "/health": () =>
      Response.json({
        ok: true,
        bot: `@${botUsername}`,
        activeAgents: getActiveAgentCount(),
      }),
  },
  fetch(req) {
    return handleApiRequest(req);
  },
});
console.log(`Health server on :${port}`);

// Restore crons
restoreCrons().catch((err) => {
  console.error("[cron restore] Failed:", err);
});

// Restore active sessions
restoreAllSessions().catch((err) => {
  console.error("[restore] Failed:", err);
});

// Start polling
startPolling(handleUpdate);
