// Our own media uploader for Baileys (passed as the `upload` option of sendMessage).
// Baileys' built-in one hides the real error ("Media upload failed on all hosts") and
// ignores each host's size limit; this one reports why an upload failed, retries with a
// fresh media connection, and reports upload progress.
import { encodeBase64EncodedStringForUpload } from "baileys";
import fs from "node:fs";
import https from "node:https";
import { formatBytes } from "./media.js";

const MEDIA_PATH = { image: "/mms/image", video: "/mms/video", document: "/mms/document", audio: "/mms/audio" };
const ORIGIN = "https://web.whatsapp.com";

const STALL_MS = 60_000;

function post(url, filePath, size, onProgress) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "Content-Length": size, Origin: ORIGIN },
    });
    let sent = 0;
    let lastSent = 0;
    let lastMove = Date.now();
    // Mobile connections sometimes freeze mid-upload: give up on this try after a minute
    // without progress instead of waiting for TCP to time out.
    const watchdog = setInterval(() => {
      if (sent !== lastSent) {
        lastSent = sent;
        lastMove = Date.now();
      } else if (Date.now() - lastMove > STALL_MS) {
        req.destroy(new Error(`ההעלאה נתקעה ב-${Math.floor((sent / size) * 100)}% (אין התקדמות דקה)`));
      }
      onProgress?.(sent, size);
    }, 2000);
    const done = (fn) => (v) => {
      clearInterval(watchdog);
      fn(v);
    };
    req.on("response", (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", done(() => resolve({ status: res.statusCode, body })));
    });
    req.on("error", done(reject));
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => (sent += chunk.length));
    stream.on("error", (e) => req.destroy(e));
    stream.pipe(req);
  });
}

const fmtTime = (sec) => (sec >= 60 ? `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")} דק׳` : `${Math.round(sec)} שנ׳`);

/** Turns (sent, total) samples into "⬆ 45% · 34/75MB · 0.6MB/s · עוד ~1:10 דק׳". */
function progressReporter(name, report) {
  const samples = [];
  return (sent, total) => {
    const now = Date.now();
    samples.push([now, sent]);
    while (samples.length > 2 && now - samples[0][0] > 15_000) samples.shift();
    const [t0, s0] = samples[0];
    const speed = now > t0 ? ((sent - s0) / (now - t0)) * 1000 : 0;
    const pct = Math.floor((sent / total) * 100);
    const eta = speed > 0 ? ` · עוד ~${fmtTime((total - sent) / speed)}` : "";
    report(`⬆ ${name}: ${pct}% · ${formatBytes(sent)}/${formatBytes(total)} · ${formatBytes(speed)}/s${eta}`);
  };
}

/**
 * Returns an `upload` function for sock.sendMessage(..., { upload }).
 * `log` gets the important lines, `progress` the live progress line.
 */
export function makeUploader(sock, { log = console.log, progress = () => {}, name = "העלאה" } = {}) {
  return async (filePath, { mediaType, fileEncSha256B64 }) => {
    const size = fs.statSync(filePath).size;
    const token = encodeBase64EncodedStringForUpload(fileEncSha256B64);
    const errors = [];
    const started = Date.now();
    for (let attempt = 1; attempt <= 3; attempt++) {
      const conn = await sock.refreshMediaConn(attempt > 1);
      for (const host of conn.hosts) {
        if (host.maxContentLengthBytes && size > host.maxContentLengthBytes) {
          errors.push(`${host.hostname}: הקובץ (${formatBytes(size)}) גדול מהמקסימום ${formatBytes(host.maxContentLengthBytes)}`);
          continue;
        }
        const url = `https://${host.hostname}${MEDIA_PATH[mediaType]}/${token}?auth=${encodeURIComponent(conn.auth)}&token=${token}`;
        try {
          const { status, body } = await post(url, filePath, size, progressReporter(name, progress));
          let json;
          try {
            json = JSON.parse(body);
          } catch {}
          if (json?.url || json?.direct_path) {
            const sec = (Date.now() - started) / 1000;
            log(`  ✔ ${name} הועלה (${formatBytes(size)} ב-${fmtTime(sec)}, ${formatBytes(size / sec)}/s)`);
            progress(null);
            return { mediaUrl: json.url, directPath: json.direct_path, meta_hmac: json.meta_hmac, fbid: json.fbid, ts: json.ts };
          }
          errors.push(`${host.hostname}: HTTP ${status} ${String(body).slice(0, 200)}`);
        } catch (e) {
          errors.push(`${host.hostname}: ${e.message}`);
        }
        if (!/BAD_FILE_SIZE|HTTP 413/.test(errors.at(-1))) log(`  ⚠ ${errors.at(-1)}. מנסה שוב מההתחלה`);
      }
      if (errors.every((e) => /BAD_FILE_SIZE|HTTP 413|גדול מהמקסימום/.test(e))) break; // retrying won't help
    }
    progress(null);
    const err = new Error(`העלאת הסרטון לוואטסאפ נכשלה – ${[...new Set(errors)].slice(-3).join(" | ")}`);
    err.tooLarge = errors.every((e) => /BAD_FILE_SIZE|HTTP 413|גדול מהמקסימום/.test(e));
    throw err;
  };
}
