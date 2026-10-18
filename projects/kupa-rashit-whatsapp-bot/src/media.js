// Getting episode videos onto disk: from Google Drive links, from videos/files sent in
// the manager group, and from admin-panel uploads. Everything is streamed to disk, never
// held in memory.
import { downloadContentFromMessage } from "baileys";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CACHE_DIR, MEDIA_DIR } from "./config.js";
import { newId } from "./db.js";
import { splitMp4 } from "./mp4split.js";

// ---------------------------------------------------------------- Drive links
const DRIVE_HOST = /(drive|docs)\.google\.com|drive\.usercontent\.google\.com/;

/** Finds a Google Drive file link in text → { link, fileId } or null. */
export function parseDriveLink(text) {
  for (const m of String(text || "").matchAll(/https?:\/\/\S+/g)) {
    const link = m[0];
    if (!DRIVE_HOST.test(link)) continue;
    const id = link.match(/\/d\/([\w-]{15,})/)?.[1] || link.match(/[?&]id=([\w-]{15,})/)?.[1];
    if (id) return { link, fileId: id };
  }
  return null;
}

export const driveLink = (fileId) => `https://drive.google.com/file/d/${fileId}/view`;

function progressCounter(total, onProgress) {
  let done = 0;
  let last = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      done += chunk.length;
      if (onProgress && Date.now() - last > 1500) {
        last = Date.now();
        onProgress(done, total);
      }
      cb(null, chunk);
    },
  });
}

async function streamToFile(body, dest, total, onProgress) {
  const tmp = dest + ".part";
  try {
    await pipeline(body, progressCounter(total, onProgress), fs.createWriteStream(tmp));
    fs.renameSync(tmp, dest);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

const inFlight = new Map();

/** Path of the cached Drive video; downloads it first if needed. */
export function ensureDriveFile(fileId, onProgress) {
  const dest = path.join(CACHE_DIR, `drive-${fileId}.mp4`);
  if (fs.existsSync(dest)) return Promise.resolve(dest);
  if (!inFlight.has(fileId)) {
    const p = downloadDrive(fileId, dest, onProgress).finally(() => inFlight.delete(fileId));
    inFlight.set(fileId, p);
  }
  return inFlight.get(fileId);
}

async function downloadDrive(fileId, dest, onProgress) {
  let res = await fetch(
    `https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download&confirm=t`,
    { redirect: "follow" },
  );
  // Big files get a "can't scan for viruses" page with a form that leads to the real file.
  if (res.ok && /text\/html/.test(res.headers.get("content-type") || "")) {
    const html = await res.text();
    const action = html.match(/<form[^>]+action="([^"]+)"/)?.[1];
    if (!action) throw new Error("הקובץ בדרייב לא נגיש. ודא שהשיתוף הוא \"כל מי שיש לו את הקישור\"");
    const params = new URLSearchParams();
    for (const m of html.matchAll(/<input[^>]+type="hidden"[^>]*>/g)) {
      const name = m[0].match(/name="([^"]+)"/)?.[1];
      const value = m[0].match(/value="([^"]*)"/)?.[1] ?? "";
      if (name) params.set(name, value);
    }
    res = await fetch(`${action.replace(/&amp;/g, "&")}?${params}`, { redirect: "follow" });
    if (/text\/html/.test(res.headers.get("content-type") || "")) {
      throw new Error("דרייב החזיר דף במקום קובץ (אולי חרגת ממכסת ההורדות, או שהקובץ לא משותף)");
    }
  }
  if (!res.ok) throw new Error(`הורדה מדרייב נכשלה: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  await streamToFile(Readable.fromWeb(res.body), dest, total, onProgress);
  return dest;
}

// ------------------------------------------------------- WhatsApp & uploads
/** The video inside a WhatsApp message (sent as a video or as a video/any file document). */
export function videoContent(message) {
  if (message?.videoMessage) return { type: "video", content: message.videoMessage };
  const doc = message?.documentMessage || message?.documentWithCaptionMessage?.message?.documentMessage;
  if (doc && (/^video\//.test(doc.mimetype || "") || /\.(mp4|m4v|mov|mkv|webm|avi)$/i.test(doc.fileName || ""))) {
    return { type: "document", content: doc };
  }
  return null;
}

/** Saves a WhatsApp video to MEDIA_DIR and returns the stored file name. */
export async function saveWhatsAppVideo({ type, content }, onProgress) {
  const file = `wa-${newId()}.mp4`;
  const stream = await downloadContentFromMessage(content, type);
  await streamToFile(stream, path.join(MEDIA_DIR, file), Number(content.fileLength) || 0, onProgress);
  return file;
}

/** Saves an uploaded request body (raw video bytes) to MEDIA_DIR. */
export async function saveUpload(req) {
  const file = `up-${newId()}.mp4`;
  await streamToFile(req, path.join(MEDIA_DIR, file), Number(req.headers["content-length"]) || 0);
  return file;
}

// -------------------------------------------------------------------- parts
/**
 * The video split into parts of at most maxBytes (cached in CACHE_DIR, so every customer
 * reuses the same parts). Returns [file] if it already fits.
 */
export function videoParts(file, maxBytes) {
  const st = fs.statSync(file);
  if (st.size <= maxBytes) return [file];
  const id = crypto.createHash("sha1").update(`${file}|${st.size}|${st.mtimeMs}`).digest("hex").slice(0, 12);
  const prefix = path.join(CACHE_DIR, `split-${id}-${Math.round(maxBytes / 1e6)}MB`);
  const index = `${prefix}.json`;
  try {
    const parts = JSON.parse(fs.readFileSync(index, "utf8"));
    if (parts.every((p) => fs.existsSync(p))) return parts;
  } catch {}
  const parts = splitMp4(file, prefix, maxBytes);
  fs.writeFileSync(index, JSON.stringify(parts));
  return parts;
}

// ------------------------------------------------------------------- sources
/** Local path of an episode's video, downloading from Drive if needed. */
export function episodeFile(source, onProgress) {
  if (source.type === "drive") return ensureDriveFile(source.fileId, onProgress);
  const p = path.join(MEDIA_DIR, source.file);
  if (!fs.existsSync(p)) return Promise.reject(new Error("קובץ הסרטון חסר בטלפון – העלה אותו מחדש"));
  return Promise.resolve(p);
}

export function deleteSourceFile(source) {
  if (source?.type === "file") fs.rmSync(path.join(MEDIA_DIR, path.basename(source.file)), { force: true });
}

function dirSize(dir) {
  let total = 0;
  for (const f of fs.readdirSync(dir)) {
    try {
      total += fs.statSync(path.join(dir, f)).size;
    } catch {}
  }
  return total;
}

export const storageInfo = () => ({ cache: dirSize(CACHE_DIR), media: dirSize(MEDIA_DIR) });

export function clearDriveCache() {
  for (const f of fs.readdirSync(CACHE_DIR)) fs.rmSync(path.join(CACHE_DIR, f), { force: true });
}

export const formatBytes = (n) =>
  n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(2)}GB` : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)}MB` : `${Math.round(n / 1024)}KB`;
