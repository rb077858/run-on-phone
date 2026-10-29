// Oneg Shabat bot: follows the polls of the "עונג שבת" WhatsApp group and keeps a live summary.
// Every few minutes (default 5) it syncs: refreshes the group, recomputes the summary of the day
// (ignoring the location/time choices of people who answered they are not coming), stores it
// and pushes it to the public page.
//   /          public summary (also on Firebase Hosting, see README.md)
//   /admin     admin panel: only from the device that runs the bot (127.0.0.1)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, prune } from "./lib/db.js";
import { activeDay, attendance, autoKind, autoRole, computeSummary, daysWithPolls, dayOf, optionKind, personKey, personName, pollRole, redact, summaryText } from "./lib/summary.js";
import { createWhatsApp } from "./lib/wa.js";
import { createPublisher } from "./lib/publish.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(here, "data"));
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = openDb(DATA_DIR);
const publisher = createPublisher(DATA_DIR);
let syncTimer = null;
let lastPublishedJson = null;

const wa = createWhatsApp({ db, dataDir: DATA_DIR, onChange: () => {} });

// ------------------------------------------------------------------- sync
function groupJid() {
  const s = db.data.settings;
  if (s.groupJid) return s.groupJid;
  const norm = (t) => (t || "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const want = norm(s.groupNameMatch);
  const match = Object.entries(db.data.groups).find(([, g]) => want && norm(g.subject).includes(want));
  return match?.[0] || null;
}

function buildSnapshot() {
  const s = db.data.settings;
  const jid = groupJid();
  const day = activeDay(db, jid);
  const final = db.data.finals[day];
  const now = Date.now();
  const base = final || computeSummary(db, { groupJid: jid, day, now });
  return {
    ...base,
    title: s.title,
    notice: s.notice,
    status: final ? "final" : s.paused ? "paused" : "live",
    groupFound: !!jid,
    syncedAt: now,
    intervalMin: s.intervalMin,
    nextSyncAt: final || s.paused ? null : now + s.intervalMin * 60_000,
  };
}

async function sync(reason = "timer") {
  const s = db.data.settings;
  try {
    await wa.refreshGroups().catch((e) => console.error("group refresh failed:", e.message));
    wa.retryPending();
    prune(db);
    const snap = buildSnapshot();
    db.data.snapshot = snap;
    db.data.lastSyncAt = snap.syncedAt;
    db.save();
    const pub = redact(snap, s.showNames);
    if (s.publicEnabled && publisher.config()) {
      const json = JSON.stringify({ ...pub, syncedAt: 0, nextSyncAt: 0 });
      // Skip identical writes, but still refresh the "updated at" line every 30 minutes.
      const stale = !publisher.state.lastOkAt || Date.now() - publisher.state.lastOkAt > 30 * 60_000;
      if (json !== lastPublishedJson || stale || reason !== "timer") {
        await publisher.publish(pub).then(
          () => (lastPublishedJson = json),
          (e) => console.error("public publish failed:", e.message),
        );
      }
    }
    const a = snap.attendance;
    console.log(
      `🔄 sync (${reason}) ${snap.day}: ${snap.polls.length} polls` +
        (a ? `, coming ${a.coming}, not coming ${a.notComing}` : "") +
        (snap.status !== "live" ? ` [${snap.status}]` : ""),
    );
  } catch (e) {
    console.error("sync failed:", e);
  }
}

function schedule() {
  clearTimeout(syncTimer);
  const ms = Math.max(1, Number(db.data.settings.intervalMin) || 5) * 60_000;
  syncTimer = setTimeout(async () => {
    if (!db.data.settings.paused) await sync("timer");
    schedule();
  }, ms);
}

// ------------------------------------------------------------------ admin
function adminState() {
  const s = db.data.settings;
  const jid = groupJid();
  const day = activeDay(db, jid);
  const polls = Object.values(db.data.polls)
    .filter((p) => p.chat === jid && dayOf(p.ts) === day)
    .sort((a, b) => a.ts - b.ts)
    .map((p) => ({
      id: p.id,
      question: p.question,
      options: p.options,
      ts: p.ts * 1000,
      hidden: !!p.config?.hidden,
      roleSetting: p.config?.role || "auto",
      role: pollRole(p),
      autoRole: autoRole(p),
      kinds: p.options.map((o) => optionKind(p, o)),
      autoKinds: p.options.map(autoKind),
      votes: Object.keys(p.votes || {}).length,
    }));
  // Everyone in the group or who voted today, for manual overrides and nicknames.
  const keys = new Set((db.data.groups[jid]?.participants || []).map((j) => personKey(db, j)));
  for (const p of Object.values(db.data.polls))
    if (p.chat === jid && dayOf(p.ts) === day) for (const v of Object.keys(p.votes || {})) keys.add(personKey(db, v));
  const status = attendance(db, jid, day);
  const overrides = db.data.overrides[day] || {};
  const people = [...keys]
    .map((key) => {
      const st = status.get(key);
      return {
        key,
        name: personName(db, key),
        nickname: db.data.nicknames[key] || "",
        override: overrides[key] || null,
        status: st?.status || "none",
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "he"));
  return {
    wa: {
      status: wa.state.status,
      qr: wa.state.qrDataUrl,
      me: wa.state.me?.id?.split(":")[0] || null,
      error: wa.state.error,
      // Pairing codes are valid for a few minutes.
      pairing: wa.state.pairing && Date.now() - wa.state.pairing.at < 3 * 60_000 ? wa.state.pairing : null,
    },
    settings: s,
    groupJid: jid,
    groups: Object.entries(db.data.groups)
      .map(([id, g]) => ({ id, subject: g.subject, size: g.participants.length }))
      .sort((a, b) => a.subject.localeCompare(b.subject, "he")),
    day,
    days: daysWithPolls(db, jid),
    finalDays: Object.keys(db.data.finals).sort().reverse(),
    isFinal: !!db.data.finals[day],
    polls,
    people,
    snapshot: db.data.snapshot,
    pendingVotes: db.data.pendingVotes.length,
    publish: { configured: !!publisher.config(), ...publisher.state, url: publisher.publicUrl() },
  };
}

async function adminAction(body) {
  const s = db.data.settings;
  const day = activeDay(db, groupJid());
  switch (body.action) {
    case "pause":
      s.paused = true;
      break;
    case "resume":
      s.paused = false;
      break;
    case "sync":
      break;
    case "finalize":
      db.data.finals[day] = { ...computeSummary(db, { groupJid: groupJid(), day }), finalizedAt: Date.now() };
      break;
    case "unfinalize":
      delete db.data.finals[day];
      break;
    case "settings": {
      const allowed = ["title", "notice", "intervalMin", "showNames", "publicEnabled", "groupJid", "groupNameMatch", "dayMode"];
      for (const k of allowed) if (k in body.settings) s[k] = body.settings[k];
      s.intervalMin = Math.min(120, Math.max(1, Number(s.intervalMin) || 5));
      if (s.groupJid === "") s.groupJid = null;
      break;
    }
    case "poll": {
      const poll = db.data.polls[body.id];
      if (!poll) throw new Error("סקר לא נמצא");
      poll.config ??= {};
      if ("hidden" in body) poll.config.hidden = !!body.hidden;
      if ("role" in body) poll.config.role = body.role;
      if ("kind" in body) {
        poll.config.kinds ??= {};
        if (body.kind) poll.config.kinds[body.option] = body.kind;
        else delete poll.config.kinds[body.option];
      }
      break;
    }
    case "person": {
      if ("override" in body) {
        const o = (db.data.overrides[day] ??= {});
        if (body.override) o[body.key] = body.override;
        else delete o[body.key];
      }
      if ("nickname" in body) {
        if (body.nickname?.trim()) db.data.nicknames[body.key] = body.nickname.trim();
        else delete db.data.nicknames[body.key];
      }
      break;
    }
    case "pair":
      return { code: await wa.requestPairingCode(body.phone) };
    case "logout":
      await wa.logout();
      return {};
    case "text":
      return { text: summaryText(db.data.snapshot || buildSnapshot()) };
    case "sendSelf":
      await wa.sendToSelf(summaryText(db.data.snapshot || buildSnapshot()));
      return {};
    case "firebase":
      publisher.setConfig(body.json);
      lastPublishedJson = null;
      break;
    case "firebaseShow":
      return { json: JSON.stringify(publisher.config(), null, 2) };
    default:
      throw new Error("פעולה לא מוכרת");
  }
  db.save();
  await sync("manual");
  schedule();
  return {};
}

// ----------------------------------------------------------------- server
const isLocal = (req) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function serveFile(res, file) {
  fs.readFile(path.join(here, "public", file), (err, buf) => {
    if (err) return send(res, 404, "not found", "text/plain");
    send(res, 200, buf, TYPES[path.extname(file)] || "application/octet-stream");
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 200_000) reject(new Error("too large"));
      else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (e) {
        reject(e);
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  try {
    if (p === "/" || p === "/index.html") return serveFile(res, "index.html");
    if (p === "/config.js") return send(res, 200, `window.ONEG_CONFIG = { source: "local" };`, TYPES[".js"]);
    if (p === "/api/summary") {
      const snap = db.data.snapshot || buildSnapshot();
      return send(res, 200, redact(snap, db.data.settings.showNames));
    }
    if (["/style.css", "/app.js", "/favicon.svg"].includes(p)) return serveFile(res, p.slice(1));

    if (p === "/admin" || p === "/qr" || p.startsWith("/api/admin") || p === "/admin.js") {
      if (!isLocal(req)) return send(res, 403, "<h2 dir=rtl style='font-family:sans-serif'>ממשק הניהול זמין רק מהמכשיר שמריץ את הבוט</h2>", TYPES[".html"]);
      if (p === "/admin" || p === "/qr") return serveFile(res, "admin.html");
      if (p === "/admin.js") return serveFile(res, "admin.js");
      if (p === "/api/admin/state") return send(res, 200, adminState());
      if (p === "/api/admin" && req.method === "POST") return send(res, 200, { ok: true, ...(await adminAction(await readBody(req))) });
    }
    send(res, 404, "not found", "text/plain");
  } catch (e) {
    send(res, 400, { ok: false, error: e.message });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 summary: http://127.0.0.1:${PORT}/   admin: http://127.0.0.1:${PORT}/admin`);
  console.log(`📁 data: ${DATA_DIR}`);
});

wa.start().catch((e) => console.error("WhatsApp start failed:", e));
setTimeout(() => sync("startup"), 20_000);
schedule();

function shutdown() {
  console.log("stopping…");
  clearTimeout(syncTimer);
  db.flush();
  wa.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("unhandledRejection", (e) => console.error("unhandled:", e?.message || e));
