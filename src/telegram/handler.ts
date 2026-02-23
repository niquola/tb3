import { api, deleteMessage, sendTyping } from "./api";
import { sendTelegramMessage, sendTelegramMessageChunked } from "./send";
import * as sessions from "../acp/session-manager";
import * as db from "../store";
import type { AgentType, SessionCallbacks, ToolCallInfo } from "../acp/types";

const allowedUserId = process.env.TELEGRAM_ALLOWED_USER || "";
const SKILLS_DIR = `${process.cwd()}/skills`;

async function linkSkills(workdir: string): Promise<void> {
  try {
    const skillsTarget = `${workdir}/.claude/skills`;
    await Bun.$`mkdir -p ${skillsTarget}`;

    // Scan available skills and create symlinks
    const glob = new Bun.Glob("*");
    for await (const name of glob.scan({ cwd: SKILLS_DIR, onlyFiles: false })) {
      const link = `${skillsTarget}/${name}`;
      const target = `${SKILLS_DIR}/${name}`;
      try {
        await Bun.$`ln -sfn ${target} ${link}`;
      } catch {}
    }
  } catch (err) {
    console.error(`[skills] Failed to link skills to ${workdir}:`, err);
  }
}

// --- Permission Request Queue ---
let permCounter = 0;
// Map permId -> { resolve, options, timeout }
const pendingPermissions = new Map<
  number,
  { resolve: (optionId: string) => void; options: any[]; timeout: ReturnType<typeof setTimeout>; params: any; workdir: string }
>();

const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;

const TOOL_ICONS: Record<string, string> = {
  read: "📖",
  edit: "✏️",
  delete: "🗑️",
  move: "📦",
  search: "🔍",
  execute: "⚡",
  think: "🤔",
  fetch: "🌐",
  other: "🔧",
};

// --- Text Accumulator ---
class TextAccumulator {
  private buffer = "";
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private chatId: number,
    private threadId: number,
    private debounceMs = 800
  ) {}

  async append(text: string): Promise<void> {
    this.buffer += text;
    if (this.flushTimer) clearTimeout(this.flushTimer);

    if (this.buffer.length > 3500) {
      await this.flush();
    } else {
      this.flushTimer = setTimeout(() => this.flush(), this.debounceMs);
    }
  }

  async flush(): Promise<void> {
    if (!this.buffer) return;
    const text = this.buffer;
    this.buffer = "";
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await sendTelegramMessageChunked(this.chatId, text, {
      message_thread_id: this.threadId || undefined,
    });
  }
}

// --- Tool Call Tracker ---
class ToolCallTracker {
  private toolMessages = new Map<string, number>(); // toolCallId -> messageId

  constructor(
    private chatId: number,
    private threadId: number
  ) {}

  private formatToolText(info: ToolCallInfo): string {
    const icon = TOOL_ICONS[info.kind || "other"] || "🔧";

    // For execute/bash tools, show the command as a code block
    if (info.kind === "execute") {
      const cmd = info.rawInput
        ? (typeof info.rawInput === "string"
            ? info.rawInput
            : (info.rawInput as any).command || (info.rawInput as any).cmd || "")
        : "";

      if (cmd) {
        const short = cmd.length > 200 ? cmd.slice(0, 200) + "..." : cmd;
        return `${icon}\n\`\`\`bash\n${short}\n\`\`\``;
      }

      // Title IS the command (not generic "Terminal"/"Bash")
      const title = info.title || "";
      if (title && !["Terminal", "Bash", "Execute", "terminal", "bash"].includes(title)) {
        const short = title.length > 200 ? title.slice(0, 200) + "..." : title;
        return `${icon}\n\`\`\`bash\n${short}\n\`\`\``;
      }

      return `${icon} ${title || "Terminal"}`;
    }

    return `${icon} ${info.title}`;
  }

  private isGenericTitle(title: string): boolean {
    return ["Terminal", "Bash", "Execute", "terminal", "bash", "execute"].includes(title);
  }

  async onToolCall(info: ToolCallInfo): Promise<void> {
    // Don't show messages for already-completed tools (from session replay)
    if (info.status === "completed") return;

    // For generic titles like "Terminal" — don't show yet, wait for update with actual command
    if (this.isGenericTitle(info.title)) {
      // Just register the tool call ID so we can post when the command arrives
      this.toolMessages.set(info.toolCallId, 0); // 0 = placeholder, no message sent yet
      return;
    }

    const text = this.formatToolText(info);
    const res = await sendTelegramMessage(this.chatId, text, {
      message_thread_id: this.threadId || undefined,
    });
    if (res.messageId) {
      this.toolMessages.set(info.toolCallId, res.messageId);
    }
  }

  async onUpdate(info: ToolCallInfo): Promise<void> {
    if (info.status === "completed") {
      const msgId = this.toolMessages.get(info.toolCallId);
      if (msgId && msgId > 0) {
        await deleteMessage(this.chatId, msgId);
      }
      this.toolMessages.delete(info.toolCallId);
    } else if (info.status === "failed") {
      const msgId = this.toolMessages.get(info.toolCallId);
      if (msgId && msgId > 0) {
        await deleteMessage(this.chatId, msgId);
      }
      this.toolMessages.delete(info.toolCallId);
      const title = info.title || "Tool call";
      let errText = `❌ ${title} failed`;
      if (info.rawOutput) {
        const out = typeof info.rawOutput === "string"
          ? info.rawOutput
          : JSON.stringify(info.rawOutput);
        const short = out.length > 500 ? out.slice(0, 500) + "..." : out;
        errText += `\n\`\`\`\n${short}\n\`\`\``;
      }
      await sendTelegramMessage(this.chatId, errText, {
        message_thread_id: this.threadId || undefined,
      });
    } else {
      // Intermediate update — post the actual command if we deferred earlier
      const msgId = this.toolMessages.get(info.toolCallId);
      if (msgId === 0 && info.title && !this.isGenericTitle(info.title)) {
        // Deferred "Terminal" — now we have the real command, send it
        const short = info.title.length > 200 ? info.title.slice(0, 200) + "..." : info.title;
        const text = `⚡\n\`\`\`bash\n${short}\n\`\`\``;
        const res = await sendTelegramMessage(this.chatId, text, {
          message_thread_id: this.threadId || undefined,
        });
        if (res.messageId) {
          this.toolMessages.set(info.toolCallId, res.messageId);
        }
      }
    }
  }

  async cleanup(): Promise<void> {
    for (const [, msgId] of this.toolMessages) {
      await deleteMessage(this.chatId, msgId);
    }
    this.toolMessages.clear();
  }
}

// --- Tool Permission Persistence ---

async function saveToolPermission(workdir: string, params: any, optionKind: string): Promise<void> {
  if (optionKind !== "allow_always") return;

  const toolName = params.toolCall?.tool || params.toolCall?.title || "";
  if (!toolName) return;

  const settingsPath = `${workdir}/.claude/settings.json`;
  let settings: any = {};
  try {
    const file = Bun.file(settingsPath);
    if (await file.exists()) {
      settings = await file.json();
    }
  } catch {}

  if (!settings.permissions) settings.permissions = { allow: [], deny: [] };
  if (!settings.permissions.allow) settings.permissions.allow = [];

  const pattern = `${toolName}(*)`;
  if (!settings.permissions.allow.includes(pattern)) {
    settings.permissions.allow.push(pattern);
    await Bun.$`mkdir -p ${workdir}/.claude`;
    await Bun.write(settingsPath, JSON.stringify(settings, null, 2));
    console.log(`[perm] saved ${pattern} to ${settingsPath}`);
  }
}

// --- Permission via Telegram ---

async function requestPermissionViaTelegram(
  chatId: number,
  threadId: number,
  params: any,
  workdir: string
): Promise<any> {
  const title = params.toolCall?.title || "Tool operation";
  const options = params.options || [];
  const id = ++permCounter;

  // Short callback_data: "p:ID:INDEX" (e.g. "p:1:0", "p:1:1", "p:1:2")
  const keyboard = options.map((opt: any, i: number) => [{
    text: `${opt.kind === "allow_once" ? "✅" : opt.kind === "reject_once" ? "❌" : "🔄"} ${opt.name || opt.kind}`,
    callback_data: `p:${id}:${i}`,
  }]);

  console.log(`[perm] #${id} requesting: ${title} (${options.map((o: any) => o.optionId).join(", ")})`);

  await sendTelegramMessage(chatId, `🔐 Permission: ${title}`, {
    message_thread_id: threadId || undefined,
    format: false,
    reply_markup: { inline_keyboard: keyboard },
  });

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      console.log(`[perm] #${id} timed out, auto-rejecting`);
      const rejectOption = options.find((o: any) => o.kind === "reject_once");
      const fallback = rejectOption?.optionId || options[0]?.optionId || "reject";
      resolve({ outcome: { outcome: "selected", optionId: fallback } });
      pendingPermissions.delete(id);
    }, PERMISSION_TIMEOUT_MS);

    pendingPermissions.set(id, {
      resolve: (optionId: string) => {
        clearTimeout(timeout);
        resolve({ outcome: { outcome: "selected", optionId } });
      },
      options,
      timeout,
      params,
      workdir,
    });
  });
}

// --- Callback Query Handler ---

function handleCallbackQuery(query: any): void {
  const data = query.data as string;
  const chatId = query.message?.chat?.id;
  const threadId = query.message?.message_thread_id || 0;

  // Mode selection: "m:modeId"
  if (data.startsWith("m:") && chatId) {
    const modeId = data.slice(2);
    const config = db.getThreadConfig(chatId, threadId);
    const label = config?.name || "";
    // Answer immediately so Telegram stops showing loading spinner
    api("answerCallbackQuery", { callback_query_id: query.id, text: `mode: ${modeId}` });
    if (query.message) deleteMessage(chatId, query.message.message_id);
    sessions.setMode(chatId, threadId, modeId)
      .then(() => {
        sendTelegramMessage(chatId, `[${label}] mode: ${modeId}`, { format: false, message_thread_id: threadId || undefined });
      })
      .catch((err) => {
        sendTelegramMessage(chatId, `Failed to set mode: ${err}`, { format: false, message_thread_id: threadId || undefined });
      });
    return;
  }

  // Direct model selection: "md:modelId"
  if (data.startsWith("md:") && chatId) {
    const modelId = data.slice(3);
    const config = db.getThreadConfig(chatId, threadId);
    const label = config?.name || "";
    // Answer immediately so Telegram stops showing loading spinner
    api("answerCallbackQuery", { callback_query_id: query.id, text: `model: ${modelId}` });
    if (query.message) deleteMessage(chatId, query.message.message_id);
    sessions.setModel(chatId, threadId, modelId)
      .then(() => {
        sendTelegramMessage(chatId, `[${label}] model: ${modelId}`, { format: false, message_thread_id: threadId || undefined });
      })
      .catch((err) => {
        sendTelegramMessage(chatId, `Failed to set model: ${err}`, { format: false, message_thread_id: threadId || undefined });
      });
    return;
  }

  if (!data.startsWith("p:")) return;

  const parts = data.split(":");
  const permId = parseInt(parts[1]);
  const optionIndex = parseInt(parts[2]);

  console.log(`[perm] callback: permId=${permId} optionIndex=${optionIndex}`);

  const pending = pendingPermissions.get(permId);
  if (pending) {
    const option = pending.options[optionIndex];
    const optionId = option?.optionId;
    const optionName = option?.name || optionId;
    const optionKind = option?.kind;
    console.log(`[perm] #${permId} resolved: ${optionId} (${optionKind})`);
    pending.resolve(optionId);
    pendingPermissions.delete(permId);

    // Persist "allow always" to .claude/settings.json in workdir
    if (optionKind === "allow_always" && pending.workdir) {
      saveToolPermission(pending.workdir, pending.params, optionKind).catch(console.error);
    }

    api("answerCallbackQuery", { callback_query_id: query.id, text: optionName });
    // Delete the permission message
    if (query.message) {
      deleteMessage(query.message.chat.id, query.message.message_id);
    }
  } else {
    console.log(`[perm] #${permId} not found in pending map`);
    api("answerCallbackQuery", { callback_query_id: query.id, text: "Expired" });
    if (query.message) {
      deleteMessage(query.message.chat.id, query.message.message_id);
    }
  }
}

// --- Main Update Handler ---

export async function handleUpdate(update: any): Promise<void> {
  // Handle callback queries (permission responses)
  if (update.callback_query) {
    handleCallbackQuery(update.callback_query);
    return;
  }

  const msg = update.message;
  if (!msg) return;

  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id || 0;
  const rawText = msg.text || msg.caption || "";
  // Strip @botname from commands (e.g. /mode@niquola_cbot -> /mode)
  const text = rawText.replace(/^(\/\w+)@\w+/, "$1");
  const fromId = msg.from?.id;
  const fromName = msg.from?.first_name || msg.from?.username || "Unknown";

  console.log(`[msg] chat=${chatId} thread=${threadId} type=${msg.chat.type} from=${fromId} text="${text.slice(0, 50)}" topic=${msg.reply_to_message?.forum_topic_created?.name || "-"}`);

  // Only work in private chats (DM)
  if (msg.chat.type !== "private") return;

  // Authorization
  if (allowedUserId && String(fromId) !== allowedUserId) {
    await sendTelegramMessage(chatId, "Вы кто такие? Я вас не знаю!", {
      message_thread_id: threadId || undefined,
      replyToMessageId: msg.message_id,
    });
    return;
  }

  // Log user message
  await db.saveMessage({
    chat_id: chatId,
    thread_id: threadId,
    message_id: msg.message_id,
    from_id: fromId,
    from_name: fromName,
    role: "user",
    content: text,
  }).catch(console.error);

  // Commands
  if (text === "/start") {
    await sendTelegramMessage(chatId, "tb3 ready. Send a message to start coding.", {
      message_thread_id: threadId || undefined,
    });
    return;
  }

  if (text === "/stop" || text === "/exit") {
    const stopped = sessions.stopAgent(chatId, threadId);
    await sendTelegramMessage(chatId, stopped ? "Agent stopped. Use /claude --resume to continue." : "No active session.", {
      message_thread_id: threadId || undefined,
      format: false,
    });
    return;
  }

  if (text === "/clear") {
    const killed = sessions.killAgent(chatId, threadId);
    await sendTelegramMessage(chatId, killed ? "Session cleared. Next /claude starts fresh." : "No active session.", {
      message_thread_id: threadId || undefined,
      format: false,
    });
    return;
  }

  if (text === "/cancel") {
    const cancelled = await sessions.cancelPrompt(chatId, threadId);
    await sendTelegramMessage(chatId, cancelled ? "Cancelling..." : "Nothing to cancel.", {
      message_thread_id: threadId || undefined,
    });
    return;
  }

  // /mode [id] — show or set agent mode (plan, code, ask, etc.)
  if (text === "/mode" || text.startsWith("/mode ")) {
    const config = db.getThreadConfig(chatId, threadId);
    const info = sessions.getSessionInfo(chatId, threadId);
    console.log(`[/mode] chatId=${chatId} threadId=${threadId} config=${!!config} info=${!!info} modes=${!!info?.modes}`);
    if (!info?.modes || !config) {
      await sendTelegramMessage(chatId, "No active agent. Start with /claude first.", { format: false, message_thread_id: threadId || undefined });
      return;
    }
    const label = config.name || config.workdir;
    const arg = text.replace(/^\/mode\s*/, "").trim();
    if (arg) {
      try {
        await sessions.setMode(chatId, threadId, arg);
        await sendTelegramMessage(chatId, `[${label}] mode: ${arg}`, { format: false, message_thread_id: threadId || undefined });
      } catch (err) {
        await sendTelegramMessage(chatId, `Failed: ${err}`, { format: false, message_thread_id: threadId || undefined });
      }
    } else {
      const modes = info.modes.availableModes || [];
      const current = info.modes.currentModeId;
      const keyboard = modes.map((m) => [{
        text: `${m.id === current ? "● " : ""}${m.name || m.id}`,
        callback_data: `m:${m.id}`,
      }]);
      await sendTelegramMessage(chatId, `[${label}] mode: ${current}`, {
        format: false,
        message_thread_id: threadId || undefined,
        reply_markup: { inline_keyboard: keyboard },
      });
    }
    return;
  }

  // /model [id] — show or set model
  if (text === "/model" || text.startsWith("/model ")) {
    const config = db.getThreadConfig(chatId, threadId);
    const info = sessions.getSessionInfo(chatId, threadId);
    console.log(`[/model] chatId=${chatId} threadId=${threadId} config=${!!config} info=${!!info} models=${!!info?.models}`);
    if (!info?.models || !config) {
      await sendTelegramMessage(chatId, "No active agent. Start with /claude first.", { format: false, message_thread_id: threadId || undefined });
      return;
    }
    const label = config.name || config.workdir;
    const arg = text.replace(/^\/model\s*/, "").trim();
    if (arg) {
      try {
        await sessions.setModel(chatId, threadId, arg);
        await sendTelegramMessage(chatId, `[${label}] model: ${arg}`, { format: false, message_thread_id: threadId || undefined });
      } catch (err) {
        await sendTelegramMessage(chatId, `Failed: ${err}`, { format: false, message_thread_id: threadId || undefined });
      }
    } else {
      const models = info.models.availableModels || [];
      const current = info.models.currentModelId;
      const keyboard = models.map((m: any) => [{
        text: `${(m.modelId || m.id) === current ? "● " : ""}${m.name || m.modelId || m.id}`,
        callback_data: `md:${m.modelId || m.id}`,
      }]);
      await sendTelegramMessage(chatId, `[${label}] model: ${current || "default"}`, {
        format: false,
        message_thread_id: threadId || undefined,
        reply_markup: { inline_keyboard: keyboard },
      });
    }
    return;
  }

  // /claude [--resume | path] — start/resume agent
  if (text.startsWith("/claude") || text.startsWith("/codex")) {
    const agentType = text.startsWith("/claude") ? "claude" : "codex";
    const rawArgs = text.replace(/^\/(claude|codex)\s*/, "").trim();

    // --resume: resume stopped session
    if (rawArgs === "--resume" || rawArgs === "-r") {
      const config = db.getThreadConfig(chatId, threadId);
      if (!config) {
        await sendTelegramMessage(chatId, "No thread config. Start with /claude <path> first.", { format: false, message_thread_id: threadId || undefined });
        return;
      }

      const silentCallbacks: SessionCallbacks = {
        onTextChunk: async () => {},
        onToolCall: async () => {},
        onToolCallUpdate: async () => {},
        onPermissionRequest: async (params: any) => {
          const options = params.options || [];
          const opt = options.find((o: any) => o.kind === "allow_always") || options[0];
          return { outcome: { outcome: "selected", optionId: opt?.optionId || "allow" } };
        },
      };

      try {
        const { resumed, sessionId } = await sessions.resumeAgent(
          chatId, threadId, config.agent_type as AgentType, silentCallbacks, config.workdir
        );
        const label = config.name || config.workdir;
        await sendTelegramMessage(chatId,
          resumed
            ? `[${label}] resumed session ${sessionId.slice(0, 8)}...`
            : `[${label}] previous session not found, started fresh`,
          { format: false, message_thread_id: threadId || undefined }
        );
      } catch (err) {
        await sendTelegramMessage(chatId, `Resume failed: ${err}`, { format: false, message_thread_id: threadId || undefined });
      }
      return;
    }

    if (rawArgs) {
      // Set new workdir + fresh session
      let folderPath: string;
      if (rawArgs === "system") {
        folderPath = process.cwd(); // project root
      } else if (rawArgs.startsWith("~/")) {
        folderPath = rawArgs.replace("~", process.env.HOME || "~");
      } else if (rawArgs.startsWith("/")) {
        folderPath = rawArgs;
      } else {
        folderPath = `${process.cwd()}/threads/${rawArgs}`;
      }

      await Bun.$`mkdir -p ${folderPath}`;

      // Create CLAUDE.md if not exists
      const claudeMd = `${folderPath}/CLAUDE.md`;
      try {
        if (!(await Bun.file(claudeMd).exists())) {
          await Bun.write(claudeMd, "");
        }
      } catch {}

      // Link shared skills
      await linkSkills(folderPath);

      // Kill existing agent + clear session (fresh start)
      sessions.killAgent(chatId, threadId);

      await db.saveThreadConfig({
        chat_id: chatId,
        thread_id: threadId,
        workdir: folderPath,
        agent_type: agentType,
        name: rawArgs,
      });

      await sendTelegramMessage(chatId, `${agentType} ready\nworkdir: ${folderPath}`, { format: false, message_thread_id: threadId || undefined });
    } else {
      // No args — show current config or usage
      const config = db.getThreadConfig(chatId, threadId);
      if (config) {
        const saved = db.getAcpSession(chatId, threadId);
        const hasSession = saved?.session_id ? ` (session: ${saved.session_id.slice(0, 8)}...)` : "";
        const status = saved?.active ? "active" : saved?.session_id ? "stopped" : "no session";
        await sendTelegramMessage(chatId, `${config.agent_type} [${status}]${hasSession}\nworkdir: ${config.workdir}`, { format: false, message_thread_id: threadId || undefined });
      } else {
        await sendTelegramMessage(chatId, `Usage: /claude <path>\nExamples:\n  /claude health\n  /claude ~/myrepo\n  /claude --resume\n  /codex myproject`, { format: false, message_thread_id: threadId || undefined });
      }
    }
    return;
  }

  if (!text || text.startsWith("/")) return;

  // --- Regular message → send to ACP agent ---
  const config = db.getThreadConfig(chatId, threadId);
  if (!config) {
    await sendTelegramMessage(chatId, `No agent. Start with:\n  /claude health\n  /claude ~/myrepo`, { format: false, message_thread_id: threadId || undefined });
    return;
  }

  // Send typing indicator
  sendTyping(chatId);

  const accumulator = new TextAccumulator(chatId, threadId);
  const toolTracker = new ToolCallTracker(chatId, threadId);

  const callbacks: SessionCallbacks = {
    onTextChunk: async (text: string) => {
      await accumulator.append(text);
    },
    onToolCall: async (info: ToolCallInfo) => {
      await toolTracker.onToolCall(info);
    },
    onToolCallUpdate: async (info: ToolCallInfo) => {
      await toolTracker.onUpdate(info);
    },
    onPermissionRequest: async (params: any) => {
      return requestPermissionViaTelegram(chatId, threadId, params, config.workdir);
    },
  };

  try {
    const result = await sessions.sendPrompt(
      chatId,
      threadId,
      text,
      config.agent_type as AgentType,
      callbacks,
      config.workdir
    );

    // Flush any remaining text
    await accumulator.flush();
    await toolTracker.cleanup();

    console.log(`[agent] done: ${result.stopReason}`);
  } catch (err) {
    await accumulator.flush();
    await toolTracker.cleanup();
    console.error(`[agent] error:`, err);
    await sendTelegramMessage(chatId, `Error: ${String(err)}`, { format: false, message_thread_id: threadId || undefined });
  }
}
