// Everything done through a customer's own WhatsApp account: creating the
// "קופה ראשית פרקים" group, syncing episodes into it, and blocking / unblocking.
import { generateMessageIDV2, getContentType, jidNormalizedUser, normalizeMessageContent, proto } from "baileys";
import {
  BLOCKED_GROUP_NAME,
  BLOCKED_MESSAGE,
  EPISODES_GROUP_DESC,
  EPISODES_GROUP_NAME,
  WELCOME_MESSAGE,
} from "./config.js";
import { db, findEpisode, getCustomer, normalizePhone, save, sortedEpisodes, sourceKey } from "./db.js";
import { firstUpload, forgetRefChecks, mediaPlan, sendParts } from "./delivery.js";
import { addLog, enqueue } from "./jobs.js";
import { numberOf, session, sleep } from "./wa.js";

export const customerName = (c) => `${c.firstName} ${c.lastName}`.trim();

export const customerSession = (id) => session(id, { onOpen: onCustomerOpen, onMessages: onCustomerMessages });

// Runs every time a customer's WhatsApp connects (including right after linking).
async function onCustomerOpen(s) {
  const c = getCustomer(s.id);
  if (!c) return;
  const number = numberOf(s.sock);
  if (normalizePhone(c.phone) !== number) {
    s.lastError = `חובר המספר +${number} ולא המספר של הלקוח (+${normalizePhone(c.phone)}). החיבור בוטל.`;
    addLog(`✖ ${customerName(c)}: ${s.lastError}`);
    await s.sock.logout().catch(() => {});
    throw new Error(s.lastError);
  }
  c.connectedAs = number;
  if (c.status === "new" || (c.status === "active" && !c.groupJid)) {
    await createEpisodesGroup(c, s.sock);
    c.status = "active";
    addLog(`✔ ${customerName(c)}: וואטסאפ חובר והקבוצה "${EPISODES_GROUP_NAME}" נוצרה`);
  }
  save();
}

// ------------------------------------------------------------------ groups
const tryDo = async (what, fn) => {
  try {
    return await fn();
  } catch (e) {
    console.warn(`${what} failed: ${e.message}`);
  }
};

/** Creates a group that holds only this account, with all settings locked. */
async function createLockedGroup(sock, subject) {
  const meta = await sock.groupCreate(subject, []);
  const jid = meta.id;
  // New groups inherit the account's default disappearing-messages timer. Turn it off.
  await tryDo("ephemeral off", () => sock.groupToggleEphemeral(jid, 0));
  await tryDo("lock info", () => sock.groupSettingUpdate(jid, "locked"));
  await tryDo("admin add only", () => sock.groupMemberAddMode(jid, "admin_add"));
  await tryDo("join approval", () => sock.groupJoinApprovalMode(jid, "on"));
  return jid;
}

async function createEpisodesGroup(c, sock) {
  const jid = await createLockedGroup(sock, EPISODES_GROUP_NAME);
  await tryDo("description", () => sock.groupUpdateDescription(jid, EPISODES_GROUP_DESC));
  await sleep(1500);
  const meta = await tryDo("metadata", () => sock.groupMetadata(jid));
  c.groupJid = jid;
  // Compare later with what WhatsApp actually stored (if setting it failed, the next sync sets it).
  c.groupDesc = meta ? meta.desc || "" : EPISODES_GROUP_DESC;
  c.sent = [];
  c.inbox = [];
  c.welcome = null;
  save();
  await sendWelcome(c, sock);
  return jid;
}

// Texts the bot itself sends in the group. Their echo must not count as a customer request.
const botTextIds = new Set();

/** The pinned "how this group works / how to ask for a video again" message. */
async function sendWelcome(c, sock) {
  const messageId = generateMessageIDV2(sock.user?.id);
  botTextIds.add(messageId);
  const msg = await tryDo("welcome", () => sock.sendMessage(c.groupJid, { text: WELCOME_MESSAGE }, { messageId }));
  if (!msg) return;
  c.welcome = { key: msg.key, timestamp: Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000) };
  save();
  await pinWelcome(c, sock);
}

// A pin lasts at most 30 days, so it is renewed on syncs.
async function pinWelcome(c, sock) {
  if (!c.welcome) return;
  const ok = await tryDo("pin", () =>
    sock.sendMessage(c.groupJid, { pin: c.welcome.key, type: proto.PinInChat.Type.PIN_FOR_ALL, time: 2592000 }),
  );
  if (ok) {
    c.welcome.pinnedAt = Date.now();
    save();
  }
}

const norm = (s) => String(s || "").replace(/\r/g, "").trim();

/** Rule violations in the episodes group (empty array = all good). */
async function violations(c, sock, meta) {
  const reasons = [];
  if (meta.subject !== EPISODES_GROUP_NAME) reasons.push(`שם הקבוצה שונה ל-"${meta.subject}"`);
  if (norm(meta.desc) !== norm(c.groupDesc ?? EPISODES_GROUP_DESC)) reasons.push("תיאור הקבוצה שונה");
  if (meta.participants.length > 1) reasons.push(`צורפו ${meta.participants.length - 1} משתתפים לקבוצה`);
  const picture = await sock.profilePictureUrl(meta.id, "preview").catch(() => null);
  if (picture) reasons.push("נוספה תמונה לקבוצה");
  return reasons;
}

/** Group metadata, or null if the group no longer exists for this account. */
async function groupMeta(sock, jid) {
  try {
    return await sock.groupMetadata(jid);
  } catch (e) {
    const code = e?.output?.statusCode ?? e?.data;
    if ([403, 404, 406, 410].includes(Number(code)) || /not-found|forbidden|not-authorized/.test(e.message)) return null;
    throw e;
  }
}

// --------------------------------------------------------------- messages
async function deleteSent(sock, jid, rec) {
  // Revoke works for everyone but only for ~2 days; delete-for-me always works, and
  // since the group holds only this account, that is what the customer sees.
  await tryDo("revoke", () => sock.sendMessage(jid, { delete: rec.key }));
  await tryDo("delete for me", () =>
    sock.chatModify({ deleteForMe: { key: rec.key, timestamp: rec.timestamp, deleteMedia: true } }, jid),
  );
}

async function leaveAndDeleteChat(sock, jid, lastKey, lastTimestamp) {
  await tryDo("leave", () => sock.groupLeave(jid));
  await sleep(1000);
  const lastMessages = lastKey ? [{ key: lastKey, messageTimestamp: lastTimestamp }] : [];
  await tryDo("delete chat", () => sock.chatModify({ delete: true, lastMessages }, jid));
}

// ------------------------------------------------------------------ inbox
// Messages the customer writes in the episodes group (the bot only sees them while
// connected, or right after connecting – WhatsApp delivers what arrived meanwhile).
// They are requests to resend a video, and are deleted so the group holds only videos.
const IGNORED_TYPES = new Set([
  "videoMessage",
  "protocolMessage",
  "reactionMessage",
  "senderKeyDistributionMessage",
  "messageContextInfo",
  "pollUpdateMessage",
  "pinInChatMessage",
]);

function onCustomerMessages(s, { messages }) {
  const c = getCustomer(s.id);
  if (!c?.groupJid) return;
  let changed = false;
  for (const m of messages) {
    if (m.key.remoteJid !== c.groupJid || !m.message) continue;
    const content = normalizeMessageContent(m.message);
    const type = getContentType(content);
    if (!type || IGNORED_TYPES.has(type)) continue;
    c.inbox ??= [];
    if (botTextIds.has(m.key.id) || m.key.id === c.welcome?.key?.id) continue;
    if (c.inbox.some((x) => x.id === m.key.id) || c.sent?.some((r) => r.key.id === m.key.id)) continue;
    const inner = content[type];
    c.inbox.push({
      id: m.key.id,
      key: m.key,
      timestamp: Number(m.messageTimestamp) || Math.floor(Date.now() / 1000),
      text: (typeof inner === "string" ? inner : inner?.text || inner?.caption || "").slice(0, 200),
      quotedId: inner?.contextInfo?.stanzaId || null,
    });
    changed = true;
  }
  if (changed) save();
}

/** Which episode a request is about: a reply to one of its videos, or "עונה 6 פרק 4" / "ע6פ4" / "S06E04". */
function requestedEpisode(c, req) {
  if (req.episodeId) return db().episodes.find((e) => e.id === req.episodeId) || null;
  if (req.quotedId) {
    const rec = c.sent.find((r) => r.key.id === req.quotedId);
    if (rec) return db().episodes.find((e) => e.id === rec.episodeId) || null;
  }
  const t = req.text || "";
  const m =
    t.match(/עונה\s*(\d+)\D{0,10}?פרק\s*(\d+)/) ||
    t.match(/ע\s*(\d+)\s*פ\s*(\d+)/) ||
    t.match(/s\s*(\d+)\s*e\s*(\d+)/i) ||
    t.match(/^\s*(\d+)\D+(\d+)\s*$/);
  return m ? findEpisode(Number(m[1]), Number(m[2])) || null : null;
}

async function handleInbox(c, sock) {
  const name = customerName(c);
  for (const req of c.inbox || []) {
    if (req.key) await deleteSent(sock, c.groupJid, req); // keep the group videos-only
    const ep = requestedEpisode(c, req);
    if (!ep) {
      if (req.text) addLog(`  ${name}: הודעה בקבוצה שלא הובנה ("${req.text.slice(0, 40)}"), נמחקה`);
      continue;
    }
    // Resend only the part that was replied to, or the whole episode.
    const quoted = req.quotedId && c.sent.find((r) => r.key.id === req.quotedId);
    const recs = c.sent.filter((r) => r.episodeId === ep.id && (!quoted || r.part === quoted.part));
    addLog(`📥 ${name}: ביקש שוב עונה ${ep.season} פרק ${ep.episode}${quoted && quoted.parts > 1 ? ` חלק ${quoted.part}` : ""}`);
    for (const rec of recs) await deleteSent(sock, c.groupJid, rec);
    c.sent = c.sent.filter((r) => !recs.includes(r));
  }
  c.inbox = [];
  save();
}

/** Manual resend from the admin panel (handled on the next sync). */
export function requestResend(c, episodeId) {
  c.inbox ??= [];
  c.inbox.push({ id: `manual-${Date.now()}`, episodeId });
  save();
}

// -------------------------------------------------------------------- sync
// Same video, title and season/episode (older records lack some fields: treated as equal).
const recordMatches = (rec, ep) =>
  rec.sourceKey === sourceKey(ep.source) &&
  (rec.title === undefined || rec.title === (ep.title || "")) &&
  (rec.se === undefined || rec.se === `${ep.season}x${ep.episode}`);

/** Number of episodes the customer has completely (a split episode counts once). */
export function deliveredCount(c) {
  let count = 0;
  for (const ep of db().episodes) {
    const recs = (c.sent || []).filter((r) => r.episodeId === ep.id && recordMatches(r, ep));
    const parts = recs[0]?.parts || 1;
    if (recs.length && new Set(recs.map((r) => r.part || 1)).size === parts) count++;
  }
  return count;
}

export async function syncCustomer(c) {
  const name = customerName(c);
  if (c.status === "blocked") return addLog(`⏭ ${name}: חסום, מדלג`);
  const s = customerSession(c.id);
  if (!s.isLinked()) return addLog(`⏭ ${name}: וואטסאפ לא מחובר, מדלג`);

  await s.use(async (sock) => {
    if (!c.groupJid) await createEpisodesGroup(c, sock);
    let meta = await groupMeta(sock, c.groupJid);
    if (!meta) {
      addLog(`${name}: הקבוצה לא קיימת יותר – יוצר קבוצה חדשה`);
      await createEpisodesGroup(c, sock);
      meta = await groupMeta(sock, c.groupJid);
      if (!meta) throw new Error("לא הצלחתי ליצור את הקבוצה");
    }

    const reasons = await violations(c, sock, meta);
    if (reasons.length) return block(c, sock, meta, reasons);
    if (meta.ephemeralDuration) await tryDo("ephemeral off", () => sock.groupToggleEphemeral(c.groupJid, 0));
    if (norm(c.groupDesc) !== norm(EPISODES_GROUP_DESC)) {
      // The bot's description text changed in a newer version: update it in the group.
      await tryDo("description", () => sock.groupUpdateDescription(c.groupJid, EPISODES_GROUP_DESC));
      await sleep(1000);
      const m2 = await tryDo("metadata", () => sock.groupMetadata(c.groupJid));
      if (m2) c.groupDesc = m2.desc || "";
      save();
    }

    if (c.welcome && Date.now() - (c.welcome.pinnedAt || 0) > 25 * 86400_000) await pinWelcome(c, sock);

    await s.waitOfflineMessages();
    await handleInbox(c, sock);

    // Messages of deleted/changed episodes, duplicates and leftovers of a different split.
    const episodes = new Map(db().episodes.map((e) => [e.id, e]));
    const seen = new Set();
    const stale = c.sent.filter((r) => {
      const ep = episodes.get(r.episodeId);
      const plan = ep && mediaPlan(ep);
      const id = `${r.episodeId}#${r.part || 1}`;
      const bad = !ep || !recordMatches(r, ep) || (plan && (r.parts || 1) !== plan.parts.length) || seen.has(id);
      seen.add(id);
      return bad;
    });
    if (stale.length) addLog(`${name}: מוחק ${stale.length} הודעות של פרקים שנמחקו או השתנו`);
    for (const rec of stale) await deleteSent(sock, c.groupJid, rec);
    c.sent = c.sent.filter((r) => !stale.includes(r));
    save();

    const onSent = (rec) => {
      c.sent.push(rec);
      save();
    };
    const undo = async (recs) => {
      for (const rec of recs) await deleteSent(sock, c.groupJid, rec);
      c.sent = c.sent.filter((r) => !recs.includes(r));
      save();
    };

    let sentEpisodes = 0;
    for (const ep of sortedEpisodes()) {
      const recs = c.sent.filter((r) => r.episodeId === ep.id);
      const plan = mediaPlan(ep);
      const total = plan ? plan.parts.length : recs[0]?.parts || 1;
      const have = new Set(recs.map((r) => r.part || 1));
      const missing = Array.from({ length: total }, (_, i) => i + 1).filter((p) => !have.has(p));
      if (!missing.length) continue;
      sentEpisodes++;
      if (plan) {
        await sendParts(c, s, sock, ep, missing, onSent);
      } else {
        // Never uploaded with the current video: remove partial leftovers, upload fresh.
        await undo(recs);
        await firstUpload(c, s, sock, ep, onSent, undo);
      }
    }
    c.lastSync = Date.now();
    save();
    const what = !sentEpisodes ? "מעודכן" : sentEpisodes === 1 ? "נשלח פרק אחד" : `נשלחו ${sentEpisodes} פרקים`;
    addLog(`✔ ${name}: ${what}, יש לו ${deliveredCount(c)}/${db().episodes.length} פרקים`);
  });
}

// ------------------------------------------------------------ block/unblock
const selfIds = (sock) => new Set([sock.user?.id, sock.user?.lid].filter(Boolean).map((j) => jidNormalizedUser(j)));

async function block(c, sock, meta, reasons) {
  const name = customerName(c);
  addLog(`⛔ ${name}: הפרת כללים – ${reasons.join(", ")}. חוסם.`);
  const jid = c.groupJid;

  // Delete everything the bot sent, so participants that were added don't keep it.
  const sent = [...(c.sent || [])];
  for (const rec of [...sent].reverse()) await deleteSent(sock, jid, rec);
  if (c.welcome) await deleteSent(sock, jid, c.welcome);

  const me = selfIds(sock);
  const others = meta.participants
    .filter((p) => ![p.id, p.phoneNumber, p.lid].some((x) => x && me.has(jidNormalizedUser(x))))
    .map((p) => p.id);
  if (others.length) await tryDo("remove participants", () => sock.groupParticipantsUpdate(jid, others, "remove"));
  await tryDo("revoke invite", () => sock.groupRevokeInvite(jid));
  const last = sent.at(-1);
  await leaveAndDeleteChat(sock, jid, last?.key, last?.timestamp);

  // A new group with one explanation message, which the customer then leaves: the chat stays
  // on their phone so they can read it, but they can't write in it.
  const blockJid = await createLockedGroup(sock, BLOCKED_GROUP_NAME);
  const msg = await sock.sendMessage(blockJid, { text: BLOCKED_MESSAGE });
  await sleep(1500);
  await tryDo("leave block group", () => sock.groupLeave(blockJid));
  Object.assign(c, {
    status: "blocked",
    blockedReason: reasons.join(", "),
    blockedAt: Date.now(),
    groupJid: null,
    groupDesc: null,
    sent: [],
    welcome: null,
    blockGroupJid: blockJid,
    blockMsg: { key: msg.key, timestamp: Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000) },
  });
  save();
  addLog(`⛔ ${name}: נחסם. הקבוצה נמחקה, ונשארה לו קבוצת "${BLOCKED_GROUP_NAME}" עם ההודעה, לקריאה בלבד`);
}

export async function unblockCustomer(c) {
  const name = customerName(c);
  await customerSession(c.id).use(async (sock) => {
    // Already left when blocked; this deletes the chat (and leaves, for blocks from older versions).
    if (c.blockGroupJid) await leaveAndDeleteChat(sock, c.blockGroupJid, c.blockMsg?.key, c.blockMsg?.timestamp);
    Object.assign(c, { status: "active", blockGroupJid: null, blockMsg: null, blockedReason: null, blockedAt: null });
    await createEpisodesGroup(c, sock);
    addLog(`✔ ${name}: החסימה בוטלה, נוצרה קבוצה חדשה`);
  });
  await syncCustomer(c);
}

/** Deletes the customer's episodes group and creates a new, empty one (filled on the next sync). */
export async function resetGroup(c) {
  const name = customerName(c);
  await customerSession(c.id).use(async (sock) => {
    if (c.groupJid) {
      const last = c.sent?.at(-1) || c.welcome;
      await leaveAndDeleteChat(sock, c.groupJid, last?.key, last?.timestamp);
    }
    await createEpisodesGroup(c, sock);
    addLog(`♻️ ${name}: הקבוצה אופסה. נוצרה קבוצה חדשה וריקה (הפרקים יישלחו בסנכרון)`);
  });
}

// ------------------------------------------------------------------ queue
export function queueSync(c) {
  return enqueue(`sync:${c.id}`, `סנכרון ${customerName(c)}`, () => syncCustomer(c));
}

export function queueSyncAll() {
  forgetRefChecks();
  const list = db().customers.filter((c) => c.status !== "blocked" && customerSession(c.id).isLinked());
  for (const c of list) queueSync(c);
  return list.length;
}

export function queueUnblock(c) {
  return enqueue(`unblock:${c.id}`, `ביטול חסימה ${customerName(c)}`, () => unblockCustomer(c));
}

export function queueReset(c) {
  return enqueue(`reset:${c.id}`, `איפוס הקבוצה של ${customerName(c)}`, () => resetGroup(c));
}

export function queueLogout(c) {
  return enqueue(`logout:${c.id}`, `ניתוק וואטסאפ ${customerName(c)}`, async () => {
    await customerSession(c.id).logout();
    addLog(`✔ ${customerName(c)}: וואטסאפ נותק`);
  });
}
