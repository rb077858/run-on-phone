// Sending one episode into a customer's group: as one whole MP4 file (a WhatsApp
// "document", the default), as one video, or – only if nothing else is accepted – as
// several video parts.
//
// Every video is uploaded to WhatsApp's media servers (encrypted). The message that points
// to it ("ref": url, directPath, mediaKey, hashes…) is saved on the episode, so the same
// upload can be sent again – to other customers, or as a resend – without uploading the
// file again, for as long as WhatsApp still keeps it. When it is gone, the part is
// uploaded again from the phone.
import { downloadContentFromMessage, generateWAMessageFromContent, getUrlFromDirectPath, proto } from "baileys";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { CACHE_DIR, THUMBNAIL, episodeCaption } from "./config.js";
import { save, settings, sourceKey } from "./db.js";
import { addLog, setProgress } from "./jobs.js";
import { formatBytes, localSourcePath, sourcePath, videoParts } from "./media.js";
import { joinMp4 } from "./mp4split.js";
import { makeUploader } from "./upload.js";

// WhatsApp rejects videos above some size (HTTP 413); documents may be much bigger (2GB).
// Video parts of these sizes are the last resort, largest first; the size that worked is
// remembered.
const PART_SIZES = [95e6, 63e6, 31e6, 15e6];

const label = (ep) => `עונה ${ep.season} פרק ${ep.episode}`;
const fileNameOf = (ep, part, parts) =>
  `קופה ראשית - עונה ${ep.season} פרק ${ep.episode}${parts > 1 ? ` חלק ${part}` : ""}.mp4`;

/** How the episode should be sent now: "document" (one MP4 file) or "video". */
const wantedKind = (ep) => (settings().sendAs === "video" || ep.docTooBig ? "video" : "document");

/** The upload plan for the episode's current video, whatever way it was sent. */
const anyPlan = (ep) => (ep.media?.key === sourceKey(ep.source) ? ep.media : null);

/**
 * The upload plan to use, or null if the episode must be uploaded (again) – also when it
 * was sent the other way (video vs. file) than the setting asks for now.
 */
export function mediaPlan(ep) {
  const plan = anyPlan(ep);
  return plan && (plan.kind || "video") === wantedKind(ep) ? plan : null;
}

// ------------------------------------------------------------------ refs
const PROTO = { video: proto.Message.VideoMessage, document: proto.Message.DocumentMessage };

function refOf(msg, kind) {
  const m = PROTO[kind].fromObject(msg.message[`${kind}Message`]);
  m.caption = "";
  m.contextInfo = null;
  return Buffer.from(PROTO[kind].encode(m).finish()).toString("base64");
}

const decodeRef = (ref, kind = "video") => PROTO[kind].decode(Buffer.from(ref, "base64"));

const aliveCache = new Map(); // ref → { ok, at }, so a sync of many customers checks each video once

/** Forget the "still on WhatsApp" checks (at the start of a sync round). */
export const forgetRefChecks = () => aliveCache.clear();

/** Is the uploaded file still on WhatsApp's servers? (fetches 1 byte) */
async function refAlive(ref, kind) {
  const cached = aliveCache.get(ref);
  if (cached && Date.now() - cached.at < 2 * 60_000) return cached.ok;
  let ok = false;
  try {
    const vm = decodeRef(ref, kind);
    const url = vm.directPath ? getUrlFromDirectPath(vm.directPath) : vm.url;
    const res = await fetch(url, { headers: { Range: "bytes=0-0", Origin: "https://web.whatsapp.com" } });
    ok = res.status === 200 || res.status === 206;
    await res.body?.cancel();
  } catch {}
  aliveCache.set(ref, { ok, at: Date.now() });
  return ok;
}

/** Sends an already-uploaded video/file again (no upload). */
async function relay(sock, jid, ref, kind, caption) {
  const m = decodeRef(ref, kind);
  m.caption = caption;
  const msg = generateWAMessageFromContent(jid, { [`${kind}Message`]: m }, { userJid: sock.user.id });
  await sock.relayMessage(jid, msg.message, { messageId: msg.key.id });
  return msg;
}

async function upload(sock, jid, file, kind, caption, name, fileName) {
  const media = { url: file };
  return sock.sendMessage(
    jid,
    kind === "document"
      ? { document: media, mimetype: "video/mp4", fileName, caption, jpegThumbnail: THUMBNAIL }
      : { video: media, mimetype: "video/mp4", caption, jpegThumbnail: THUMBNAIL }, // thumbnail: no ffmpeg needed
    { upload: makeUploader(sock, { log: addLog, progress: setProgress, name }) },
  );
}

// ----------------------------------------------------------------- files
/** The episode's full video on the phone; brings it back from WhatsApp if it was deleted. */
async function sourceFile(ep) {
  ep.lastUsed = Date.now();
  const local = localSourcePath(ep.source);
  if (local) return local;
  const plan = anyPlan(ep);
  if (plan?.parts.every((p) => p.ref)) {
    try {
      return await restoreFromWhatsApp(ep, plan);
    } catch (e) {
      addLog(`  ⚠ ${label(ep)}: השחזור מוואטסאפ נכשל (${e.message})`);
    }
  }
  const err = new Error(
    ep.source.type === "file"
      ? `${label(ep)}: הסרטון לא בטלפון וכבר לא בוואטסאפ. העלה אותו שוב (בפרק: ⋯ ← העלאה מחדש לטלפון)`
      : `${label(ep)}: פרק ישן מדרייב שכבר לא בוואטסאפ. העלה את הסרטון כקובץ (בפרק: ⋯ ← החלפת הסרטון)`,
  );
  err.noSource = true;
  throw err;
}

/**
 * Downloads what the bot uploaded to WhatsApp back to the phone (decrypting it with the
 * saved keys), joins parts into one MP4, and puts it where the episode's video belongs.
 */
async function restoreFromWhatsApp(ep, plan) {
  const kind = plan.kind || "video";
  const n = plan.parts.length;
  addLog(`  ⬇ ${label(ep)}: הסרטון לא בטלפון, מוריד אותו בחזרה מוואטסאפ${n > 1 ? ` (${n} חלקים)` : ""}`);
  const files = [];
  try {
    for (const [i, part] of plan.parts.entries()) {
      if (!(await refAlive(part.ref, kind))) throw new Error("וואטסאפ כבר מחקה את הקובץ");
      const file = path.join(CACHE_DIR, `restore-${ep.id}-${i + 1}.mp4`);
      const stream = await downloadContentFromMessage(decodeRef(part.ref, kind), kind);
      let done = 0;
      stream.on("data", (c) => {
        done += c.length;
        setProgress(`⬇ ${label(ep)} מוואטסאפ${n > 1 ? ` חלק ${i + 1}/${n}` : ""}: ${formatBytes(done)}${part.size ? ` / ${formatBytes(part.size)}` : ""}`);
      });
      await pipeline(stream, fs.createWriteStream(file));
      files.push(file);
    }
    setProgress(null);
    const dest = sourcePath(ep.source);
    if (n === 1) fs.renameSync(files[0], dest);
    else joinMp4(files, dest);
    addLog(`  ✔ ${label(ep)}: הסרטון שוחזר מוואטסאפ (${formatBytes(fs.statSync(dest).size)})`);
    delete ep.localDeletedAt;
    save();
    return dest;
  } finally {
    setProgress(null);
    for (const f of files) fs.rmSync(f, { force: true });
  }
}

function partFiles(ep, file, limit) {
  let parts;
  try {
    parts = limit ? videoParts(file, limit) : [file];
  } catch (e) {
    throw new Error(`חלוקת הסרטון לחלקים נכשלה: ${e.message}`);
  }
  ep.localFiles = parts.filter((p) => p !== file);
  return parts;
}

// ------------------------------------------------------------------ send
/**
 * Sends the given parts (1-based numbers) of the episode to the group.
 * `onSent(record)` is called after each message so the caller can save it right away.
 */
export async function sendParts(c, s, sock, ep, partNumbers, onSent, plan = mediaPlan(ep)) {
  const n = plan.parts.length;
  const kind = plan.kind || "video";
  let parts = null; // local files, prepared only if something must be uploaded
  for (const no of partNumbers) {
    const part = plan.parts[no - 1];
    const caption = episodeCaption(ep, no, n);
    s.touch();
    let msg;
    if (settings().reuseUploads && part.ref && (await refAlive(part.ref, kind))) {
      addLog(`  ♻ ${label(ep)}${n > 1 ? ` חלק ${no}/${n}` : ""}: נשלח בלי העלאה (כבר בוואטסאפ)`);
      msg = await relay(sock, c.groupJid, part.ref, kind, caption);
    } else {
      // Parts already on the phone are enough; otherwise split the full video again.
      const have = ep.localFiles?.length === n && ep.localFiles.every((p) => fs.existsSync(p));
      parts ??= have ? ep.localFiles : partFiles(ep, await sourceFile(ep), plan.limit);
      if (parts.length !== n) throw new Error("חלוקת הפרק לחלקים השתנתה. מחק את הפרק והוסף אותו שוב");
      addLog(`  ⬆ ${label(ep)}${n > 1 ? ` חלק ${no}/${n}` : ""} (${formatBytes(fs.statSync(parts[no - 1]).size)})`);
      const name = `${label(ep)}${n > 1 ? ` חלק ${no}/${n}` : ""}`;
      msg = await upload(sock, c.groupJid, parts[no - 1], kind, caption, name, fileNameOf(ep, no, n));
      part.ref = refOf(msg, kind);
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
 * First upload of an episode (no plan yet). Tries, in order: one video; one whole file
 * (if the episode is too big for a video); video parts of decreasing size. Saves the plan
 * with the refs for reuse. `undo(records)` deletes messages sent in a failed attempt.
 */
export async function firstUpload(c, s, sock, ep, onSent, undo) {
  const file = await sourceFile(ep);
  const size = fs.statSync(file).size;
  const st = settings();
  const known = st.maxVideoBytes;
  // A whole video this big was already rejected once: don't try again.
  const fitsVideo = (!known || size <= known) && !(st.videoRejectedAt && size >= st.videoRejectedAt);
  const attempts = [
    ...(wantedKind(ep) === "document" ? [{ kind: "document", limit: null }] : []),
    ...(fitsVideo ? [{ kind: "video", limit: null }] : []),
    ...PART_SIZES.filter((l) => l < size && (!known || l <= known)).map((limit) => ({ kind: "video", limit })),
  ];
  for (const { kind, limit } of attempts) {
    const parts = partFiles(ep, file, limit);
    if (parts.length > 1) addLog(`  ✂ ${label(ep)}: מחולק ל-${parts.length} חלקים`);
    const sent = [];
    const refs = [];
    try {
      for (const [i, part] of parts.entries()) {
        s.touch();
        const name = `${label(ep)}${parts.length > 1 ? ` חלק ${i + 1}/${parts.length}` : ""}`;
        addLog(`  ⬆ ${name} (${formatBytes(fs.statSync(part).size)})`);
        const caption = episodeCaption(ep, i + 1, parts.length);
        const msg = await upload(sock, c.groupJid, part, kind, caption, name, fileNameOf(ep, i + 1, parts.length));
        s.sentCache.set(msg.key.id, msg.message);
        const rec = record(ep, i + 1, parts.length, msg);
        sent.push(rec);
        onSent(rec);
        refs.push({ size: fs.statSync(part).size, ref: refOf(msg, kind), refAt: Date.now() });
      }
    } catch (e) {
      if (!e.tooLarge) throw e;
      if (kind === "document") {
        ep.docTooBig = true;
        addLog("  ⚠ וואטסאפ לא מקבלת קובץ בגודל הזה. שולח כסרטון");
      } else {
        if (!limit) st.videoRejectedAt = Math.min(st.videoRejectedAt || Infinity, size);
        addLog("  ⚠ וואטסאפ לא מקבלת סרטון בגודל הזה");
      }
      await undo(sent);
      continue;
    }
    ep.media = { key: sourceKey(ep.source), kind, limit, parts: refs };
    if (kind === "video" && limit && st.maxVideoBytes !== limit) st.maxVideoBytes = limit;
    ep.lastUsed = Date.now();
    save();
    return;
  }
  throw new Error("וואטסאפ לא מקבלת את הסרטון גם כקובץ וגם בחלקים קטנים");
}
