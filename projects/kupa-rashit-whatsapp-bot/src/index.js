// HTTP server: admin panel (/admin), WhatsApp linking pages (/qr, /connect/:id) and a
// small JSON API. Reachable only from the phone itself unless ALLOW_LAN=1.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { ALLOW_LAN, APP_DIR, DATA_DIR, PORT } from "./config.js";
import {
  customerName,
  customerSession,
  queueLogout,
  queueSync,
  queueSyncAll,
  queueUnblock,
} from "./customers.js";
import { db, getCustomer, newId, normalizePhone, removeEpisode, save, sortedEpisodes, upsertEpisode } from "./db.js";
import { addLog, enqueue, jobsStatus } from "./jobs.js";
import { managerSession, startManager } from "./manager.js";
import { clearDriveCache, deleteSourceFile, driveLink, ensureDriveFile, parseDriveLink, saveUpload, storageInfo } from "./media.js";
import { stopAll } from "./wa.js";

const PAGES = {
  "/admin": "admin.html",
  "/qr": "connect.html",
};

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

const getSession = (id) => (id === "manager" ? managerSession() : getCustomer(id) ? customerSession(id) : null);

function customerView(c) {
  const s = customerSession(c.id).status();
  return {
    ...c,
    name: customerName(c),
    sentCount: c.sent?.length || 0,
    sent: undefined,
    blockMsg: undefined,
    wa: { state: s.state, linked: s.linked, error: s.error },
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

// ------------------------------------------------------------------ routes
const routes = [];
const route = (method, pattern, fn) => routes.push({ method, pattern, fn });

route("GET", /^\/api\/state$/, () => ({
  manager: { ...managerSession().status(), qr: undefined, groupJid: db().manager.groupJid },
  customers: db().customers.map(customerView),
  episodes: sortedEpisodes().map((e) => ({ ...e, link: e.source.type === "drive" ? driveLink(e.source.fileId) : null })),
  jobs: jobsStatus(),
  storage: storageInfo(),
}));

// WhatsApp linking (manager or customer)
route("GET", /^\/api\/session\/([\w-]+)$/, (_req, [id]) => {
  const s = getSession(id);
  if (!s) throw new Error("לא נמצא");
  const c = getCustomer(id);
  return { ...s.status(), title: c ? customerName(c) : "מנהל", phone: c ? normalizePhone(c.phone) : null };
});
route("POST", /^\/api\/session\/([\w-]+)\/start$/, async (_req, [id]) => {
  const s = getSession(id);
  if (!s) throw new Error("לא נמצא");
  await s.start();
  s.touch();
  return { ok: true };
});
route("POST", /^\/api\/session\/([\w-]+)\/pair$/, async (req, [id]) => {
  const s = getSession(id);
  if (!s) throw new Error("לא נמצא");
  const body = await readJson(req);
  const c = getCustomer(id);
  const phone = normalizePhone(c ? c.phone : body.phone);
  if (phone.length < 10) throw new Error("מספר טלפון לא תקין");
  await s.requestPairingCode(phone);
  return { ok: true };
});
route("POST", /^\/api\/session\/manager\/logout$/, async () => {
  await managerSession().logout();
  setTimeout(() => managerSession().start(), 500);
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
    createdAt: Date.now(),
  };
  db().customers.push(c);
  save();
  addLog(`➕ לקוח חדש: ${customerName(c)}`);
  return customerView(c);
});
route("PUT", /^\/api\/customers\/([\w-]+)$/, async (req, [id]) => {
  const c = getCustomer(id);
  if (!c) throw new Error("לא נמצא");
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
  const c = getCustomer(id);
  if (!c) throw new Error("לא נמצא");
  enqueue(`delete:${id}`, `מחיקת לקוח ${customerName(c)}`, async () => {
    await customerSession(id).logout();
    db().customers = db().customers.filter((x) => x.id !== id);
    save();
    addLog(`🗑 הלקוח ${customerName(c)} נמחק`);
  });
  return { ok: true };
});
route("POST", /^\/api\/customers\/([\w-]+)\/sync$/, (_req, [id]) => {
  const c = getCustomer(id);
  if (!c) throw new Error("לא נמצא");
  return { queued: queueSync(c) };
});
route("POST", /^\/api\/customers\/([\w-]+)\/unblock$/, (_req, [id]) => {
  const c = getCustomer(id);
  if (!c || c.status !== "blocked") throw new Error("הלקוח לא חסום");
  return { queued: queueUnblock(c) };
});
route("POST", /^\/api\/customers\/([\w-]+)\/logout$/, (_req, [id]) => {
  const c = getCustomer(id);
  if (!c) throw new Error("לא נמצא");
  return { queued: queueLogout(c) };
});
route("POST", /^\/api\/sync-all$/, () => ({ count: queueSyncAll() }));

// Episodes
route("POST", /^\/api\/episodes$/, async (req) => {
  const b = await readJson(req);
  const fields = parseEpisodeFields(b);
  const drive = parseDriveLink(b.link);
  if (!drive) throw new Error("קישור לדרייב לא תקין");
  const old = db().episodes.find((e) => e.id === b.id);
  if (old && (old.season !== fields.season || old.episode !== fields.episode)) removeEpisode(old.id);
  const prev = db().episodes.find((e) => e.season === fields.season && e.episode === fields.episode)?.source;
  const { episode } = upsertEpisode({ ...fields, source: { type: "drive", fileId: drive.fileId, link: drive.link } });
  if (prev?.type === "file") deleteSourceFile(prev);
  if (old && old.source.type === "file" && old.id !== episode.id) deleteSourceFile(old.source);
  addLog(`➕ פרק נשמר: עונה ${fields.season} פרק ${fields.episode}`);
  ensureDriveFile(drive.fileId).catch((e) => addLog(`⚠ עונה ${fields.season} פרק ${fields.episode}: ${e.message}`));
  return episode;
});
// Edit season/episode/title without changing the video.
route("PUT", /^\/api\/episodes\/([\w-]+)$/, async (req, [id]) => {
  const ep = db().episodes.find((e) => e.id === id);
  if (!ep) throw new Error("לא נמצא");
  const fields = parseEpisodeFields(await readJson(req));
  const clash = db().episodes.find((e) => e.id !== id && e.season === fields.season && e.episode === fields.episode);
  if (clash) throw new Error("כבר קיים פרק עם אותה עונה ומספר פרק");
  Object.assign(ep, fields, { updatedAt: Date.now() });
  save();
  return ep;
});
route("DELETE", /^\/api\/episodes\/([\w-]+)$/, (_req, [id]) => {
  const ep = db().episodes.find((e) => e.id === id);
  if (!ep) throw new Error("לא נמצא");
  removeEpisode(id);
  deleteSourceFile(ep.source);
  addLog(`🗑 נמחק: עונה ${ep.season} פרק ${ep.episode}`);
  return { ok: true };
});
// Raw video bytes in the body; season/episode/title in the query string.
route("POST", /^\/api\/episodes\/upload$/, async (req) => {
  const q = Object.fromEntries(new URL(req.url, "http://x").searchParams);
  const fields = parseEpisodeFields(q);
  const file = await saveUpload(req);
  const prev = db().episodes.find((e) => e.season === fields.season && e.episode === fields.episode)?.source;
  const { episode } = upsertEpisode({ ...fields, source: { type: "file", file } });
  if (prev?.type === "file") deleteSourceFile(prev);
  addLog(`➕ פרק הועלה: עונה ${fields.season} פרק ${fields.episode}`);
  return episode;
});

route("POST", /^\/api\/cache\/clear$/, () => {
  clearDriveCache();
  return { ok: true };
});

// ------------------------------------------------------------------ server
const server = http.createServer(async (req, res) => {
  if (!ALLOW_LAN && !isLocal(req)) return send(res, 403, "Only from the phone", "text/plain; charset=utf-8");
  const url = new URL(req.url, "http://x");
  try {
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(302, { location: "/admin" });
      return res.end();
    }
    const page = PAGES[url.pathname] || (/^\/connect\/[\w-]+$/.test(url.pathname) ? "connect.html" : null);
    if (req.method === "GET" && page) {
      return send(res, 200, fs.readFileSync(path.join(APP_DIR, "public", page)), "text/html; charset=utf-8");
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

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Kupa Rashit bot: http://127.0.0.1:${PORT}/admin  (data in ${DATA_DIR})`);
  startManager();
});

function shutdown() {
  console.log("stopping");
  stopAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
