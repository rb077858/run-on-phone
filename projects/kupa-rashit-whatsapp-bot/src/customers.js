// Everything done through a customer's own WhatsApp account: creating the
// "קופה ראשית פרקים" group, syncing episodes into it, and blocking / unblocking.
import { generateMessageIDV2, getContentType, jidNormalizedUser, normalizeMessageContent, proto } from "baileys";
import {
  BLOCKED_GROUP_NAME,
  EPISODES_GROUP_DESC,
  BLOCKED_LOGO,
  EPISODES_GROUP_NAME,
  GROUP_LOGO,
  WELCOME_MESSAGE,
  blockedMessage,
  noticeText,
} from "./config.js";
import { db, findEpisode, getCustomer, normalizePhone, save, settings, sortedEpisodes, sourceKey } from "./db.js";
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
  for (const p of meta.participants) if (!(await isManager(sock, p))) added.push(p);
  if (added.length > 1) reasons.push(`צורפו ${added.length - 1} משתתפים לקבוצה`);
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
  if (!c?.groupJid) return;
  let changed = false;
  for (const m of messages) {
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
  addLog(`⛔ ${name}: ${kind === "violation" ? "הפרת כללים – " : ""}${reasons.join(", ")}. חוסם.`);
  const jid = c.groupJid;
  meta ??= { participants: [] };

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
  const msg = await sock.sendMessage(blockJid, { text: blockedMessage(kind) });
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
    deletedByCustomer: [],
    inviteLink: null,
    inviteCode: null,
    blockGroupJid: blockJid,
    blockMsg: { key: msg.key, timestamp: Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000) },
  });
  save();
  addLog(`⛔ ${name}: נחסם. הקבוצה נמחקה, ונשארה לו קבוצת "${BLOCKED_GROUP_NAME}" עם ההודעה, לקריאה בלבד`);
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

/** Resets the group's invite link by the manager's choice (the new one becomes the allowed one). */
export async function resetGroupLink(c) {
  if (c.status === "blocked") throw new Error("הלקוח חסום");
  if (!c.groupJid) throw new Error("אין לו קבוצה עדיין");
  await customerSession(c.id).use(async (sock) => {
    const code = (await sock.groupRevokeInvite(c.groupJid)) || (await sock.groupInviteCode(c.groupJid));
    c.inviteCode = code;
    c.inviteLink = `https://chat.whatsapp.com/${code}`;
    save();
  });
  addLog(`🔄 ${customerName(c)}: הקישור לקבוצה אופס (הקישור הישן כבר לא עובד)`);
  return c.inviteLink;
}

/** An invite link to the customer's episodes group (opens the group in WhatsApp). */
export async function groupLink(c) {
  if (c.status === "blocked") throw new Error("הלקוח חסום");
  if (!c.groupJid) throw new Error("אין לו קבוצה עדיין");
  await customerSession(c.id).use(async (sock) => {
    const code = await sock.groupInviteCode(c.groupJid);
    if (c.inviteCode && code !== c.inviteCode) throw new Error("קישור ההזמנה אופס בידי הלקוח. הוא ייחסם בסנכרון הבא");
    c.inviteCode ??= code;
    c.inviteLink = `https://chat.whatsapp.com/${code}`;
    save();
  });
  return c.inviteLink;
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
