// HTTP server: the admin panel (/admin) and its JSON API.
// Reachable only from the phone itself unless ALLOW_LAN=1.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { ALLOW_LAN, APP_DIR, DATA_DIR, PORT } from "./config.js";
import {
  customerName,
  customerSession,
  deliveredCount,
  queueLogout,
  queueSync,
  queueSyncAll,
  queueUnblock,
  requestResend,
} from "./customers.js";
import {
  db,
  getCustomer,
  newId,
  normalizePhone,
  removeEpisode,
  save,
  settings,
  sortedEpisodes,
  upsertEpisode,
} from "./db.js";
import { mediaPlan } from "./delivery.js";
import { addLog, enqueue, isIdle, jobsStatus } from "./jobs.js";
import {
  cleanupLocal,
  deleteSourceFile,
  driveLink,
  ensureDriveFile,
  episodeLocalBytes,
  formatBytes,
  localSourcePath,
  parseDriveLink,
  saveUpload,
  storageInfo,
} from "./media.js";
import { stopAll } from "./wa.js";

const isLocal = (req) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(type.startsWith("application/json") ? JSON.stringify(body) : body);
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1e6) throw new Error("too large");
  }
  return raw ? JSON.parse(raw) : {};
}

const mustCustomer = (id) => {
  const c = getCustomer(id);
  if (!c) throw new Error("הלקוח לא נמצא");
  return c;
};
const mustEpisode = (id) => {
  const ep = db().episodes.find((e) => e.id === id);
  if (!ep) throw new Error("הפרק לא נמצא");
  return ep;
};

function customerView(c) {
  const s = customerSession(c.id).status();
  return {
    id: c.id,
    firstName: c.firstName,
    lastName: c.lastName,
    name: customerName(c),
    phone: c.phone,
    status: c.status,
    blockedReason: c.blockedReason,
    lastSync: c.lastSync,
    delivered: deliveredCount(c),
    requests: (c.inbox || []).length,
    wa: { state: s.state, linked: s.linked, error: s.error },
  };
}

function episodeView(ep) {
  const plan = mediaPlan(ep);
  return {
    id: ep.id,
    season: ep.season,
    episode: ep.episode,
    title: ep.title || "",
    type: ep.source.type,
    link: ep.source.type === "drive" ? driveLink(ep.source.fileId) : null,
    parts: plan?.parts.length || null,
    uploaded: !!plan?.parts.every((p) => p.ref),
    onPhone: !!localSourcePath(ep.source) || !!ep.localFiles?.length,
    localBytes: episodeLocalBytes(ep),
    // An uploaded file that was deleted from the phone can't be uploaded again by the bot.
    fileGone: ep.source.type === "file" && !localSourcePath(ep.source),
    lastUsed: ep.lastUsed || ep.addedAt,
  };
}

function parseEpisodeFields(body) {
  const season = Number(body.season);
  const episode = Number(body.episode);
  if (!Number.isInteger(season) || season < 0 || !Number.isInteger(episode) || episode < 0) {
    throw new Error("עונה ופרק חייבים להיות מספרים");
  }
  return { season, episode, title: String(body.title || "").trim() };
}

const clash = (fields, exceptId) =>
  db().episodes.find((e) => e.id !== exceptId && e.season === fields.season && e.episode === fields.episode);

function runCleanup(force = false) {
  const freed = cleanupLocal(db().episodes, Number(settings().keepDays) || 0, force);
  save();
  if (freed) addLog(`🧹 נמחקו מהטלפון ${formatBytes(freed)} של סרטונים ישנים`);
  return freed;
}

// ------------------------------------------------------------------ routes
const routes = [];
const route = (method, pattern, fn) => routes.push({ method, pattern, fn });

route("GET", /^\/api\/state$/, () => ({
  customers: db().customers.map(customerView),
  episodes: sortedEpisodes().map(episodeView),
  jobs: jobsStatus(),
  storage: storageInfo(),
  settings: settings(),
}));

route("PUT", /^\/api\/settings$/, async (req) => {
  const b = await readJson(req);
  const st = settings();
  if (b.keepDays != null) {
    const d = Number(b.keepDays);
    if (!(d >= 0 && d <= 365)) throw new Error("מספר ימים לא תקין");
    st.keepDays = d;
  }
  if (b.reuseUploads != null) st.reuseUploads = !!b.reuseUploads;
  if (b.resetMaxVideo) st.maxVideoBytes = null;
  save();
  return st;
});
route("POST", /^\/api\/cleanup$/, () => {
  if (!isIdle()) throw new Error("יש סנכרון פעיל. נסה שוב כשהוא יסתיים");
  return { freed: runCleanup(true) };
});

// WhatsApp linking of a customer
route("GET", /^\/api\/customers\/([\w-]+)\/wa$/, (_req, [id]) => {
  const c = mustCustomer(id);
  return { ...customerSession(id).status(), name: customerName(c), phone: c.phone };
});
route("POST", /^\/api\/customers\/([\w-]+)\/wa\/start$/, async (_req, [id]) => {
  mustCustomer(id);
  const s = customerSession(id);
  await s.start();
  s.touch();
  return { ok: true };
});
route("POST", /^\/api\/customers\/([\w-]+)\/wa\/pair$/, async (_req, [id]) => {
  const c = mustCustomer(id);
  await customerSession(id).requestPairingCode(normalizePhone(c.phone));
  return { ok: true };
});

// Customers
route("POST", /^\/api\/customers$/, async (req) => {
  const b = await readJson(req);
  const phone = normalizePhone(b.phone);
  if (!String(b.firstName || "").trim() || phone.length < 10) throw new Error("חובה שם פרטי ומספר טלפון תקין");
  if (db().customers.some((c) => normalizePhone(c.phone) === phone)) throw new Error("כבר קיים לקוח עם המספר הזה");
  const c = {
    id: newId(),
    firstName: String(b.firstName).trim(),
    lastName: String(b.lastName || "").trim(),
    phone,
    status: "new",
    groupJid: null,
    sent: [],
    inbox: [],
    createdAt: Date.now(),
  };
  db().customers.push(c);
  save();
  addLog(`➕ לקוח חדש: ${customerName(c)}`);
  return customerView(c);
});
route("PUT", /^\/api\/customers\/([\w-]+)$/, async (req, [id]) => {
  const c = mustCustomer(id);
  const b = await readJson(req);
  if (b.firstName != null) c.firstName = String(b.firstName).trim();
  if (b.lastName != null) c.lastName = String(b.lastName).trim();
  if (b.phone != null) {
    const phone = normalizePhone(b.phone);
    if (phone.length < 10) throw new Error("מספר טלפון לא תקין");
    if (phone !== c.phone && customerSession(id).isLinked()) throw new Error("אי אפשר לשנות מספר ללקוח מחובר. נתק קודם.");
    c.phone = phone;
  }
  save();
  return customerView(c);
});
route("DELETE", /^\/api\/customers\/([\w-]+)$/, (_req, [id]) => {
  const c = mustCustomer(id);
  enqueue(`delete:${id}`, `מחיקת לקוח ${customerName(c)}`, async () => {
    await customerSession(id).logout();
    db().customers = db().customers.filter((x) => x.id !== id);
    save();
    addLog(`🗑 הלקוח ${customerName(c)} נמחק`);
  });
  return { ok: true };
});
route("POST", /^\/api\/customers\/([\w-]+)\/sync$/, (_req, [id]) => ({ queued: queueSync(mustCustomer(id)) }));
route("POST", /^\/api\/customers\/([\w-]+)\/unblock$/, (_req, [id]) => {
  const c = mustCustomer(id);
  if (c.status !== "blocked") throw new Error("הלקוח לא חסום");
  return { queued: queueUnblock(c) };
});
route("POST", /^\/api\/customers\/([\w-]+)\/logout$/, (_req, [id]) => ({ queued: queueLogout(mustCustomer(id)) }));
route("POST", /^\/api\/customers\/([\w-]+)\/resend$/, async (req, [id]) => {
  const c = mustCustomer(id);
  const { episodeId } = await readJson(req);
  const ep = mustEpisode(episodeId);
  requestResend(c, ep.id);
  addLog(`📥 ${customerName(c)}: עונה ${ep.season} פרק ${ep.episode} יישלח שוב בסנכרון`);
  return { queued: queueSync(c) };
});
route("POST", /^\/api\/sync-all$/, () => ({ count: queueSyncAll() }));

// Episodes
route("POST", /^\/api\/episodes$/, async (req) => {
  const b = await readJson(req);
  const fields = parseEpisodeFields(b);
  const drive = parseDriveLink(b.link);
  if (!drive) throw new Error("קישור לדרייב לא תקין");
  const old = b.id ? mustEpisode(b.id) : null;
  const existing = clash(fields, old?.id);
  if (existing && !b.replace) throw new Error("EXISTS");
  if (old && existing) throw new Error("כבר קיים פרק עם אותה עונה ומספר פרק");
  if (old) {
    deleteSourceFile(old.source);
    Object.assign(old, fields, { source: { type: "drive", fileId: drive.fileId, link: drive.link }, updatedAt: Date.now() });
    save();
  } else {
    if (existing) deleteSourceFile(existing.source);
    upsertEpisode({ ...fields, source: { type: "drive", fileId: drive.fileId, link: drive.link } });
  }
  addLog(`➕ פרק נשמר: עונה ${fields.season} פרק ${fields.episode} (דרייב)`);
  // Download now, so a bad link shows up right away.
  ensureDriveFile(drive.fileId).catch((e) => addLog(`⚠ עונה ${fields.season} פרק ${fields.episode}: ${e.message}`));
  return { ok: true };
});
// Edit season/episode/title without changing the video.
route("PUT", /^\/api\/episodes\/([\w-]+)$/, async (req, [id]) => {
  const ep = mustEpisode(id);
  const fields = parseEpisodeFields(await readJson(req));
  if (clash(fields, id)) throw new Error("כבר קיים פרק עם אותה עונה ומספר פרק");
  Object.assign(ep, fields, { updatedAt: Date.now() });
  save();
  return { ok: true };
});
route("DELETE", /^\/api\/episodes\/([\w-]+)$/, (_req, [id]) => {
  const ep = mustEpisode(id);
  removeEpisode(id);
  deleteSourceFile(ep.source);
  addLog(`🗑 נמחק: עונה ${ep.season} פרק ${ep.episode}. בסנכרון הבא הוא יימחק גם אצל הלקוחות`);
  return { ok: true };
});
// Raw video bytes in the body; season/episode/title in the query string.
// With ?id=…&reattach=1 the same video is put back on the phone (same episode, no resend).
route("POST", /^\/api\/episodes\/upload$/, async (req) => {
  const q = Object.fromEntries(new URL(req.url, "http://x").searchParams);
  if (q.reattach) {
    const ep = mustEpisode(q.id);
    if (ep.source.type !== "file") throw new Error("הפרק הזה מדרייב");
    await saveUpload(req, ep.source.file);
    ep.lastUsed = Date.now();
    delete ep.localDeletedAt;
    save();
    addLog(`📁 הסרטון של עונה ${ep.season} פרק ${ep.episode} הוחזר לטלפון`);
    return { ok: true };
  }
  const fields = parseEpisodeFields(q);
  const old = q.id ? mustEpisode(q.id) : null;
  const existing = clash(fields, old?.id);
  if (existing && !q.replace) throw new Error("EXISTS");
  const file = await saveUpload(req);
  if (old) {
    deleteSourceFile(old.source);
    Object.assign(old, fields, { source: { type: "file", file }, lastUsed: Date.now(), updatedAt: Date.now() });
    save();
  } else {
    if (existing) deleteSourceFile(existing.source);
    const { episode } = upsertEpisode({ ...fields, source: { type: "file", file } });
    episode.lastUsed = Date.now();
    save();
  }
  addLog(`➕ פרק הועלה: עונה ${fields.season} פרק ${fields.episode}`);
  return { ok: true };
});

// ------------------------------------------------------------------ server
const server = http.createServer(async (req, res) => {
  if (!ALLOW_LAN && !isLocal(req)) return send(res, 403, "Only from the phone", "text/plain; charset=utf-8");
  const url = new URL(req.url, "http://x");
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/qr")) {
      res.writeHead(302, { location: "/admin" });
      return res.end();
    }
    if (req.method === "GET" && url.pathname === "/admin") {
      return send(res, 200, fs.readFileSync(path.join(APP_DIR, "public", "admin.html")), "text/html; charset=utf-8");
    }
    for (const r of routes) {
      const m = r.method === req.method && url.pathname.match(r.pattern);
      if (m) return send(res, 200, await r.fn(req, m.slice(1)));
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, 400, { error: e.message });
  }
});
server.requestTimeout = 0; // uploads of big videos can take a while

// Older versions linked a manager WhatsApp account; it is no longer used.
fs.rmSync(path.join(DATA_DIR, "sessions", "manager"), { recursive: true, force: true });

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Kupa Rashit bot: http://127.0.0.1:${PORT}/admin  (data in ${DATA_DIR})`);
  runCleanup();
});

// Free space after each round of syncs, and every few hours.
let wasBusy = false;
setInterval(() => {
  const idle = isIdle();
  if (idle && wasBusy) runCleanup();
  wasBusy = !idle;
}, 5000).unref();
setInterval(() => isIdle() && runCleanup(), 6 * 3600_000).unref();

function shutdown() {
  console.log("stopping");
  stopAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
