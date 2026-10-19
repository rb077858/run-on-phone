// Everything done through a customer's own WhatsApp account: creating the
// "קופה ראשית פרקים" group, syncing episodes into it, and blocking / unblocking.
import { generateMessageIDV2, getBinaryNodeChild, getContentType, jidNormalizedUser, normalizeMessageContent, proto } from "baileys";
import {
  BLOCKED_GROUP_NAME,
  CHAT_GROUP_NAME,
  CHAT_OPENED,
  CONTACT_DISABLED,
  CONTACT_ONLY_FIRST,
  CONTACT_RECEIVED,
  CONTACT_WORD,
  EPISODES_GROUP_DESC,
  MANAGER_ADDED,
  MANAGER_INVITED,
  REQUEST_GROUP_MESSAGE,
  REQUEST_GROUP_NAME,
  contactRejected,
  BLOCKED_LOGO,
  EPISODES_GROUP_NAME,
  GROUP_LOGO,
  WELCOME_MESSAGE,
  blockedMessage,
  noticeText,
} from "./config.js";
import { db, findEpisode, getCustomer, newId, normalizePhone, save, settings, sortedEpisodes, sourceKey } from "./db.js";
import { firstUpload, forgetRefChecks, mediaPlan, sendParts } from "./delivery.js";
import { addLog, enqueue } from "./jobs.js";
import { numberOf, session, sleep } from "./wa.js";

export const customerName = (c) => `${c.firstName} ${c.lastName}`.trim();

export const customerSession = (id) =>
  session(id, { onOpen: onCustomerOpen, onMessages: onCustomerMessages, onDeletes: onCustomerDeletes });

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

// ---------------------------------------------------------------- pictures
// Baileys' updateProfilePicture needs an image library the phone doesn't have; our images
// are already 640×640 JPEG, so they are sent as they are.
async function setGroupPicture(sock, jid, jpeg) {
  await sock.query({
    tag: "iq",
    attrs: { to: "s.whatsapp.net", type: "set", xmlns: "w:profile:picture", target: jid },
    content: [{ tag: "picture", attrs: { type: "image" }, content: jpeg }],
  });
}

/**
 * The id of the group's current picture: { id } (null = no picture), or null when it
 * couldn't be checked (network…) – then nobody is blocked over it.
 */
async function groupPictureId(sock, jid) {
  try {
    const res = await sock.query({
      tag: "iq",
      attrs: { target: jid, to: "s.whatsapp.net", type: "get", xmlns: "w:profile:picture" },
      content: [{ tag: "picture", attrs: { type: "preview", query: "url" } }],
    });
    const pic = res.content?.find?.((n) => n.tag === "picture");
    return { id: pic?.attrs?.id || null };
  } catch (e) {
    const code = Number(e?.output?.statusCode ?? e?.data);
    if (code === 404 || /item-not-found/.test(e.message)) return { id: null };
    return null;
  }
}

/** Puts the logo on the episodes group and remembers its id (to notice if it is changed). */
async function applyGroupLogo(c, sock) {
  try {
    await setGroupPicture(sock, c.groupJid, GROUP_LOGO);
  } catch (e) {
    console.warn(`group picture failed: ${e.message}`);
    return;
  }
  await sleep(1000);
  const pic = await groupPictureId(sock, c.groupJid);
  if (pic?.id) {
    c.pictureId = pic.id;
    save();
  }
}

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
  c.pictureId = null;
  c.deletedByCustomer = [];
  c.inviteLink = null;
  c.inviteCode = null;
  c.manager = null;
  save();
  await applyGroupLogo(c, sock);
  await rememberInviteCode(c, sock);
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

/** Is this group participant the manager (settings.managerPhone)? */
async function isManager(sock, p) {
  const manager = normalizePhone(settings().managerPhone);
  if (!manager) return false;
  const num = (jid) => (jid && jid.endsWith("@s.whatsapp.net") ? jidNormalizedUser(jid).split("@")[0] : null);
  if ([p.id, p.phoneNumber, p.jid].some((j) => num(j) === manager)) return true;
  // A hidden id (@lid) without the number: ask Baileys' LID ↔ number mapping.
  if (p.id?.endsWith("@lid")) {
    const pn = await tryDo("lid → pn", () => sock.signalRepository?.lidMapping?.getPNForLID?.(p.id));
    if (num(pn) === manager) return true;
  }
  return false;
}

// Every group has an invite link from the start; it changes only when someone resets it.
// Reading it doesn't create or change it. The code from when the group was made is kept,
// and a different code later means the customer reset the link (against the rules).
const currentInviteCode = (sock, jid) => tryDo("invite code", () => sock.groupInviteCode(jid));

async function rememberInviteCode(c, sock) {
  const code = await currentInviteCode(sock, c.groupJid);
  if (!code) return;
  c.inviteCode = code;
  c.inviteLink = `https://chat.whatsapp.com/${code}`;
  save();
}

/** Rule violations in the episodes group (empty array = all good). */
async function violations(c, sock, meta) {
  const reasons = [];
  if (meta.subject !== EPISODES_GROUP_NAME) reasons.push(`שם הקבוצה שונה ל-"${meta.subject}"`);
  if (norm(meta.desc) !== norm(c.groupDesc ?? EPISODES_GROUP_DESC)) reasons.push("תיאור הקבוצה שונה");
  // Everyone but the customer, except the manager (who may join a customer's group).
  const added = [];
  let mgr = null;
  for (const p of meta.participants) {
    if (await isManager(sock, p)) mgr = p;
    else added.push(p);
  }
  if (added.length > 1) reasons.push(`צורפו ${added.length - 1} משתתפים לקבוצה`);
  // Once the manager is in (or invited), the system expects them to stay.
  if (mgr) {
    if (c.manager?.state !== "in") {
      c.manager = { ...(c.manager || { via: "joined" }), state: "in", joinedAt: Date.now() };
      addLog(`👑 ${customerName(c)}: המנהל בקבוצה`);
    }
    c.manager.admin = !!mgr.admin;
    c.manager.pid = mgr.id;
    save();
  } else if (c.manager?.state === "in") {
    reasons.push("המנהל הוצא מהקבוצה");
  } else if (c.manager?.canceledByCustomer) {
    reasons.push("ההזמנה של המנהל לקבוצה בוטלה");
  }
  const pic = await groupPictureId(sock, meta.id);
  if (pic) {
    if (c.pictureId && pic.id !== c.pictureId) reasons.push(pic.id ? "תמונת הקבוצה הוחלפה" : "תמונת הקבוצה נמחקה");
    else if (!c.pictureId && pic.id) reasons.push("נוספה תמונה לקבוצה");
  }
  if (c.inviteCode) {
    const code = await currentInviteCode(sock, meta.id);
    if (code && code !== c.inviteCode) reasons.push("קישור ההזמנה לקבוצה אופס");
  } else {
    await rememberInviteCode(c, sock); // groups from before this rule: start watching now
  }
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
// Ids of messages the bot deleted itself – so its own deletes are never taken for the
// customer deleting messages (which is against the rules).
const botDeleted = () => (db().botDeleted ??= []);
function markBotDeleted(id) {
  const list = botDeleted();
  if (!list.includes(id)) list.push(id);
  if (list.length > 3000) list.splice(0, list.length - 3000);
}

async function deleteSent(sock, jid, rec) {
  markBotDeleted(rec.key.id);
  save();
  // Revoke works for everyone but only for ~2 days; delete-for-me always works, and
  // since the group holds only this account, that is what the customer sees.
  await tryDo("revoke", () => sock.sendMessage(jid, { delete: rec.key }));
  await tryDo("delete for me", () =>
    sock.chatModify({ deleteForMe: { key: rec.key, timestamp: rec.timestamp, deleteMedia: true } }, jid),
  );
}

/** Leaves the group and deletes the chat from the customer's WhatsApp. Returns false if the chat stayed. */
async function leaveAndDeleteChat(sock, jid, lastKey, lastTimestamp) {
  await tryDo("leave", () => sock.groupLeave(jid));
  await sleep(1000);
  const lastMessages = lastKey ? [{ key: lastKey, messageTimestamp: lastTimestamp }] : [];
  try {
    await sock.chatModify({ delete: true, lastMessages }, jid);
    return true;
  } catch (e) {
    console.warn(`delete chat failed: ${e.message}`);
    // Fallback: at least empty it and hide it in the archive.
    await tryDo("clear chat", () => sock.chatModify({ clear: true, lastMessages }, jid));
    await tryDo("archive chat", () => sock.chatModify({ archive: true, lastMessages }, jid));
    return false;
  }
}

// ------------------------------------------------------------------ inbox
// Messages the customer writes in the episodes group (the bot only sees them while
// connected, or right after connecting – WhatsApp delivers what arrived meanwhile).
// They are requests to resend a video, and are deleted so the group holds only videos.
const IGNORED_TYPES = new Set([
  "videoMessage",
  "documentMessage",
  "documentWithCaptionMessage",
  "protocolMessage",
  "reactionMessage",
  "senderKeyDistributionMessage",
  "messageContextInfo",
  "pollUpdateMessage",
  "pinInChatMessage",
]);

/** Messages in the group the customer must not delete: the bot's and their own pending ones. */
const knownIds = (c) =>
  new Set([
    ...(c.sent || []).map((r) => r.key.id),
    c.welcome?.key?.id,
    ...(c.noticeIds || []),
    ...(c.inbox || []).map((x) => x.id),
  ]);

function noteCustomerDelete(c, id) {
  if (!id || botDeleted().includes(id) || !knownIds(c).has(id)) return;
  c.deletedByCustomer ??= [];
  if (!c.deletedByCustomer.includes(id)) c.deletedByCustomer.push(id);
  save();
  addLog(`⚠ ${customerName(c)}: מחק הודעה בקבוצה (ייחסם בסנכרון)`);
}

// "Delete for me" done on the customer's phone arrives as an app-state event.
function onCustomerDeletes(s, item) {
  const c = getCustomer(s.id);
  if (!c?.groupJid || !("keys" in item)) return;
  for (const key of item.keys) if (key.remoteJid === c.groupJid) noteCustomerDelete(c, key.id);
}

function onCustomerMessages(s, { messages }) {
  const c = getCustomer(s.id);
  if (!c) return;
  let changed = false;
  for (const m of messages) {
    if (onContactMessage(c, m)) {
      changed = true;
      continue;
    }
    if (!c.groupJid) continue;
    // Only the customer's own messages (their account): the manager may be in the group too.
    if (m.key.remoteJid !== c.groupJid || !m.message || !m.key.fromMe) continue;
    const content = normalizeMessageContent(m.message);
    const type = getContentType(content);
    // "Delete for everyone" arrives as a protocol message pointing at the deleted message.
    if (type === "protocolMessage" && content.protocolMessage?.type === proto.Message.ProtocolMessage.Type.REVOKE) {
      noteCustomerDelete(c, content.protocolMessage.key?.id);
      continue;
    }
    if (!type || IGNORED_TYPES.has(type)) continue;
    c.inbox ??= [];
    if (botTextIds.has(m.key.id) || m.key.id === c.welcome?.key?.id || c.noticeIds?.includes(m.key.id)) continue;
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

/** Handles the customer's messages (requests to send an episode again). */
async function handleInbox(c, sock) {
  const name = customerName(c);
  for (const req of c.inbox || []) {
    if (req.key) await deleteSent(sock, c.groupJid, req); // keep the group videos-only
    if (CONTACT_WORD.test(req.text || "")) {
      if (c.contact) addLog(`  ${name}: כתב "פנייה", אבל כבר יש לו פנייה פתוחה`);
      else await openRequestGroup(c, sock);
      continue;
    }
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
  const s = customerSession(c.id);
  if (c.status === "blocked") {
    // Blocked: only their message to the manager, or the chat with the manager.
    if (!c.contact || !s.isLinked()) return addLog(`⏭ ${name}: חסום, מדלג`);
    return s.use(async (sock) => {
      await s.waitOfflineMessages();
      if (contactOpen(c)) await checkContact(c, sock);
      else await promoteManagerInChat(c, sock);
      c.lastSync = Date.now();
      save();
      addLog(`✔ ${name}: נבדק (חסום)`);
    });
  }
  if (!s.isLinked()) return addLog(`⏭ ${name}: וואטסאפ לא מחובר, מדלג`);

  await s.use(async (sock) => {
    if (c.resetPending) {
      // A fresh group was requested (e.g. "reset all groups"): delete the old one first.
      if (c.groupJid) {
        const last = c.sent?.at(-1) || c.welcome;
        await leaveAndDeleteChat(sock, c.groupJid, last?.key, last?.timestamp);
      }
      c.groupJid = null;
      c.resetPending = false;
      save();
      addLog(`♻️ ${name}: הקבוצה הישנה נמחקה, נוצרת קבוצה חדשה`);
    }
    if (!c.groupJid) await createEpisodesGroup(c, sock);
    if (c.status === "new") c.status = "active";
    let meta = await groupMeta(sock, c.groupJid);
    if (!meta) {
      addLog(`${name}: הקבוצה לא קיימת יותר – יוצר קבוצה חדשה`);
      await createEpisodesGroup(c, sock);
      meta = await groupMeta(sock, c.groupJid);
      if (!meta) throw new Error("לא הצלחתי ליצור את הקבוצה");
    }

    // Messages and deletions that happened while the bot was off arrive first.
    await s.waitOfflineMessages();
    const reasons = await violations(c, sock, meta);
    if (c.deletedByCustomer?.length) reasons.push(`נמחקו ידנית ${c.deletedByCustomer.length} הודעות בקבוצה`);
    if (reasons.length) return block(c, sock, meta, reasons);
    if (c.renewLinkPending) {
      // The manager asked for fresh invite links (old links stop working). Still against the rules for the customer.
      if (await tryDo("renew link", () => renewInviteLink(c, sock))) addLog(`🔄 ${name}: קישור ההזמנה לקבוצה חודש (הישן כבר לא עובד)`);
    }
    if (meta.ephemeralDuration) await tryDo("ephemeral off", () => sock.groupToggleEphemeral(c.groupJid, 0));
    // The logo didn't get set when the group was made: try again.
    if (!c.pictureId) await applyGroupLogo(c, sock);
    if (norm(c.groupDesc) !== norm(EPISODES_GROUP_DESC)) {
      // The bot's description text changed in a newer version: update it in the group.
      await tryDo("description", () => sock.groupUpdateDescription(c.groupJid, EPISODES_GROUP_DESC));
      await sleep(1000);
      const m2 = await tryDo("metadata", () => sock.groupMetadata(c.groupJid));
      if (m2) c.groupDesc = m2.desc || "";
      save();
    }

    if (c.welcome && Date.now() - (c.welcome.pinnedAt || 0) > 25 * 86400_000) await pinWelcome(c, sock);

    if (c.manager?.state === "in" && !c.manager.noticeMsg) {
      c.manager.noticeMsg = await sendGroupText(c, sock, MANAGER_ADDED);
      save();
    }

    await handleInbox(c, sock);
    if (contactOpen(c)) await checkContact(c, sock);
    else if (c.contact?.stage === "chat") await promoteManagerInChat(c, sock);

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
      // Uploaded before, but the other way (parts vs. whole file) and the setting changed.
      const redo = !plan && ep.media?.key === sourceKey(ep.source);
      if (!missing.length && !redo) continue;
      sentEpisodes++;
      if (plan) {
        await sendParts(c, s, sock, ep, missing, onSent);
      } else {
        // Not uploaded this way yet: upload fresh, then remove what was there before (old
        // parts, or leftovers of an interrupted send) – in this order, so nothing is lost if
        // the upload fails.
        try {
          await firstUpload(c, s, sock, ep, onSent, undo);
        } catch (e) {
          // Can't send it the new way (video not on the phone and not on WhatsApp): keep
          // what the customer has, or send the old way if that upload still exists.
          const old = ep.media?.key === sourceKey(ep.source) ? ep.media : null;
          if (!e.noSource || !old) throw e;
          addLog(`  ⚠ ${e.message}`);
          const oldHave = new Set(recs.filter((r) => (r.parts || 1) === old.parts.length).map((r) => r.part || 1));
          const oldMissing = old.parts.map((_, i) => i + 1).filter((p) => !oldHave.has(p));
          if (oldMissing.length) await sendParts(c, s, sock, ep, oldMissing, onSent, old);
          continue;
        }
        await undo(recs);
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

async function block(c, sock, meta, reasons, kind = "violation") {
  const name = customerName(c);
  if (kind !== "final") addLog(`⛔ ${name}: ${kind === "violation" ? "הפרת כללים – " : ""}${reasons.join(", ")}. חוסם.`);
  const jid = c.groupJid;
  meta ??= { participants: [] };
  if (c.contact) await dropContactGroups(c, sock, kind === "final" ? "blocked-after-chat" : "blocked");

  const me = selfIds(sock);
  // Only when someone was added: with one participant, that one is the customer.
  const others =
    meta.participants.length > 1
      ? meta.participants
          .filter((p) => ![p.id, p.phoneNumber, p.lid].some((x) => x && me.has(jidNormalizedUser(x))))
          .map((p) => p.id)
      : [];
  const sent = [...(c.sent || [])];
  if (others.length) {
    // People were added: first delete the videos "for everyone" while they are still in the
    // group (a delete doesn't reach someone who was already removed), then remove them all.
    addLog(`  מוחק ${sent.length} סרטונים ומוציא ${others.length} משתתפים`);
    for (const rec of [...sent].reverse()) await deleteSent(sock, jid, rec);
    if (c.welcome) await deleteSent(sock, jid, c.welcome);
    await tryDo("remove participants", () => sock.groupParticipantsUpdate(jid, others, "remove"));
  }
  if (jid) {
    await tryDo("revoke invite", () => sock.groupRevokeInvite(jid));
    // With everyone out, leaving empties the group; then the chat is deleted from the customer's WhatsApp.
    const last = sent.at(-1) || c.welcome;
    const deleted = await leaveAndDeleteChat(sock, jid, last?.key, last?.timestamp);
    if (!deleted) addLog("  ⚠ וואטסאפ לא אישרה את מחיקת הצ'אט. הקבוצה רוקנה והועברה לארכיון אצל הלקוח");
  }

  // A new group with one explanation message, which the customer then leaves: the chat stays
  // on their phone so they can read it, but they can't write in it.
  const blockJid = await createLockedGroup(sock, BLOCKED_GROUP_NAME);
  await tryDo("blocked picture", () => setGroupPicture(sock, blockJid, BLOCKED_LOGO));
  const msgId = generateMessageIDV2(sock.user?.id);
  botTextIds.add(msgId);
  const msg = await sock.sendMessage(blockJid, { text: blockedMessage(kind) }, { messageId: msgId });
  const blockMsg = { key: msg.key, timestamp: Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000) };
  // The customer may write one message to the manager there. After a chat with the manager
  // the block is final: the bot leaves, so the group is read-only.
  const final = kind === "final";
  if (final) {
    await sleep(1500);
    await tryDo("leave block group", () => sock.groupLeave(blockJid));
  }
  Object.assign(c, {
    status: "blocked",
    blockedReason: reasons.join(", "),
    blockedAt: Date.now(),
    groupJid: null,
    groupDesc: null,
    sent: [],
    welcome: null,
    deletedByCustomer: [],
    inviteLink: null,
    inviteCode: null,
    manager: null,
    blockGroupJid: blockJid,
    blockMsg,
    contact: final
      ? null
      : { stage: "write", origin: "blocked", groupJid: blockJid, createdAt: Date.now(), botIds: [msgId], last: blockMsg },
    contactClosed: final,
  });
  save();
  addLog(
    final
      ? `⛔ ${name}: נחסם סופית. נשארה לו קבוצת "${BLOCKED_GROUP_NAME}" לקריאה בלבד`
      : `⛔ ${name}: נחסם. הקבוצה נמחקה, ונפתחה לו קבוצת "${BLOCKED_GROUP_NAME}" שבה אפשר לכתוב הודעה אחת למנהל`,
  );
}

export async function unblockCustomer(c) {
  const name = customerName(c);
  if (!customerSession(c.id).isLinked()) {
    // Blocked while not connected (only marked): nothing to undo in WhatsApp.
    Object.assign(c, { status: c.groupJid ? "active" : "new", blockedReason: null, blockedAt: null });
    save();
    return addLog(`✔ ${name}: החסימה בוטלה`);
  }
  await customerSession(c.id).use(async (sock) => {
    if (c.contact) await dropContactGroups(c, sock, "unblocked");
    // Leaves the "blocked" group (if still in it) and deletes the chat.
    if (c.blockGroupJid) await leaveAndDeleteChat(sock, c.blockGroupJid, c.blockMsg?.key, c.blockMsg?.timestamp);
    Object.assign(c, {
      status: "active",
      blockGroupJid: null,
      blockMsg: null,
      blockedReason: null,
      blockedAt: null,
      contactClosed: false,
    });
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
  // Blocked customers too, while they may write to the manager or chat with them.
  const list = db().customers.filter((c) => (c.status !== "blocked" || c.contact) && customerSession(c.id).isLinked());
  for (const c of list) queueSync(c);
  return list.length;
}

export function queueUnblock(c) {
  return enqueue(`unblock:${c.id}`, `ביטול חסימה ${customerName(c)}`, () => unblockCustomer(c));
}

// ---------------------------------------------------------------- notices
/** Sends a manager message ("📢 הודעה חדשה מ…") into the customer's episodes group. */
export async function sendNotice(c, text) {
  const name = customerName(c);
  let info = null;
  if (c.status === "blocked") throw new Error("הלקוח חסום");
  if (!c.groupJid) throw new Error("אין לו קבוצה עדיין");
  await customerSession(c.id).use(async (sock) => {
    const messageId = generateMessageIDV2(sock.user?.id);
    botTextIds.add(messageId);
    // Remembered, so the bot never takes it for a customer request (even after a restart).
    c.noticeIds = [...(c.noticeIds || []), messageId].slice(-50);
    save();
    const msg = await sock.sendMessage(c.groupJid, { text: noticeText(text) }, { messageId });
    info = { key: msg.key, timestamp: Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000), groupJid: c.groupJid };
  });
  addLog(`📢 ${name}: ההודעה נשלחה`);
  return info;
}

/** Deletes a manager message from the customer's group (if it is still there). */
export async function deleteNotice(c, rec) {
  if (!rec.key || rec.groupJid !== c.groupJid || c.status === "blocked") return false; // that group is gone
  await customerSession(c.id).use((sock) => deleteSent(sock, c.groupJid, rec));
  addLog(`🗑 ${customerName(c)}: ההודעה נמחקה מהקבוצה`);
  return true;
}

/** New invite link made by the bot itself (the new code becomes the allowed one). */
async function renewInviteLink(c, sock) {
  const code = (await sock.groupRevokeInvite(c.groupJid)) || (await sock.groupInviteCode(c.groupJid));
  c.inviteCode = code;
  c.inviteLink = `https://chat.whatsapp.com/${code}`;
  c.renewLinkPending = false;
  save();
  return true;
}

// ------------------------------------------------- the manager in the episodes group
const managerJidOf = () => {
  const n = normalizePhone(settings().managerPhone);
  return n ? `${n}@s.whatsapp.net` : null;
};

function mustManager(c) {
  const jid = managerJidOf();
  if (!jid) throw new Error("לא הוגדר מספר מנהל (הגדרות ← מספר המנהל)");
  if (jid === `${normalizePhone(c.phone)}@s.whatsapp.net`) throw new Error("המספר של הלקוח הוא מספר המנהל");
  return jid;
}

async function findManagerIn(sock, jid) {
  const meta = await groupMeta(sock, jid);
  if (!meta) return null;
  for (const p of meta.participants) if (await isManager(sock, p)) return p;
  return null;
}

const keyOf = (msg) => (msg ? { key: msg.key, timestamp: Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000) } : null);

/** A bot message in the episodes group that the customer must not delete. */
async function sendGroupText(c, sock, text) {
  const messageId = generateMessageIDV2(sock.user?.id);
  botTextIds.add(messageId);
  c.noticeIds = [...(c.noticeIds || []), messageId].slice(-50);
  save();
  return keyOf(await tryDo("group text", () => sock.sendMessage(c.groupJid, { text }, { messageId })));
}

/**
 * Adds the manager to a group. If WhatsApp doesn't allow it (the manager's privacy
 * settings), sends them an invite in a private chat instead, from the customer's account.
 * Returns { added: true }, or the invite: { kind, code, expiresAt, msg }.
 */
async function addOrInviteManager(sock, jid, subject, text, linkCode) {
  const managerJid = managerJidOf();
  const [res] = await sock.groupParticipantsUpdate(jid, [managerJid], "add");
  if (res?.status === "200" || res?.status === "409") return { added: true };
  // WhatsApp usually returns a one-time invite for exactly this; otherwise use the group link.
  const req = res?.content && getBinaryNodeChild(res.content, "add_request");
  let invite, sent;
  if (req?.attrs?.code) {
    const expiration = Number(req.attrs.expiration) || 0;
    sent = await sock.sendMessage(managerJid, {
      groupInvite: { inviteCode: req.attrs.code, inviteExpiration: expiration, jid, subject, text },
    });
    invite = { kind: "v4", code: req.attrs.code, expiresAt: expiration ? expiration * 1000 : null };
  } else {
    const code = linkCode || (await sock.groupInviteCode(jid));
    sent = await sock.sendMessage(managerJid, { text: `${text}:\nhttps://chat.whatsapp.com/${code}` });
    invite = { kind: "link", code, expiresAt: null };
  }
  addLog(`  אי אפשר לצרף את המנהל ישירות (קוד ${res?.status || "?"}), נשלחה לו הזמנה בצ'אט פרטי`);
  return { ...invite, msg: keyOf(sent) };
}

/** Adds the manager (settings.managerPhone) to the customer's episodes group, or invites them. */
export async function addManager(c) {
  const name = customerName(c);
  if (c.status === "blocked") throw new Error("הלקוח חסום");
  if (!c.groupJid) throw new Error("אין לו קבוצה עדיין. סנכרן קודם");
  mustManager(c);
  if (c.manager) throw new Error(c.manager.state === "in" ? "המנהל כבר בקבוצה" : "כבר נשלחה הזמנה. אפשר לבטל או לשלוח מחדש");
  await customerSession(c.id).use(async (sock) => {
    const meta = await groupMeta(sock, c.groupJid);
    if (!meta) throw new Error("הקבוצה לא קיימת. סנכרן כדי ליצור אותה מחדש");
    let r = null;
    for (const p of meta.participants) if (await isManager(sock, p)) r = { added: true, p };
    r ??= await addOrInviteManager(sock, c.groupJid, meta.subject, `הזמנה לקבוצה "${EPISODES_GROUP_NAME}" של ${name}`, c.inviteCode);
    c.manager = r.added
      ? { state: "in", via: r.p ? "joined" : "added", joinedAt: Date.now(), admin: !!r.p?.admin, pid: r.p?.id }
      : { state: "invited", via: "invite", invitedAt: Date.now(), invite: { kind: r.kind, code: r.code, expiresAt: r.expiresAt }, inviteMsg: r.msg };
    save();
    c.manager.noticeMsg = await sendGroupText(c, sock, r.added ? MANAGER_ADDED : MANAGER_INVITED);
    save();
    addLog(`👑 ${name}: ${r.p ? "המנהל כבר בקבוצה" : r.added ? "המנהל צורף לקבוצה" : "נשלחה למנהל הזמנה לקבוצה"}`);
  });
}

/** Cancels the manager's pending invite (the bot does it, so it isn't the customer's violation). */
async function dropInvite(c, sock) {
  const p = await findManagerIn(sock, c.groupJid);
  if (p) {
    Object.assign(c.manager, { state: "in", joinedAt: Date.now(), admin: !!p.admin, pid: p.id });
    save();
    throw new Error("המנהל כבר הצטרף לקבוצה");
  }
  const m = c.manager;
  c.manager = null;
  save();
  if (m.invite?.kind === "v4") await tryDo("revoke invite", () => sock.groupRevokeInviteV4(c.groupJid, managerJidOf()));
  else if (m.invite?.kind === "link") await tryDo("renew link", () => renewInviteLink(c, sock));
  if (m.inviteMsg) await deleteSent(sock, m.inviteMsg.key.remoteJid, m.inviteMsg);
  if (m.noticeMsg) await deleteSent(sock, c.groupJid, m.noticeMsg);
}

export async function cancelManagerInvite(c) {
  if (c.manager?.state !== "invited") throw new Error("אין הזמנה פתוחה");
  await customerSession(c.id).use((sock) => dropInvite(c, sock));
  addLog(`✖ ${customerName(c)}: ההזמנה של המנהל בוטלה`);
}

export async function resendManagerInvite(c) {
  if (c.manager?.state !== "invited") throw new Error("אין הזמנה פתוחה");
  await customerSession(c.id).use((sock) => dropInvite(c, sock));
  await addManager(c);
}

/** The bot removes the manager from the group (not a violation). */
export async function removeManager(c) {
  if (c.manager?.state !== "in") throw new Error("המנהל לא בקבוצה");
  await customerSession(c.id).use(async (sock) => {
    const p = await findManagerIn(sock, c.groupJid);
    const m = c.manager;
    c.manager = null;
    save();
    if (p) {
      try {
        await sock.groupParticipantsUpdate(c.groupJid, [p.id], "remove");
      } catch (e) {
        c.manager = m;
        save();
        throw e;
      }
    }
    if (m.noticeMsg) await deleteSent(sock, c.groupJid, m.noticeMsg);
    if (m.inviteMsg) await deleteSent(sock, m.inviteMsg.key.remoteJid, m.inviteMsg);
  });
  addLog(`🚪 ${customerName(c)}: המנהל הוצא מהקבוצה על ידי הבוט (לא נחשב הפרה)`);
}

/** Makes the manager an admin of the group (or takes it back). */
export async function setManagerAdmin(c, on) {
  if (c.manager?.state !== "in") throw new Error("המנהל לא בקבוצה");
  await customerSession(c.id).use(async (sock) => {
    const p = await findManagerIn(sock, c.groupJid);
    if (!p) throw new Error("המנהל לא נמצא בקבוצה. סנכרן ונסה שוב");
    await sock.groupParticipantsUpdate(c.groupJid, [p.id], on ? "promote" : "demote");
    c.manager.admin = on;
    save();
  });
  addLog(`⭐ ${customerName(c)}: המנהל ${on ? "הוא עכשיו אדמין בקבוצה" : "כבר לא אדמין בקבוצה"}`);
}

// ------------------------------------------------------ contacting the manager
// A customer writes one message to the manager: in the "blocked" group, or in a "פנייה
// למנהל" group opened after writing "פנייה". The manager reads it in the panel and rejects
// it, or opens a "שיחה עם המנהל" group with the customer.
// c.contact.stage: "write" (may write) → "pending" (message waits for the manager) → "chat".
export const contactOpen = (c) => c.contact?.stage === "write" || c.contact?.stage === "pending";

const SKIP_IN_CONTACT = new Set([
  "protocolMessage",
  "reactionMessage",
  "senderKeyDistributionMessage",
  "messageContextInfo",
  "pollUpdateMessage",
  "pinInChatMessage",
]);

/** Messages of the contact groups, and the customer cancelling the manager's invite. True = handled. */
function onContactMessage(c, m) {
  const content = m.message && normalizeMessageContent(m.message);
  const type = content && getContentType(content);
  if (type === "protocolMessage" && m.key.fromMe && content.protocolMessage?.type === proto.Message.ProtocolMessage.Type.REVOKE) {
    // Deleting the invite sent to the manager cancels it (against the rules).
    const id = content.protocolMessage.key?.id;
    if (id && id === c.manager?.inviteMsg?.key?.id && !botDeleted().includes(id)) {
      c.manager.canceledByCustomer = true;
      addLog(`⚠ ${customerName(c)}: ביטל את ההזמנה של המנהל (ייחסם בסנכרון)`);
      return true;
    }
  }
  const ct = c.contact;
  const jid = m.key.remoteJid;
  if (!ct || (jid !== ct.groupJid && jid !== ct.chatJid)) return false;
  if (!m.message) return true;
  const ts = Number(m.messageTimestamp) || Math.floor(Date.now() / 1000);
  if (!ct.last || ts >= ct.last.timestamp) ct.last = { key: m.key, timestamp: ts }; // to delete the chat later
  if (jid !== ct.groupJid || !m.key.fromMe || !contactOpen(c)) return true;
  if (!type || SKIP_IN_CONTACT.has(type) || botTextIds.has(m.key.id) || ct.botIds?.includes(m.key.id)) return true;
  ct.inbox ??= [];
  if (ct.inbox.some((x) => x.id === m.key.id) || ct.message?.id === m.key.id) return true;
  const inner = content[type];
  const text = typeof inner === "string" ? inner : inner?.text || inner?.caption || "";
  ct.inbox.push({
    id: m.key.id,
    key: m.key,
    timestamp: ts,
    text: text.slice(0, 4000),
    media: typeof inner === "string" || inner?.text ? null : type.replace(/Message$/, ""),
  });
  return true;
}

/** A bot message in a contact group (blocked / request / chat). */
async function sendContactText(c, sock, text, quoted = null, jid = c.contact.groupJid) {
  const ct = c.contact;
  const messageId = generateMessageIDV2(sock.user?.id);
  botTextIds.add(messageId);
  ct.botIds = [...(ct.botIds || []), messageId].slice(-30);
  save();
  const q = quoted?.key ? { quoted: { key: quoted.key, message: { conversation: quoted.text || "" } } } : {};
  const msg = await tryDo("contact text", () => sock.sendMessage(jid, { text }, { messageId, ...q }));
  if (msg) ct.last = keyOf(msg);
  return msg;
}

/** On sync: takes the customer's first message to the manager; deletes any others. */
async function checkContact(c, sock) {
  const ct = c.contact;
  const name = customerName(c);
  const msgs = (ct.inbox || []).sort((a, b) => a.timestamp - b.timestamp);
  ct.inbox = [];
  save();
  if (!msgs.length) return;
  let extra = msgs;
  if (ct.stage === "write") {
    const [first] = msgs;
    extra = msgs.slice(1);
    ct.message = { ...first, at: first.timestamp * 1000 };
    Object.assign(ct, { stage: "pending", receivedAt: Date.now() });
    save();
    addLog(`📩 ${name}: פנייה חדשה למנהל${ct.origin === "blocked" ? " (לקוח חסום)" : ""}`);
    if (!extra.length) await sendContactText(c, sock, CONTACT_RECEIVED, first);
  }
  if (extra.length) {
    for (const m of extra) await deleteSent(sock, ct.groupJid, m);
    if (!ct.extraNoted) await sendContactText(c, sock, CONTACT_ONLY_FIRST, ct.message);
    ct.extraNoted = true;
    addLog(`  ${name}: נמחקו ${extra.length} הודעות נוספות (רק הראשונה נשלחת למנהל)`);
  }
  save();
}

/** The customer wrote "פנייה": a group where they write one message to the manager. */
async function openRequestGroup(c, sock) {
  if (c.oldRequestGroup) {
    // The previous (rejected, read-only) request group.
    await leaveAndDeleteChat(sock, c.oldRequestGroup.jid, c.oldRequestGroup.last?.key, c.oldRequestGroup.last?.timestamp);
    c.oldRequestGroup = null;
  }
  const jid = await createLockedGroup(sock, REQUEST_GROUP_NAME);
  await tryDo("request picture", () => setGroupPicture(sock, jid, GROUP_LOGO));
  c.contact = { stage: "write", origin: "request", groupJid: jid, createdAt: Date.now(), botIds: [] };
  save();
  await sendContactText(c, sock, REQUEST_GROUP_MESSAGE);
  addLog(`✉️ ${customerName(c)}: כתב "פנייה". נפתחה לו קבוצת "${REQUEST_GROUP_NAME}" לכתוב הודעה אחת למנהל`);
}

/** Ends the contact and keeps it in the history (shown in the panel). */
function closeContact(c, outcome) {
  const ct = c.contact;
  if (ct?.message) {
    const rec = {
      id: newId(),
      customerId: c.id,
      name: customerName(c),
      origin: ct.origin,
      text: ct.message.text,
      media: ct.message.media,
      at: ct.message.at,
      chatAt: ct.openedAt || null,
      closedAt: Date.now(),
      outcome,
    };
    db().contactHistory = [...(db().contactHistory || []), rec].slice(-100);
  }
  c.contact = null;
  save();
}

/** Removes the contact groups (request / chat) from the customer's WhatsApp. */
async function dropContactGroups(c, sock, outcome) {
  const ct = c.contact;
  if (!ct) return;
  if (ct.chatJid) {
    const p = await findManagerIn(sock, ct.chatJid);
    if (p) await tryDo("remove manager", () => sock.groupParticipantsUpdate(ct.chatJid, [p.id], "remove"));
    await leaveAndDeleteChat(sock, ct.chatJid, ct.last?.key, ct.last?.timestamp);
  } else if (ct.groupJid && ct.groupJid !== c.blockGroupJid) {
    await leaveAndDeleteChat(sock, ct.groupJid, ct.last?.key, ct.last?.timestamp);
  }
  closeContact(c, outcome);
}

/** The manager rejects the message: a last message in that group, and the bot leaves it (read-only). */
export async function rejectContact(c) {
  if (!contactOpen(c)) throw new Error("אין פנייה פתוחה");
  const ct = c.contact;
  await customerSession(c.id).use(async (sock) => {
    await sendContactText(c, sock, contactRejected(ct.origin));
    await sleep(1500);
    await tryDo("leave", () => sock.groupLeave(ct.groupJid));
    if (ct.origin === "blocked") c.contactClosed = true;
    else c.oldRequestGroup = { jid: ct.groupJid, last: ct.last };
    closeContact(c, "rejected");
  });
  addLog(`✖ ${customerName(c)}: הפנייה נדחתה${ct.origin === "blocked" ? ". הוא לא יוכל לפנות שוב" : ""}`);
}

/** The manager closes a blocked customer's option to write (the "blocked" group becomes read-only). */
export async function disableContact(c) {
  if (c.status !== "blocked" || !contactOpen(c)) throw new Error("אין אפשרות פנייה פתוחה");
  const ct = c.contact;
  const s = customerSession(c.id);
  if (s.isLinked()) {
    await s.use(async (sock) => {
      await sendContactText(c, sock, CONTACT_DISABLED);
      await sleep(1500);
      await tryDo("leave", () => sock.groupLeave(ct.groupJid));
    });
  }
  c.contactClosed = true;
  closeContact(c, "disabled");
  addLog(`🔒 ${customerName(c)}: האפשרות לפנות למנהל נסגרה`);
}

/** The manager accepts: the write group is deleted and a "שיחה עם המנהל" group opens, with the manager as admin. */
export async function openChat(c) {
  const name = customerName(c);
  const ct = c.contact;
  if (ct?.stage !== "pending") throw new Error("אין פנייה שממתינה");
  mustManager(c);
  let r = null;
  await customerSession(c.id).use(async (sock) => {
    const jid = await createLockedGroup(sock, CHAT_GROUP_NAME);
    await tryDo("chat picture", () => setGroupPicture(sock, jid, GROUP_LOGO));
    r = await tryDo("add manager", () => addOrInviteManager(sock, jid, CHAT_GROUP_NAME, `הזמנה ל"${CHAT_GROUP_NAME}" עם ${name}`));
    const admin = !!(r?.added && (await tryDo("promote", () => sock.groupParticipantsUpdate(jid, [managerJidOf()], "promote"))));
    await leaveAndDeleteChat(sock, ct.groupJid, ct.last?.key, ct.last?.timestamp);
    if (ct.origin === "blocked") Object.assign(c, { blockGroupJid: null, blockMsg: null });
    Object.assign(ct, { stage: "chat", chatJid: jid, groupJid: null, openedAt: Date.now(), last: null, managerAdmin: admin });
    ct.managerInvite = r && !r.added ? { kind: r.kind, expiresAt: r.expiresAt } : null;
    save();
    await sendContactText(c, sock, CHAT_OPENED, null, jid);
    // The customer's message, from their own account.
    const m = ct.message;
    await sendContactText(c, sock, m.text || (m.media ? "(ההודעה הייתה קובץ)" : "…"), null, jid);
  });
  addLog(`💬 ${name}: נפתחה "${CHAT_GROUP_NAME}"${r?.added ? "" : r ? ". נשלחה לך הזמנה בצ'אט פרטי" : ". ⚠ לא הצלחתי לצרף אותך"}`);
}

/** The manager joined the chat group through an invite: make them admin. */
async function promoteManagerInChat(c, sock) {
  const ct = c.contact;
  if (ct.managerAdmin) return;
  const p = await findManagerIn(sock, ct.chatJid);
  if (!p) return;
  if (!p.admin) await tryDo("promote", () => sock.groupParticipantsUpdate(ct.chatJid, [p.id], "promote"));
  ct.managerAdmin = true;
  ct.managerInvite = null;
  save();
}

/**
 * The manager ends the chat. Blocked customer: "unblock" or "keep" (blocked for good).
 * Other customer: "close", or "block" (blocked for good).
 */
export async function closeChat(c, outcome) {
  if (c.contact?.stage !== "chat") throw new Error("אין שיחה פתוחה");
  const blocked = c.status === "blocked";
  if (!(blocked ? ["unblock", "keep"] : ["close", "block"]).includes(outcome)) throw new Error("פעולה לא מתאימה");
  if (outcome === "unblock") return unblockCustomer(c);
  const s = customerSession(c.id);
  await s.use(async (sock) => {
    await s.waitOfflineMessages(); // the chat's last message, to delete the chat
    if (outcome === "close") return dropContactGroups(c, sock, "closed");
    const meta = c.groupJid ? await groupMeta(sock, c.groupJid) : null;
    if (!meta) c.groupJid = null;
    const reason = outcome === "keep" ? c.blockedReason || "חסום" : "נחסם על ידי המנהל אחרי שיחה";
    await block(c, sock, meta, [reason], "final");
  });
  if (outcome === "close") addLog(`✔ ${customerName(c)}: השיחה עם המנהל נסגרה`);
}

export const queueContact = (c, what, fn) => enqueue(`contact:${c.id}`, `${what} – ${customerName(c)}`, fn);

/** Every active customer's invite link is renewed by the bot on their next sync. */
export function renewLinksOnNextSync() {
  for (const c of db().customers) if (c.status !== "blocked") c.renewLinkPending = true;
  save();
}

export function queueNotice(c, text, onDone) {
  return enqueue(`notice:${c.id}:${Date.now()}:${Math.random()}`, `הודעה ל${customerName(c)}`, async () => {
    try {
      const info = await sendNotice(c, text);
      onDone?.(true, null, info);
    } catch (e) {
      onDone?.(false, e.message);
      throw e;
    }
  });
}

/** Blocks a customer by the manager's decision (admin panel). */
export async function blockManually(c) {
  const s = customerSession(c.id);
  if (!s.isLinked()) {
    // No WhatsApp access: just stop sending to them.
    Object.assign(c, { status: "blocked", blockedReason: "נחסם ידנית על ידי המנהל", blockedAt: Date.now(), resetPending: false });
    save();
    addLog(`⛔ ${customerName(c)}: נחסם ידנית (הוואטסאפ שלו לא מחובר, אז הקבוצה שלו לא נמחקה)`);
    return;
  }
  await s.use(async (sock) => {
    const meta = c.groupJid ? await groupMeta(sock, c.groupJid) : null;
    if (!meta) c.groupJid = null;
    await block(c, sock, meta, ["נחסם ידנית על ידי המנהל"], "manual");
  });
}

export function queueBlock(c) {
  return enqueue(`block:${c.id}`, `חסימה של ${customerName(c)}`, () => blockManually(c));
}

/** Every active customer gets a new group on their next sync. */
export function resetAllOnNextSync() {
  const list = db().customers.filter((c) => c.status !== "blocked");
  for (const c of list) c.resetPending = true;
  save();
  return list.length;
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
