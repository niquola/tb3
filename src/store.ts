// File-based state: threads/.state.json
// Replaces PostgreSQL db.ts — single JSON file for all state

const STATE_PATH = `${process.cwd()}/threads/.state.json`;

export type ThreadState = {
  workdir: string;
  agent_type: string;
  name: string;
  session_id?: string;
  active?: boolean;
  mode?: string;
  model?: string;
};

type State = {
  threads: Record<string, ThreadState>; // key: "chatId:threadId"
};

let state: State = { threads: {} };

function key(chatId: number, threadId: number): string {
  return `${chatId}:${threadId}`;
}

export async function loadState(): Promise<void> {
  try {
    const file = Bun.file(STATE_PATH);
    if (await file.exists()) {
      state = await file.json();
      if (!state.threads) state.threads = {};
    }
  } catch (err) {
    console.error("[store] Failed to load state, starting fresh:", err);
    state = { threads: {} };
  }
  console.log(`[store] Loaded ${Object.keys(state.threads).length} threads`);
}

async function save(): Promise<void> {
  await Bun.write(STATE_PATH, JSON.stringify(state, null, 2));
}

// --- Thread Config ---

export type ThreadConfig = {
  chat_id: number;
  thread_id: number;
  workdir: string;
  agent_type: string;
  name: string;
};

export function getThreadConfig(chatId: number, threadId: number): ThreadConfig | null {
  const t = state.threads[key(chatId, threadId)];
  if (!t) return null;
  return { chat_id: chatId, thread_id: threadId, workdir: t.workdir, agent_type: t.agent_type, name: t.name };
}

export async function saveThreadConfig(config: ThreadConfig): Promise<void> {
  const k = key(config.chat_id, config.thread_id);
  const existing = state.threads[k];
  state.threads[k] = {
    ...existing,
    workdir: config.workdir,
    agent_type: config.agent_type,
    name: config.name,
  };
  await save();
}

export async function setAgentType(chatId: number, threadId: number, agentType: string): Promise<void> {
  const k = key(chatId, threadId);
  if (state.threads[k]) {
    state.threads[k].agent_type = agentType;
    await save();
  }
}

export async function setWorkdir(chatId: number, threadId: number, workdir: string): Promise<void> {
  const k = key(chatId, threadId);
  if (state.threads[k]) {
    state.threads[k].workdir = workdir;
    await save();
  }
}

export async function setModePref(chatId: number, threadId: number, mode: string): Promise<void> {
  const k = key(chatId, threadId);
  if (state.threads[k]) {
    state.threads[k].mode = mode;
    await save();
  }
}

export async function setModelPref(chatId: number, threadId: number, model: string): Promise<void> {
  const k = key(chatId, threadId);
  if (state.threads[k]) {
    state.threads[k].model = model;
    await save();
  }
}

export function getModePref(chatId: number, threadId: number): string | undefined {
  return state.threads[key(chatId, threadId)]?.mode;
}

export function getModelPref(chatId: number, threadId: number): string | undefined {
  return state.threads[key(chatId, threadId)]?.model;
}

export function findThreadByWorkdir(workdir: string): ThreadConfig | null {
  for (const [k, t] of Object.entries(state.threads)) {
    if (t.workdir === workdir) {
      const [chatId, threadId] = k.split(":").map(Number);
      return { chat_id: chatId, thread_id: threadId, workdir: t.workdir, agent_type: t.agent_type, name: t.name };
    }
  }
  return null;
}

export function getAllThreads(): ThreadConfig[] {
  return Object.entries(state.threads).map(([k, t]) => {
    const [chatId, threadId] = k.split(":").map(Number);
    return { chat_id: chatId, thread_id: threadId, workdir: t.workdir, agent_type: t.agent_type, name: t.name };
  });
}

// --- ACP Sessions ---

export type AcpSession = {
  chat_id: number;
  thread_id: number;
  session_id: string;
  agent_type: string;
  cwd: string;
  active: boolean;
};

export function getAcpSession(chatId: number, threadId: number): AcpSession | null {
  const t = state.threads[key(chatId, threadId)];
  if (!t || !t.session_id) return null;
  return {
    chat_id: chatId,
    thread_id: threadId,
    session_id: t.session_id,
    agent_type: t.agent_type,
    cwd: t.workdir,
    active: t.active ?? false,
  };
}

export async function saveAcpSession(session: AcpSession): Promise<void> {
  const k = key(session.chat_id, session.thread_id);
  const existing = state.threads[k] || {
    workdir: session.cwd,
    agent_type: session.agent_type,
    name: k,
  };
  state.threads[k] = {
    ...existing,
    workdir: session.cwd,
    agent_type: session.agent_type,
    session_id: session.session_id,
    active: session.active,
  };
  await save();
}

export async function markSessionInactive(chatId: number, threadId: number): Promise<void> {
  const k = key(chatId, threadId);
  if (state.threads[k]) {
    state.threads[k].active = false;
    await save();
  }
}

export function getActiveSessions(): AcpSession[] {
  const results: AcpSession[] = [];
  for (const [k, t] of Object.entries(state.threads)) {
    if (t.active && t.session_id) {
      const [chatId, threadId] = k.split(":").map(Number);
      results.push({
        chat_id: chatId,
        thread_id: threadId,
        session_id: t.session_id,
        agent_type: t.agent_type,
        cwd: t.workdir,
        active: true,
      });
    }
  }
  return results;
}

// --- Messages (append to jsonl) ---

export async function saveMessage(params: {
  chat_id: number;
  thread_id: number;
  message_id?: number;
  from_id?: number;
  from_name?: string;
  role: string;
  content: string;
}): Promise<void> {
  const logPath = `${process.cwd()}/threads/.messages.jsonl`;
  const line = JSON.stringify({ ...params, ts: new Date().toISOString() }) + "\n";
  const file = Bun.file(logPath);
  const existing = await file.exists() ? await file.text() : "";
  await Bun.write(logPath, existing + line);
}
