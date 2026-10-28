// Pushes the public summary to Firestore, where the public page (Firebase Hosting) reads it.
// The bot signs in as a dedicated Firebase Auth user that may write only this document.
// Config: DATA_DIR/firebase-writer.json (set from the admin page) or ./firebase-writer.json (bundled).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export function createPublisher(dataDir) {
  const localFile = path.join(dataDir, "firebase-writer.json");
  const bundledFile = path.join(here, "..", "firebase-writer.json");
  let token = null; // { idToken, refreshToken, expiresAt }
  const state = { lastOkAt: null, lastError: null };

  function config() {
    for (const f of [localFile, bundledFile]) {
      try {
        const c = JSON.parse(fs.readFileSync(f, "utf8"));
        if (c.projectId && c.apiKey && c.email && c.password) return c;
      } catch {}
    }
    return null;
  }

  function setConfig(json) {
    const c = typeof json === "string" ? JSON.parse(json) : json;
    for (const k of ["projectId", "apiKey", "email", "password"]) if (!c[k]) throw new Error(`חסר ${k}`);
    fs.writeFileSync(localFile, JSON.stringify(c, null, 2));
    token = null;
  }

  async function auth(c) {
    if (token && token.expiresAt > Date.now() + 60_000) return token.idToken;
    let res;
    if (token?.refreshToken) {
      res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${c.apiKey}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(token.refreshToken)}`,
      });
      const j = await res.json();
      if (res.ok) {
        token = { idToken: j.id_token, refreshToken: j.refresh_token, expiresAt: Date.now() + j.expires_in * 1000 };
        return token.idToken;
      }
    }
    res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${c.apiKey}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: c.email, password: c.password, returnSecureToken: true }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(`התחברות ל-Firebase נכשלה: ${j.error?.message || res.status}`);
    token = { idToken: j.idToken, refreshToken: j.refreshToken, expiresAt: Date.now() + j.expiresIn * 1000 };
    return token.idToken;
  }

  async function publish(summary) {
    const c = config();
    if (!c) throw new Error("אין הגדרות Firebase");
    const idToken = await auth(c);
    const docPath = c.docPath || "onegShabat/live";
    const url = `https://firestore.googleapis.com/v1/projects/${c.projectId}/databases/(default)/documents/${docPath}`;
    const res = await fetch(url, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${idToken}` },
      body: JSON.stringify({
        fields: {
          json: { stringValue: JSON.stringify(summary) },
          updatedAt: { timestampValue: new Date().toISOString() },
        },
      }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      if (res.status === 401) token = null;
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
