import type {
  Client,
  SessionNotification,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import type { CallbacksRef } from "./types";

export function createClientHandler(ref: CallbacksRef): Client {
  return {
    async sessionUpdate(params: SessionNotification): Promise<void> {
      const update = params.update as any;

      const updateType = update.sessionUpdate;
      if (!updateType) return;

      console.log(`[acp] update: ${updateType}`);

      switch (updateType) {
        case "agent_message_chunk": {
          const text = update.content?.text;
          if (text) {
            await ref.current.onTextChunk(text);
          } else {
            console.log(`[acp] chunk without text:`, JSON.stringify(update).slice(0, 300));
          }
          break;
        }
        case "tool_call": {
          console.log(`[acp] tool_call: ${update.title} (${update.kind}) [${update.status}]`);
          if (update.kind === "execute" || update.kind === "terminal" || update.title?.toLowerCase().includes("bash") || update.title?.toLowerCase().includes("terminal")) {
            console.log(`[acp] tool_call_detail:`, JSON.stringify({ title: update.title, kind: update.kind, rawInput: update.rawInput, content: update.content }, null, 2));
          }
          await ref.current.onToolCall({
            toolCallId: update.toolCallId,
            title: update.title ?? "tool",
            kind: update.kind,
            status: update.status,
            rawInput: update.rawInput,
            rawOutput: update.rawOutput,
            content: update.content,
          });
          break;
        }
        case "tool_call_update": {
          console.log(`[acp] tool_update: ${update.toolCallId} [${update.status}] ${update.title || ""} kind=${update.kind}`);
          if (!update.status || update.status === "undefined") {
            console.log(`[acp] tool_update_full:`, JSON.stringify(update));
          }
          await ref.current.onToolCallUpdate({
            toolCallId: update.toolCallId,
            title: update.title,
            kind: update.kind,
            status: update.status,
            rawInput: update.rawInput,
            rawOutput: update.rawOutput,
            content: update.content,
          });
          break;
        }
        default:
          console.log(`[acp] unknown update type: ${updateType}`, JSON.stringify(update).slice(0, 500));
          break;
      }
    },

    async requestPermission(
      params: RequestPermissionRequest
    ): Promise<RequestPermissionResponse> {
      console.log(`[acp] permission:`, JSON.stringify(params, null, 2));
      return ref.current.onPermissionRequest(params);
    },
  };
}
