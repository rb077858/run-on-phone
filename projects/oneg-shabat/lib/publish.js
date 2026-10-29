// Pushes the public summary to Firestore, where the public page (Firebase Hosting) reads it.
// The Firestore rules accept a write only together with a write to a secret key document
// (onegShabatKeys/<writeKey>) carrying the same fresh nonce, so only holders of the key can write.
// Config: DATA_DIR/firebase-writer.json (set from the admin page) or ./firebase-writer.json (bundled).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export function createPublisher(dataDir) {
  const localFile = path.join(dataDir, "firebase-writer.json");
  const bundledFile = path.join(here, "..", "firebase-writer.json");
  const state = { lastOkAt: null, lastError: null };

  function config() {
    for (const f of [localFile, bundledFile]) {
      try {
        const c = JSON.parse(fs.readFileSync(f, "utf8"));
        if (c.projectId && c.writeKey) return c;
      } catch {}
    }
    return null;
  }

  function setConfig(json) {
    const c = typeof json === "string" ? JSON.parse(json) : json;
    for (const k of ["projectId", "writeKey"]) if (!c[k]) throw new Error(`חסר ${k}`);
    fs.writeFileSync(localFile, JSON.stringify(c, null, 2));
  }

  async function publish(summary) {
    const c = config();
    if (!c) throw new Error("אין הגדרות Firebase");
    const docs = `projects/${c.projectId}/databases/(default)/documents`;
    const nonce = crypto.randomBytes(16).toString("hex");
    const now = new Date().toISOString();
    const res = await fetch(`https://firestore.googleapis.com/v1/${docs}:commit` + (c.apiKey ? `?key=${c.apiKey}` : ""), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        writes: [
          { update: { name: `${docs}/onegShabatKeys/${c.writeKey}`, fields: { nonce: { stringValue: nonce } } } },
          {
            update: {
              name: `${docs}/${c.docPath || "onegShabat/live"}`,
              fields: { json: { stringValue: JSON.stringify(summary) }, nonce: { stringValue: nonce }, updatedAt: { timestampValue: now } },
            },
          },
        ],
      }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(`כתיבה ל-Firestore נכשלה: ${j.error?.message || res.status}`);
    }
    state.lastOkAt = Date.now();
    state.lastError = null;
  }

  return {
    state,
    publish: (s) =>
      publish(s).catch((e) => {
        state.lastError = e.message;
        throw e;
      }),
    config,
    setConfig,
    publicUrl: () => config()?.publicUrl || null,
  };
}
