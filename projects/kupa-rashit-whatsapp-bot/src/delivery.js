// Sending one episode (one or more video parts) into a customer's group.
//
// Every video is uploaded to WhatsApp's media servers (encrypted). The message that points
// to it ("ref": url, directPath, mediaKey, hashes…) is saved on the episode, so the same
// upload can be sent again – to other customers, or as a resend – without uploading the
// file again, for as long as WhatsApp still keeps it. When it is gone, the part is
// uploaded again from the phone (downloading it from Drive first if needed).
import { generateWAMessageFromContent, getUrlFromDirectPath, proto } from "baileys";
import fs from "node:fs";
import { THUMBNAIL, episodeCaption } from "./config.js";
import { save, settings, sourceKey } from "./db.js";
import { addLog } from "./jobs.js";
import { episodeFile, formatBytes, videoParts } from "./media.js";
import { makeUploader } from "./upload.js";

// WhatsApp rejects videos above some size (HTTP 413). Big episodes are split into parts
// of these sizes, trying the largest first; the size that worked is remembered.
const PART_SIZES = [95e6, 63e6, 31e6, 15e6];

const label = (ep) => `עונה ${ep.season} פרק ${ep.episode}`;

/** The upload plan of the episode for its current video, or null if never uploaded. */
export const mediaPlan = (ep) => (ep.media?.key === sourceKey(ep.source) ? ep.media : null);

// ------------------------------------------------------------------ refs
function refOf(msg) {
  const vm = proto.Message.VideoMessage.fromObject(msg.message.videoMessage);
  vm.caption = "";
  vm.contextInfo = null;
  return Buffer.from(proto.Message.VideoMessage.encode(vm).finish()).toString("base64");
}

const aliveCache = new Map(); // ref → { ok, at }, so a sync of many customers checks each video once

/** Forget the "still on WhatsApp" checks (at the start of a sync round). */
export const forgetRefChecks = () => aliveCache.clear();

/** Is the uploaded file still on WhatsApp's servers? (fetches 1 byte) */
async function refAlive(ref) {
  const cached = aliveCache.get(ref);
  if (cached && Date.now() - cached.at < 2 * 60_000) return cached.ok;
  let ok = false;
  try {
    const vm = proto.Message.VideoMessage.decode(Buffer.from(ref, "base64"));
    const url = vm.directPath ? getUrlFromDirectPath(vm.directPath) : vm.url;
    const res = await fetch(url, { headers: { Range: "bytes=0-0", Origin: "https://web.whatsapp.com" } });
    ok = res.status === 200 || res.status === 206;
    await res.body?.cancel();
  } catch {}
  aliveCache.set(ref, { ok, at: Date.now() });
  return ok;
}

/** Sends an already-uploaded video again (no upload). */
async function relay(sock, jid, ref, caption) {
  const vm = proto.Message.VideoMessage.decode(Buffer.from(ref, "base64"));
  vm.caption = caption;
  const msg = generateWAMessageFromContent(jid, { videoMessage: vm }, { userJid: sock.user.id });
  await sock.relayMessage(jid, msg.message, { messageId: msg.key.id });
  return msg;
}

async function upload(sock, jid, file, caption) {
  return sock.sendMessage(
    jid,
    { video: { url: file }, caption, mimetype: "video/mp4", jpegThumbnail: THUMBNAIL }, // thumbnail: no ffmpeg needed
    { upload: makeUploader(sock, addLog) },
  );
}

// ----------------------------------------------------------------- files
async function sourceFile(ep) {
  ep.lastUsed = Date.now();
  return episodeFile(ep.source, (done, total) =>
    addLog(`  ⬇ ${label(ep)}: ${formatBytes(done)}${total ? ` / ${formatBytes(total)}` : ""}`),
  );
}

function partFiles(ep, file, limit) {
  let parts;
  try {
    parts = limit ? videoParts(file, limit) : [file];
  } catch (e) {
    throw new Error(`חלוקת הסרטון לחלקים נכשלה: ${e.message}`);
  }
  ep.localFiles = [...new Set([...(ep.localFiles || []), ...parts.filter((p) => p !== file)])];
  return parts;
}

// ------------------------------------------------------------------ send
/**
 * Sends the given parts (1-based numbers) of the episode to the group.
 * `onSent(record)` is called after each message so the caller can save it right away.
 */
export async function sendParts(c, s, sock, ep, partNumbers, onSent) {
  const plan = mediaPlan(ep);
  const n = plan.parts.length;
  let parts = null; // local files, prepared only if something must be uploaded
  for (const no of partNumbers) {
    const part = plan.parts[no - 1];
    const caption = episodeCaption(ep, no, n);
    s.touch();
    let msg;
    if (settings().reuseUploads && part.ref && (await refAlive(part.ref))) {
      addLog(`  ♻ ${label(ep)}${n > 1 ? ` חלק ${no}/${n}` : ""}: נשלח בלי העלאה (כבר בוואטסאפ)`);
      msg = await relay(sock, c.groupJid, part.ref, caption);
    } else {
      parts ??= partFiles(ep, await sourceFile(ep), plan.limit);
      if (parts.length !== n) throw new Error("חלוקת הפרק לחלקים השתנתה. מחק את הפרק והוסף אותו שוב");
      addLog(`  ⬆ ${label(ep)}${n > 1 ? ` חלק ${no}/${n}` : ""} (${formatBytes(fs.statSync(parts[no - 1]).size)})`);
      msg = await upload(sock, c.groupJid, parts[no - 1], caption);
      part.ref = refOf(msg);
      part.refAt = Date.now();
      aliveCache.delete(part.ref);
      ep.lastUsed = Date.now();
    }
    s.sentCache.set(msg.key.id, msg.message);
    onSent(record(ep, no, n, msg));
  }
  save();
}

function record(ep, part, parts, msg) {
  return {
    episodeId: ep.id,
    sourceKey: sourceKey(ep.source),
    title: ep.title || "",
    se: `${ep.season}x${ep.episode}`,
    part,
    parts,
    key: msg.key,
    timestamp: Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000),
  };
}

/**
 * First upload of an episode (no plan yet): tries the whole file, and if WhatsApp says it
 * is too large, smaller and smaller parts. Saves the plan with the refs for reuse.
 * `undo(records)` deletes messages already sent in a failed attempt.
 */
export async function firstUpload(c, s, sock, ep, onSent, undo) {
  const file = await sourceFile(ep);
  const size = fs.statSync(file).size;
  const st = settings();
  const known = st.maxVideoBytes;
  const limits = [...(known && size > known ? [] : [null]), ...PART_SIZES.filter((l) => l < size && (!known || l <= known))];
  for (const limit of limits) {
    const parts = partFiles(ep, file, limit);
    if (parts.length > 1) addLog(`  ✂ ${label(ep)}: מחולק ל-${parts.length} חלקים`);
    const sent = [];
    const refs = [];
    try {
      for (const [i, part] of parts.entries()) {
        s.touch();
        addLog(`  ⬆ ${label(ep)}${parts.length > 1 ? ` חלק ${i + 1}/${parts.length}` : ""} (${formatBytes(fs.statSync(part).size)})`);
        const msg = await upload(sock, c.groupJid, part, episodeCaption(ep, i + 1, parts.length));
        s.sentCache.set(msg.key.id, msg.message);
        const rec = record(ep, i + 1, parts.length, msg);
        sent.push(rec);
        onSent(rec);
        refs.push({ size: fs.statSync(part).size, ref: refOf(msg), refAt: Date.now() });
      }
    } catch (e) {
      if (!e.tooLarge) throw e;
      addLog("  ⚠ וואטסאפ לא מקבל קובץ בגודל הזה, מנסה חלקים קטנים יותר");
      await undo(sent);
      continue;
    }
    ep.media = { key: sourceKey(ep.source), limit, parts: refs };
    if (limit && st.maxVideoBytes !== limit) st.maxVideoBytes = limit;
    ep.lastUsed = Date.now();
    save();
    return;
  }
  throw new Error("וואטסאפ לא מקבל את הסרטון גם אחרי חלוקה לחלקים קטנים");
}
