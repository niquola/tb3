import type { AgentHandle, AgentType, CallbacksRef, SessionCallbacks } from "./types";
import { spawnAgent, loadExistingSession } from "./connection";
import { createClientHandler } from "./client-handler";
import * as db from "../store";

type ThreadKey = string; // "chatId:threadId"

function threadKey(chatId: number, threadId: number): string {
  return `${chatId}:${threadId}`;
}

const liveAgents = new Map<ThreadKey, AgentHandle>();
const threadLocks = new Map<ThreadKey, Promise<any>>();

// Silent callbacks for startup restore — just log, don't send to Telegram
const silentCallbacks: SessionCallbacks = {
  onTextChunk: async () => {},
  onToolCall: async () => {},
  onToolCallUpdate: async () => {},
  onPermissionRequest: async (params: any) => {
    // Auto-allow during restore (session replay doesn't usually request perms)
    const options = params.options || [];
    const allowOption = options.find((o: any) => o.kind === "allow_always") || options[0];
    return { outcome: { outcome: "selected", optionId: allowOption?.optionId || "allow" } };
  },
};

async function withLock<T>(key: ThreadKey, fn: () => Promise<T>): Promise<T> {
  const existing = threadLocks.get(key);
  if (existing) {
    await existing.catch(() => {});
  }

  const promise = fn();
  threadLocks.set(key, promise);
  try {
    return await promise;
  } finally {
    if (threadLocks.get(key) === promise) {
      threadLocks.delete(key);
    }
  }
}

function setupExitHandler(handle: AgentHandle, chatId: number, threadId: number) {
  const key = threadKey(chatId, threadId);
  handle.process.on("exit", (code) => {
    console.log(`[session] Agent ${key} exited with code ${code}`);
    liveAgents.delete(key);
    db.markSessionInactive(chatId, threadId).catch(console.error);
  });
}

async function spawnAndRestore(
  chatId: number,
  threadId: number,
  agentType: AgentType,
  cwd: string,
  savedSessionId: string | null,
  callbacksRef: CallbacksRef
): Promise<AgentHandle> {
  const clientImpl = createClientHandler(callbacksRef);
  let handle: AgentHandle;

  if (savedSessionId) {
    try {
      handle = await loadExistingSession(agentType, cwd, savedSessionId, clientImpl);
      handle.callbacksRef = callbacksRef;
    } catch (err) {
      console.error(`[session] Failed to restore session, creating new:`, err);
      handle = await spawnAgent(agentType, cwd, clientImpl);
      handle.callbacksRef = callbacksRef;
    }
  } else {
    handle = await spawnAgent(agentType, cwd, clientImpl);
    handle.callbacksRef = callbacksRef;
  }

  const key = threadKey(chatId, threadId);
  liveAgents.set(key, handle);

  await db.saveAcpSession({
    chat_id: chatId,
    thread_id: threadId,
    session_id: handle.sessionId,
    agent_type: agentType,
    cwd,
    active: true,
  });

  // Apply saved mode/model preferences
  const savedMode = db.getModePref(chatId, threadId);
  const savedModel = db.getModelPref(chatId, threadId);
  if (savedMode && savedMode !== "default") {
    try {
      await handle.connection.setSessionMode({ sessionId: handle.sessionId, modeId: savedMode });
      if (handle.sessionInfo.modes) handle.sessionInfo.modes.currentModeId = savedMode;
      console.log(`[session] ${key} restored mode: ${savedMode}`);
    } catch (err) {
      console.error(`[session] ${key} failed to restore mode ${savedMode}:`, err);
    }
  }
  if (savedModel && savedModel !== "default") {
    try {
      await handle.connection.unstable_setSessionModel({ sessionId: handle.sessionId, modelId: savedModel });
      if (handle.sessionInfo.models) handle.sessionInfo.models.currentModelId = savedModel;
      console.log(`[session] ${key} restored model: ${savedModel}`);
    } catch (err) {
      console.error(`[session] ${key} failed to restore model ${savedModel}:`, err);
    }
  }

  setupExitHandler(handle, chatId, threadId);
  return handle;
}

// --- Startup restore ---

export async function restoreAllSessions(): Promise<void> {
  const sessions = await db.getActiveSessions();
  if (sessions.length === 0) {
    console.log("[restore] No active sessions to restore");
    return;
  }

  console.log(`[restore] Restoring ${sessions.length} active sessions...`);

  for (const session of sessions) {
    const chatId = Number(session.chat_id);
    const threadId = Number(session.thread_id);
    const key = threadKey(chatId, threadId);

    try {
      const callbacksRef: CallbacksRef = { current: silentCallbacks };
      await spawnAndRestore(
        chatId,
        threadId,
        session.agent_type as AgentType,
        session.cwd,
        session.session_id,
        callbacksRef
      );
      console.log(`[restore] ✓ ${key} (session: ${session.session_id.slice(0, 8)}...)`);
    } catch (err) {
      console.error(`[restore] ✗ ${key}:`, err);
      await db.markSessionInactive(chatId, threadId).catch(() => {});
    }
  }

  console.log(`[restore] Done. ${liveAgents.size} agents active.`);
}

// --- Runtime API ---

async function getOrCreateAgent(
  chatId: number,
  threadId: number,
  agentType: AgentType,
  callbacks: SessionCallbacks,
  cwdOverride?: string
): Promise<AgentHandle> {
  const key = threadKey(chatId, threadId);

  // Return existing live agent, update callbacks
  const existing = liveAgents.get(key);
  if (existing && !existing.process.killed) {
    existing.callbacksRef.current = callbacks;
    return existing;
  }

  // Check DB for saved session
  const savedSession = await db.getAcpSession(chatId, threadId);
  const threadConfig = await db.getThreadConfig(chatId, threadId);
  const cwd = cwdOverride || threadConfig?.workdir || `${process.cwd()}/threads/default`;

  const callbacksRef: CallbacksRef = { current: callbacks };

  return spawnAndRestore(
    chatId,
    threadId,
    agentType,
    cwd,
    savedSession?.session_id && savedSession.active ? savedSession.session_id : null,
    callbacksRef
  );
}

// Resume a stopped session — use saved session_id regardless of active flag
export async function resumeAgent(
  chatId: number,
  threadId: number,
  agentType: AgentType,
  callbacks: SessionCallbacks,
  cwdOverride?: string
): Promise<{ resumed: boolean; sessionId: string }> {
  const key = threadKey(chatId, threadId);

  // Kill existing if any
  const existing = liveAgents.get(key);
  if (existing && !existing.process.killed) {
    existing.process.kill();
    liveAgents.delete(key);
  }

  const savedSession = await db.getAcpSession(chatId, threadId);
  const threadConfig = await db.getThreadConfig(chatId, threadId);
  const cwd = cwdOverride || threadConfig?.workdir || `${process.cwd()}/threads/default`;
  const callbacksRef: CallbacksRef = { current: callbacks };

  // Try to resume with saved session_id (even if inactive)
  const handle = await spawnAndRestore(
    chatId, threadId, agentType, cwd,
    savedSession?.session_id || null,
    callbacksRef
  );

  const resumed = savedSession?.session_id ? handle.sessionId === savedSession.session_id : false;
  return { resumed, sessionId: handle.sessionId };
}

export async function sendPrompt(
  chatId: number,
  threadId: number,
  text: string,
  agentType: AgentType,
  callbacks: SessionCallbacks,
  cwdOverride?: string
): Promise<{ stopReason: string }> {
  const key = threadKey(chatId, threadId);

  return withLock(key, async () => {
    const handle = await getOrCreateAgent(chatId, threadId, agentType, callbacks, cwdOverride);

    const result = await handle.connection.prompt({
      sessionId: handle.sessionId,
      prompt: [{ type: "text", text }],
    });

    return { stopReason: result.stopReason };
  });
}

export async function cancelPrompt(chatId: number, threadId: number): Promise<boolean> {
  const key = threadKey(chatId, threadId);
  const handle = liveAgents.get(key);
  if (!handle || handle.process.killed) return false;

  await handle.connection.cancel({ sessionId: handle.sessionId });
  return true;
}

// Stop agent — kill process but keep session_id for later resume
export function stopAgent(chatId: number, threadId: number): boolean {
  const key = threadKey(chatId, threadId);
  const handle = liveAgents.get(key);
  if (!handle) return false;

  handle.process.kill();
  liveAgents.delete(key);
  db.markSessionInactive(chatId, threadId).catch(console.error);
  return true;
}

// Kill agent — kill process AND clear session_id (fresh start next time)
export function killAgent(chatId: number, threadId: number): boolean {
  const key = threadKey(chatId, threadId);
  const handle = liveAgents.get(key);
  if (!handle) return false;

  handle.process.kill();
  liveAgents.delete(key);
  db.clearSession(chatId, threadId).catch(console.error);
  return true;
}

export function getActiveAgentCount(): number {
  return liveAgents.size;
}

// Kill all live agent processes (for graceful shutdown)
export function killAllAgents(): void {
  for (const [key, handle] of liveAgents) {
    try {
      if (!handle.process.killed) {
        handle.process.kill();
        console.log(`[shutdown] killed agent ${key}`);
      }
    } catch {}
  }
  liveAgents.clear();
}

// --- Session info / mode / model ---

export function getSessionInfo(chatId: number, threadId: number): import("./types").SessionInfo | null {
  const key = threadKey(chatId, threadId);
  const handle = liveAgents.get(key);
  if (!handle || handle.process.killed) return null;
  return handle.sessionInfo;
}

export async function setMode(chatId: number, threadId: number, modeId: string): Promise<boolean> {
  const key = threadKey(chatId, threadId);
  const handle = liveAgents.get(key);
  if (!handle || handle.process.killed) return false;

  await handle.connection.setSessionMode({
    sessionId: handle.sessionId,
    modeId,
  });
  if (handle.sessionInfo.modes) {
    handle.sessionInfo.modes.currentModeId = modeId;
  }
  // Persist
  await db.setModePref(chatId, threadId, modeId);
  console.log(`[session] ${key} mode -> ${modeId}`);
  return true;
}

export async function setModel(chatId: number, threadId: number, modelId: string): Promise<boolean> {
  const key = threadKey(chatId, threadId);
  const handle = liveAgents.get(key);
  if (!handle || handle.process.killed) return false;

  await handle.connection.unstable_setSessionModel({
    sessionId: handle.sessionId,
    modelId,
  });
  if (handle.sessionInfo.models) {
    handle.sessionInfo.models.currentModelId = modelId;
  }
  // Persist
  await db.setModelPref(chatId, threadId, modelId);
  console.log(`[session] ${key} model -> ${modelId}`);
  return true;
}

export async function setConfigOption(chatId: number, threadId: number, configId: string, value: string): Promise<boolean> {
  const key = threadKey(chatId, threadId);
  const handle = liveAgents.get(key);
  if (!handle || handle.process.killed) return false;

  await handle.connection.setSessionConfigOption({
    sessionId: handle.sessionId,
    configId,
    value,
  });
  console.log(`[session] ${key} config ${configId} -> ${value}`);
  return true;
}
