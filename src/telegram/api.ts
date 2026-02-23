const botToken = process.env.TELEGRAM_BOT_TOKEN!;
const API = `https://api.telegram.org/bot${botToken}`;

export async function api(method: string, body?: any) {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!json.ok && method !== "deleteMessage")
    console.error(`API error [${method}]:`, json);
  return json;
}

export async function deleteMessage(chatId: number, messageId: number) {
  await api("deleteMessage", { chat_id: chatId, message_id: messageId });
}

export async function sendTyping(chatId: number, threadId?: number) {
  await api("sendChatAction", {
    chat_id: chatId,
    action: "typing",
    ...(threadId ? { message_thread_id: threadId } : {}),
  });
}

export async function downloadTelegramFile(
  fileId: string
): Promise<{ data: ArrayBuffer; filePath: string } | null> {
  try {
    const res = await api("getFile", { file_id: fileId });
    if (!res.ok || !res.result?.file_path) return null;

    const fileUrl = `https://api.telegram.org/file/bot${botToken}/${res.result.file_path}`;
    const fileRes = await fetch(fileUrl);
    if (!fileRes.ok) return null;

    return { data: await fileRes.arrayBuffer(), filePath: res.result.file_path };
  } catch (err) {
    console.error("Failed to download file:", err);
    return null;
  }
}

export function getFileInfo(
  msg: any
): { fileId: string; fileName: string; type: string } | null {
  if (msg.photo && msg.photo.length > 0) {
    const photo = msg.photo[msg.photo.length - 1];
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    return { fileId: photo.file_id, fileName: `photo_${ts}.jpg`, type: "photo" };
  }
  if (msg.document) {
    const doc = msg.document;
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const ext = doc.file_name?.split(".").pop() || "bin";
    const base =
      doc.file_name?.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]/g, "_") ||
      "file";
    return { fileId: doc.file_id, fileName: `${base}_${ts}.${ext}`, type: "document" };
  }
  if (msg.voice) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    return { fileId: msg.voice.file_id, fileName: `voice_${ts}.ogg`, type: "voice" };
  }
  if (msg.audio) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const ext = msg.audio.file_name?.split(".").pop() || "mp3";
    return { fileId: msg.audio.file_id, fileName: `audio_${ts}.${ext}`, type: "audio" };
  }
  if (msg.video) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    return { fileId: msg.video.file_id, fileName: `video_${ts}.mp4`, type: "video" };
  }
  return null;
}

export async function saveFile(msg: any): Promise<string | null> {
  const info = getFileInfo(msg);
  if (!info) return null;

  const downloaded = await downloadTelegramFile(info.fileId);
  if (!downloaded) return null;

  const filePath = `${process.cwd()}/files/${info.fileName}`;
  await Bun.write(filePath, downloaded.data);
  return filePath;
}
