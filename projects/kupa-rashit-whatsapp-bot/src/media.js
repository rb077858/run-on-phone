// Episode videos on the phone: admin-panel uploads, split parts, and deleting them again
// after a few days. Everything is streamed to disk,
// never held in memory.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CACHE_DIR, MEDIA_DIR } from "./config.js";
import { newId } from "./db.js";
import { splitMp4 } from "./mp4split.js";

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

// ------------------------------------------------------------------ uploads
/** Saves an uploaded request body (raw video bytes) to MEDIA_DIR, optionally under a given name. */
export async function saveUpload(req, file = `up-${newId()}.mp4`) {
  await streamToFile(req, path.join(MEDIA_DIR, path.basename(file)), Number(req.headers["content-length"]) || 0);
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
/** Local path of an episode's video (rejects if it is no longer on the phone). */
export function episodeFile(source) {
  const p = localSourcePath(source);
  if (p) return Promise.resolve(p);
  return Promise.reject(
    new Error(
      source.type === "file"
        ? "קובץ הסרטון כבר נמחק מהטלפון. העלה אותו שוב בממשק (בפרק: ⋯ ← העלאה מחדש לטלפון)"
        : "זה פרק ישן מקישור לדרייב. העלה את הסרטון כקובץ (בפרק: ⋯ ← החלפת הסרטון)",
    ),
  );
}

/** Local path of the episode's full video if it is on the phone right now, else null. */
export function localSourcePath(source) {
  const p =
    source.type === "drive" ? path.join(CACHE_DIR, `drive-${source.fileId}.mp4`) : path.join(MEDIA_DIR, source.file);
  return fs.existsSync(p) ? p : null;
}

export function deleteSourceFile(source) {
  if (source?.type === "file") fs.rmSync(path.join(MEDIA_DIR, path.basename(source.file)), { force: true });
  if (source?.type === "drive") fs.rmSync(path.join(CACHE_DIR, `drive-${source.fileId}.mp4`), { force: true });
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

/** Total size of an episode's files that are on the phone right now. */
export function episodeLocalBytes(ep) {
  let total = 0;
  for (const p of [localSourcePath(ep.source), ...(ep.localFiles || [])]) {
    try {
      if (p) total += fs.statSync(p).size;
    } catch {}
  }
  return total;
}

/**
 * Deletes videos from the phone that were not used for `keepDays` days – only those that
 * WhatsApp already has (every part uploaded at least once). Split parts and unknown cache
 * files go too.
 * Returns the number of bytes freed.
 */
export function cleanupLocal(episodes, keepDays, force = false) {
  const cutoff = Date.now() - keepDays * 86400_000;
  let freed = 0;
  const rm = (p) => {
    try {
      freed += fs.statSync(p).size;
      fs.rmSync(p, { force: true });
    } catch {}
  };
  const keep = new Set();
  for (const ep of episodes) {
    const uploaded = ep.media?.parts?.length && ep.media.parts.every((p) => p.ref);
    const safe = uploaded;
    const old = force || (ep.lastUsed || ep.addedAt || 0) < cutoff;
    const files = [localSourcePath(ep.source), ...(ep.localFiles || [])].filter(Boolean);
    if (safe && old) {
      files.forEach(rm);
      ep.localFiles = [];
      if (files.length) ep.localDeletedAt = Date.now();
    } else files.forEach((f) => keep.add(path.resolve(f)));
  }
  // Leftovers in the cache that no episode uses (deleted episodes, old split sizes, …).
  for (const f of fs.readdirSync(CACHE_DIR)) {
    const p = path.resolve(CACHE_DIR, f);
    if (keep.has(p) || f.endsWith(".part")) continue;
    if (f.endsWith(".json")) {
      if (force || fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true });
      continue;
    }
    const used = episodes.some((ep) => localSourcePath(ep.source) === p || ep.localFiles?.includes(p));
    if (!used || force) rm(p);
  }
  return freed;
}

export const formatBytes = (n) =>
  n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(2)}GB` : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)}MB` : `${Math.round(n / 1024)}KB`;
