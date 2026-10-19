// HTTP server: the admin panel (/admin) and its JSON API.
// Reachable only from the phone itself unless ALLOW_LAN=1.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { ALLOW_LAN, APP_DIR, DATA_DIR, PORT } from "./config.js";
import {
  customerName,
  customerSession,
  deleteNotice,
  deliveredCount,
  addManager,
  queueBlock,
  queueLogout,
  queueNotice,
  queueReset,
  queueSync,
  queueSyncAll,
  queueUnblock,
  requestResend,
  renewLinksOnNextSync,
  resetAllOnNextSync,
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
  episodeLocalBytes,
  formatBytes,
  localSourcePath,
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
    resetPending: !!c.resetPending,
    canMessage: c.status !== "blocked" && !!c.groupJid && customerSession(c.id).isLinked(),
    inviteLink: c.inviteLink || null,
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
    parts: plan?.parts.length || null,
    wholeFile: plan?.kind === "document",
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
  notices: (db().notices || []).slice(-20).reverse(),
}));

// Delete a sent message from the groups it reached.
route("DELETE", /^\/api\/notices\/([\w-]+)$/, (_req, [id]) => {
  const notice = (db().notices || []).find((n) => n.id === id);
  if (!notice) throw new Error("ההודעה לא נמצאה");
  let count = 0;
  for (const rec of notice.recipients) {
    const c = getCustomer(rec.id);
    if (!c || rec.status !== "sent") continue;
    count++;
    enqueue(`unnotice:${id}:${c.id}`, `מחיקת הודעה אצל ${customerName(c)}`, async () => {
      const done = await deleteNotice(c, rec);
      rec.status = "deleted";
      if (!done) rec.error = "הקבוצה כבר הוחלפה";
      save();
    });
  }
  notice.deletedAt = Date.now();
  save();
  return { count };
});

// Adds the manager to a customer's episodes group (or sends the manager an invite).
route("POST", /^\/api\/customers\/([\w-]+)\/add-manager$/, (_req, [id]) => {
  const c = mustCustomer(id);
  return { queued: enqueue(`addmgr:${id}`, `צירוף המנהל לקבוצה של ${customerName(c)}`, () => addManager(c)) };
});

// Messages from the manager to customers' groups, with a small history.
route("POST", /^\/api\/notices$/, async (req) => {
  const b = await readJson(req);
  const text = String(b.text || "").trim();
  if (!text) throw new Error("כתוב הודעה");
  if (text.length > 3000) throw new Error("ההודעה ארוכה מדי");
  const list = (b.customerIds || []).map(getCustomer).filter(Boolean);
  if (!list.length) throw new Error("בחר לפחות לקוח אחד");
  const notice = {
    id: newId(),
    text,
    at: Date.now(),
    recipients: list.map((c) => ({ id: c.id, name: customerName(c), status: "pending" })),
  };
  db().notices = [...(db().notices || []), notice].slice(-50);
  save();
  for (const c of list) {
    const rec = notice.recipients.find((x) => x.id === c.id);
    queueNotice(c, text, (ok, error, info) => {
      rec.status = ok ? "sent" : "failed";
      if (error) rec.error = error;
      if (info) Object.assign(rec, info); // message key: to delete it later
      save();
    });
  }
  addLog(`📢 הודעה נשלחת ל-${list.length} לקוחות`);
  return { count: list.length };
});

route("PUT", /^\/api\/settings$/, async (req) => {
  const b = await readJson(req);
  const st = settings();
  if (b.keepDays != null) {
    const d = Number(b.keepDays);
    if (!(d >= 0 && d <= 365)) throw new Error("מספר ימים לא תקין");
    st.keepDays = d;
  }
  if (b.reuseUploads != null) st.reuseUploads = !!b.reuseUploads;
  if (b.sendAs === "document" || b.sendAs === "video") st.sendAs = b.sendAs;
  if (b.managerPhone != null) {
    const phone = normalizePhone(b.managerPhone);
    if (phone && phone.length < 10) throw new Error("מספר טלפון לא תקין");
    st.managerPhone = phone;
  }
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
route("POST", /^\/api\/customers\/([\w-]+)\/block$/, (_req, [id]) => {
  const c = mustCustomer(id);
  if (c.status === "blocked") throw new Error("הלקוח כבר חסום");
  return { queued: queueBlock(c) };
});
route("POST", /^\/api\/customers\/([\w-]+)\/reset$/, (_req, [id]) => {
  const c = mustCustomer(id);
  if (c.status === "blocked") throw new Error("הלקוח חסום. בטל קודם את החסימה");
  if (!customerSession(id).isLinked()) throw new Error("הוואטסאפ של הלקוח לא מחובר");
  return { queued: queueReset(c) };
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
route("POST", /^\/api\/reset-all$/, () => {
  const count = resetAllOnNextSync();
  addLog(`♻️ ${count} לקוחות יקבלו קבוצה חדשה בסנכרון הבא`);
  return { count };
});

// Episodes
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
    if (ep.source.type !== "file") throw new Error("זה פרק ישן מדרייב. השתמש ב\"החלפת הסרטון\"");
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
    if (req.method === "GET" && url.pathname === "/logo.jpg") {
      res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "max-age=86400" });
      return res.end(fs.readFileSync(path.join(APP_DIR, "assets", "logo-192.jpg")));
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

// One time per such version: every customer gets a new group (this time: with the new logo).
const RESET_FLAGS = [
  "resetForFilesDone",
  "resetForLogoDone",
  "resetForThumbDone",
  "resetForNoDeleteRuleDone",
  "resetForInviteRuleDone",
];
if (RESET_FLAGS.some((f) => !settings()[f])) {
  resetAllOnNextSync();
  for (const f of RESET_FLAGS) settings()[f] = true;
  save();
}

// One time: fresh invite links for every group (the old ones may have been shared).
if (!settings().linksRenewedDone) {
  renewLinksOnNextSync();
  settings().linksRenewedDone = true;
  save();
}

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
