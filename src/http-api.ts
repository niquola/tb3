// REST API for skills running inside threads
// Skills call these endpoints to interact with Telegram

import { Cron } from "croner";
import { sendTelegramMessage, sendTelegramMessageChunked } from "./telegram/send";
import { api } from "./telegram/api";
import * as db from "./store";
import * as sessions from "./acp/session-manager";
import type { AgentType, SessionCallbacks, ToolCallInfo } from "./acp/types";

// Resolve thread from workdir (skills know their cwd, not chat_id)
function resolveThread(workdir?: string, chatId?: number): db.ThreadConfig | null {
  if (chatId) {
    return db.getThreadConfig(chatId, 0);
  }
  if (workdir) {
    return db.findThreadByWorkdir(workdir);
  }
  return null;
}

export async function handleApiRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // GET /api/threads — list all threads
  if (url.pathname === "/api/threads" && req.method === "GET") {
    return Response.json({ ok: true, threads: db.getAllThreads() });
  }

  // GET /api/thread?workdir=/path — find thread by workdir
  if (url.pathname === "/api/thread" && req.method === "GET") {
    const workdir = url.searchParams.get("workdir");
    if (!workdir) return Response.json({ ok: false, error: "workdir required" }, { status: 400 });
    const thread = db.findThreadByWorkdir(workdir);
    if (!thread) return Response.json({ ok: false, error: "thread not found" }, { status: 404 });
    return Response.json({ ok: true, thread });
  }

  // POST /api/send — send message to thread's chat
  // body: { text, workdir?, chat_id?, format? }
  if (url.pathname === "/api/send" && req.method === "POST") {
    try {
      const body = await req.json();
      const { text, workdir, chat_id, format, parse_mode } = body;
      if (!text) return Response.json({ ok: false, error: "text required" }, { status: 400 });

      const thread = resolveThread(workdir, chat_id);
      if (!thread) return Response.json({ ok: false, error: "thread not found. Provide workdir or chat_id" }, { status: 404 });

      // Raw parse_mode (HTML/MarkdownV2) — send directly via Telegram API
      if (parse_mode) {
        const payload: any = {
          chat_id: thread.chat_id,
          text,
          parse_mode,
        };
        if (thread.thread_id) payload.message_thread_id = thread.thread_id;
        const rawRes = await api("sendMessage", payload);
        return Response.json({ ok: rawRes.ok, message_id: rawRes.result?.message_id });
      }

      const res = await sendTelegramMessage(thread.chat_id, text, {
        format: format !== false,
        message_thread_id: thread.thread_id || undefined,
      });
      return Response.json({ ok: res.ok, message_id: res.messageId });
    } catch (err) {
      return Response.json({ ok: false, error: String(err) }, { status: 500 });
    }
  }

  // POST /api/send-file — send file to thread's chat
  if (url.pathname === "/api/send-file" && req.method === "POST") {
    try {
      const contentType = req.headers.get("content-type") || "";

      let chatId: number;
      let threadId: number | undefined;
      let filePath: string | undefined;
      let fileData: Blob | undefined;
      let fileName: string | undefined;
      let caption: string | undefined;

      if (contentType.includes("multipart/form-data")) {
        const form = await req.formData();
        const workdir = form.get("workdir") as string | null;
        const chatIdStr = form.get("chat_id") as string | null;
        caption = (form.get("caption") as string) || undefined;
        const file = form.get("file") as File | null;

        const thread = resolveThread(workdir || undefined, chatIdStr ? Number(chatIdStr) : undefined);
        if (!thread) return Response.json({ ok: false, error: "thread not found" }, { status: 404 });
        chatId = thread.chat_id;
        threadId = thread.thread_id || undefined;

        if (file) {
          fileData = file;
          fileName = file.name;
        }
      } else {
        const body = await req.json();
        const thread = resolveThread(body.workdir, body.chat_id);
        if (!thread) return Response.json({ ok: false, error: "thread not found" }, { status: 404 });
        chatId = thread.chat_id;
        threadId = thread.thread_id || undefined;
        filePath = body.file_path;
        caption = body.caption;
      }

      if (filePath) {
        const file = Bun.file(filePath);
        if (!(await file.exists())) {
          return Response.json({ ok: false, error: `file not found: ${filePath}` }, { status: 404 });
        }
        fileData = file;
        fileName = filePath.split("/").pop();
      }

      if (!fileData || !fileName) {
        return Response.json({ ok: false, error: "file or file_path required" }, { status: 400 });
      }

      const form = new FormData();
      form.append("chat_id", String(chatId));
      form.append("document", fileData, fileName);
      if (caption) form.append("caption", caption);
      if (threadId) form.append("message_thread_id", String(threadId));

      const token = process.env.TELEGRAM_BOT_TOKEN!;
      const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
        method: "POST",
        body: form,
      });
      const json = await res.json() as any;
      return Response.json({ ok: json.ok, message_id: json.result?.message_id });
    } catch (err) {
      return Response.json({ ok: false, error: String(err) }, { status: 500 });
    }
  }

  // POST /api/cron — schedule a message
  // body: { cron, text, workdir?, chat_id?, name? }
  if (url.pathname === "/api/cron" && req.method === "POST") {
    try {
      const body = await req.json();
      const { cron: cronExpr, text, workdir, chat_id, name } = body;
      if (!cronExpr || !text) return Response.json({ ok: false, error: "cron and text required" }, { status: 400 });

      const thread = resolveThread(workdir, chat_id);
      if (!thread) return Response.json({ ok: false, error: "thread not found" }, { status: 404 });

      const id = await addCronJob(name || `cron-${Date.now()}`, cronExpr, thread.chat_id, text, thread.thread_id || undefined);
      const job = liveCrons.get(id);
      return Response.json({
        ok: true,
        id,
        next: job?.cron.nextRun()?.toISOString(),
      });
    } catch (err) {
      return Response.json({ ok: false, error: String(err) }, { status: 500 });
    }
  }

  // GET /api/crons — list scheduled crons
  if (url.pathname === "/api/crons" && req.method === "GET") {
    return Response.json({ ok: true, crons: listCronJobs() });
  }

  // DELETE /api/cron/:id — remove a cron
  if (url.pathname.startsWith("/api/cron/") && req.method === "DELETE") {
    const id = url.pathname.slice("/api/cron/".length);
    const removed = await removeCronJob(id);
    return Response.json({ ok: removed });
  }

  // POST /api/prompt — trigger agent with a prompt
  // body: { text, workdir?, chat_id?, thread_id? }
  if (url.pathname === "/api/prompt" && req.method === "POST") {
    try {
      const body = await req.json();
      const { text, workdir, chat_id, thread_id } = body;
      if (!text) return Response.json({ ok: false, error: "text required" }, { status: 400 });

      let thread: db.ThreadConfig | null = null;
      if (chat_id && thread_id) {
        thread = db.getThreadConfig(chat_id, thread_id);
      } else {
        thread = resolveThread(workdir, chat_id);
      }
      if (!thread) return Response.json({ ok: false, error: "thread not found" }, { status: 404 });

      const chatId = thread.chat_id;
      const threadId = thread.thread_id || 0;

      // Run agent in background, return immediately
      runAgentPrompt(chatId, threadId, text, thread.workdir, thread.agent_type as AgentType);

      return Response.json({ ok: true, chat_id: chatId, thread_id: threadId });
    } catch (err) {
      return Response.json({ ok: false, error: String(err) }, { status: 500 });
    }
  }

  return new Response("Not found", { status: 404 });
}

// --- Run agent prompt and stream to Telegram ---

async function runAgentPrompt(chatId: number, threadId: number, text: string, workdir: string, agentType: AgentType): Promise<void> {
  let buffer = "";
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flush = async () => {
    if (!buffer) return;
    const t = buffer;
    buffer = "";
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    await sendTelegramMessageChunked(chatId, t, {
      message_thread_id: threadId || undefined,
    });
  };

  const callbacks: SessionCallbacks = {
    onTextChunk: async (text: string) => {
      buffer += text;
      if (flushTimer) clearTimeout(flushTimer);
      if (buffer.length > 3500) {
        await flush();
      } else {
        flushTimer = setTimeout(() => flush(), 800);
      }
    },
    onToolCall: async (_info: ToolCallInfo) => {},
    onToolCallUpdate: async (_info: ToolCallInfo) => {},
    onPermissionRequest: async (params: any) => {
      const allowOption = params.options?.find((o: any) => o.kind === "allow_once");
      const fallback = params.options?.[0];
      const option = allowOption || fallback;
      return { outcome: { outcome: "selected", optionId: option?.optionId || "allow" } };
    },
  };

  try {
    const result = await sessions.sendPrompt(chatId, threadId, text, agentType, callbacks, workdir);
    await flush();
    console.log(`[prompt] agent done: ${result.stopReason}`);
  } catch (err) {
    await flush();
    console.error(`[prompt] agent error:`, err);
    await sendTelegramMessage(chatId, `Error: ${String(err)}`, { format: false, message_thread_id: threadId || undefined });
  }
}

// --- Cron scheduler with croner + persistence ---

type CronDef = {
  name: string;
  cron: string;
  chatId: number;
  threadId?: number;
  text: string;
};

type LiveCron = CronDef & {
  cron_instance: Cron;
};

// In-memory live crons
const liveCrons = new Map<string, { cron: Cron; def: CronDef }>();

// Persistence file
const CRONS_PATH = `${process.cwd()}/threads/.crons.json`;

async function loadCronDefs(): Promise<Record<string, CronDef>> {
  try {
    const file = Bun.file(CRONS_PATH);
    if (await file.exists()) {
      return await file.json();
    }
  } catch {}
  return {};
}

async function saveCronDefs(): Promise<void> {
  const defs: Record<string, CronDef> = {};
  for (const [id, { def }] of liveCrons) {
    defs[id] = def;
  }
  await Bun.write(CRONS_PATH, JSON.stringify(defs, null, 2));
}

function startCron(id: string, def: CronDef): void {
  // Stop existing if any
  liveCrons.get(id)?.cron.stop();

  const job = new Cron(def.cron, async () => {
    try {
      console.log(`[cron] ${id}: triggering agent for chat ${def.chatId}`);
      const config = db.getThreadConfig(def.chatId, def.threadId || 0);
      if (!config) {
        console.error(`[cron] ${id}: no thread config for chat ${def.chatId}`);
        await sendTelegramMessage(def.chatId, def.text, { format: false, message_thread_id: def.threadId });
        return;
      }

      // Stream agent response to Telegram
      let buffer = "";
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      const toolMessages = new Map<string, number>();

      const flush = async () => {
        if (!buffer) return;
        const text = buffer;
        buffer = "";
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        await sendTelegramMessageChunked(def.chatId, text, {
          message_thread_id: def.threadId || undefined,
        });
      };

      const callbacks: SessionCallbacks = {
        onTextChunk: async (text: string) => {
          buffer += text;
          if (flushTimer) clearTimeout(flushTimer);
          if (buffer.length > 3500) {
            await flush();
          } else {
            flushTimer = setTimeout(() => flush(), 800);
          }
        },
        onToolCall: async (info: ToolCallInfo) => {
          if (info.status === "completed") return;
        },
        onToolCallUpdate: async (_info: ToolCallInfo) => {},
        onPermissionRequest: async (params: any) => {
          // Auto-allow for cron jobs
          const allowOption = params.options?.find((o: any) => o.kind === "allow_once");
          const fallback = params.options?.[0];
          const option = allowOption || fallback;
          return { outcome: { outcome: "selected", optionId: option?.optionId || "allow" } };
        },
      };

      const result = await sessions.sendPrompt(
        def.chatId,
        def.threadId || 0,
        def.text,
        config.agent_type as AgentType,
        callbacks,
        config.workdir
      );

      await flush();
      console.log(`[cron] ${id}: agent done: ${result.stopReason}`);
    } catch (err) {
      console.error(`[cron] ${id} error:`, err);
    }
  });

  liveCrons.set(id, { cron: job, def });
  const next = job.nextRun();
  console.log(`[cron] started ${id}: "${def.cron}" -> chat ${def.chatId}, next: ${next?.toISOString()}`);
}

async function addCronJob(name: string, cronExpr: string, chatId: number, text: string, threadId?: number): Promise<string> {
  // Validate cron expression
  try {
    new Cron(cronExpr, { maxRuns: 0 }); // dry run to validate
  } catch (err) {
    throw new Error(`Invalid cron expression "${cronExpr}": ${err}`);
  }

  const def: CronDef = { name, cron: cronExpr, chatId, threadId, text };
  startCron(name, def);
  await saveCronDefs();
  return name;
}

async function removeCronJob(id: string): Promise<boolean> {
  const entry = liveCrons.get(id);
  if (!entry) return false;
  entry.cron.stop();
  liveCrons.delete(id);
  await saveCronDefs();
  console.log(`[cron] removed ${id}`);
  return true;
}

function listCronJobs(): Array<{ id: string; name: string; cron: string; chatId: number; next: string | null }> {
  return Array.from(liveCrons.entries()).map(([id, { cron, def }]) => ({
    id,
    name: def.name,
    cron: def.cron,
    chatId: def.chatId,
    next: cron.nextRun()?.toISOString() || null,
  }));
}

// Restore crons on startup
export async function restoreCrons(): Promise<void> {
  const defs = await loadCronDefs();
  const count = Object.keys(defs).length;
  if (count === 0) {
    console.log("[cron] No saved crons");
    return;
  }
  console.log(`[cron] Restoring ${count} crons...`);
  for (const [id, def] of Object.entries(defs)) {
    try {
      startCron(id, def);
    } catch (err) {
      console.error(`[cron] Failed to restore ${id}:`, err);
    }
  }
}
