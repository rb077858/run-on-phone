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

function post(url, filePath, size, onProgress) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "Content-Length": size, Origin: ORIGIN },
    });
    req.setTimeout(120_000, () => req.destroy(new Error("אין תגובה מהשרת של וואטסאפ (timeout)")));
    req.on("response", (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    let sent = 0;
    let last = 0;
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => {
      sent += chunk.length;
      if (onProgress && Date.now() - last > 3000) {
        last = Date.now();
        onProgress(sent, size);
      }
    });
    stream.on("error", (e) => req.destroy(e));
    stream.pipe(req);
  });
}

/** Returns an `upload` function for sock.sendMessage(..., { upload }). */
export function makeUploader(sock, log = console.log) {
  return async (filePath, { mediaType, fileEncSha256B64 }) => {
    const size = fs.statSync(filePath).size;
    const token = encodeBase64EncodedStringForUpload(fileEncSha256B64);
    const errors = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      const conn = await sock.refreshMediaConn(attempt > 1);
      for (const host of conn.hosts) {
        if (host.maxContentLengthBytes && size > host.maxContentLengthBytes) {
          errors.push(`${host.hostname}: הקובץ (${formatBytes(size)}) גדול מהמקסימום ${formatBytes(host.maxContentLengthBytes)}`);
          continue;
        }
        const url = `https://${host.hostname}${MEDIA_PATH[mediaType]}/${token}?auth=${encodeURIComponent(conn.auth)}&token=${token}`;
        try {
          const { status, body } = await post(url, filePath, size, (done, total) =>
            log(`  ⬆ העלאה: ${formatBytes(done)} / ${formatBytes(total)}`),
          );
          let json;
          try {
            json = JSON.parse(body);
          } catch {}
          if (json?.url || json?.direct_path) {
            return { mediaUrl: json.url, directPath: json.direct_path, meta_hmac: json.meta_hmac, fbid: json.fbid, ts: json.ts };
          }
          errors.push(`${host.hostname}: HTTP ${status} ${String(body).slice(0, 200)}`);
        } catch (e) {
          errors.push(`${host.hostname}: ${e.message}`);
        }
      }
      if (errors.every((e) => /BAD_FILE_SIZE|HTTP 413|גדול מהמקסימום/.test(e))) break; // retrying won't help
      log(`  ⚠ העלאה נכשלה (ניסיון ${attempt}/3): ${errors.at(-1)}`);
    }
    const err = new Error(`העלאת הסרטון לוואטסאפ נכשלה – ${[...new Set(errors)].slice(-3).join(" | ")}`);
    err.tooLarge = errors.every((e) => /BAD_FILE_SIZE|HTTP 413|גדול מהמקסימום/.test(e));
    throw err;
  };
}
