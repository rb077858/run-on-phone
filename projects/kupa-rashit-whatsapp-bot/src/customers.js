// Everything done through a customer's own WhatsApp account: creating the
// "קופה ראשית פרקים" group, syncing episodes into it, and blocking / unblocking.
import { jidNormalizedUser } from "baileys";
import {
  BLOCKED_GROUP_NAME,
  BLOCKED_MESSAGE,
  EPISODES_GROUP_DESC,
  EPISODES_GROUP_NAME,
  THUMBNAIL,
  episodeCaption,
} from "./config.js";
import { db, getCustomer, normalizePhone, save, sortedEpisodes, sourceKey } from "./db.js";
import { addLog, enqueue } from "./jobs.js";
import { episodeFile, formatBytes } from "./media.js";
import { numberOf, session, sleep } from "./wa.js";

export const customerName = (c) => `${c.firstName} ${c.lastName}`.trim();

export const customerSession = (id) => session(id, { onOpen: onCustomerOpen });

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
  c.groupDesc = meta?.desc ?? EPISODES_GROUP_DESC; // compare with what WhatsApp actually stored
  c.sent = [];
  save();
  return jid;
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

// -------------------------------------------------------------------- sync
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

    // Keep the longest prefix that is already in the right order; delete everything after
    // it and re-send, so the group always shows the episodes in order.
    const desired = sortedEpisodes();
    const sent = c.sent || [];
    let keep = 0;
    while (
      keep < sent.length &&
      keep < desired.length &&
      sent[keep].episodeId === desired[keep].id &&
      sent[keep].sourceKey === sourceKey(desired[keep].source) &&
      sent[keep].caption === episodeCaption(desired[keep])
    ) keep++;

    const toDelete = sent.slice(keep);
    if (toDelete.length) addLog(`${name}: מוחק ${toDelete.length} הודעות כדי לסדר מחדש`);
    for (const rec of toDelete.reverse()) {
      await deleteSent(sock, c.groupJid, rec);
      c.sent.pop();
      save();
    }

    const missing = desired.slice(keep);
    if (!missing.length) addLog(`✔ ${name}: מעודכן (${desired.length} פרקים)`);
    for (const [i, ep] of missing.entries()) {
      const label = `עונה ${ep.season} פרק ${ep.episode}`;
      const file = await episodeFile(ep.source, (done, total) =>
        addLog(`  ⬇ ${label}: ${formatBytes(done)}${total ? ` / ${formatBytes(total)}` : ""}`),
      );
      addLog(`${name}: שולח ${label} (${i + 1}/${missing.length})`);
      s.touch();
      const caption = episodeCaption(ep);
      const msg = await sock.sendMessage(c.groupJid, {
        video: { url: file },
        caption,
        mimetype: "video/mp4",
        jpegThumbnail: THUMBNAIL, // also keeps Baileys from looking for ffmpeg
      });
      s.sentCache.set(msg.key.id, msg.message);
      c.sent.push({
        episodeId: ep.id,
        sourceKey: sourceKey(ep.source),
        caption,
        key: msg.key,
        timestamp: Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000),
      });
      save();
    }
    c.lastSync = Date.now();
    save();
    if (missing.length) addLog(`✔ ${name}: הסתיים, ${desired.length} פרקים בקבוצה`);
  });
}

// ------------------------------------------------------------ block/unblock
const selfIds = (sock) => new Set([sock.user?.id, sock.user?.lid].filter(Boolean).map((j) => jidNormalizedUser(j)));

async function block(c, sock, meta, reasons) {
  const name = customerName(c);
  addLog(`⛔ ${name}: הפרת כללים – ${reasons.join(", ")}. חוסם.`);
  const jid = c.groupJid;

  const sent = [...(c.sent || [])];
  for (const rec of [...sent].reverse()) await deleteSent(sock, jid, rec);

  const me = selfIds(sock);
  const others = meta.participants
    .filter((p) => ![p.id, p.phoneNumber, p.lid].some((x) => x && me.has(jidNormalizedUser(x))))
    .map((p) => p.id);
  if (others.length) await tryDo("remove participants", () => sock.groupParticipantsUpdate(jid, others, "remove"));
  await tryDo("revoke invite", () => sock.groupRevokeInvite(jid));
  const last = sent.at(-1);
  await leaveAndDeleteChat(sock, jid, last?.key, last?.timestamp);

  const blockJid = await createLockedGroup(sock, BLOCKED_GROUP_NAME);
  const msg = await sock.sendMessage(blockJid, { text: BLOCKED_MESSAGE });
  Object.assign(c, {
    status: "blocked",
    blockedReason: reasons.join(", "),
    blockedAt: Date.now(),
    groupJid: null,
    groupDesc: null,
    sent: [],
    blockGroupJid: blockJid,
    blockMsg: { key: msg.key, timestamp: Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000) },
  });
  save();
  addLog(`⛔ ${name}: נחסם. נוצרה קבוצת "${BLOCKED_GROUP_NAME}"`);
}

export async function unblockCustomer(c) {
  const name = customerName(c);
  await customerSession(c.id).use(async (sock) => {
    if (c.blockGroupJid) await leaveAndDeleteChat(sock, c.blockGroupJid, c.blockMsg?.key, c.blockMsg?.timestamp);
    Object.assign(c, { status: "active", blockGroupJid: null, blockMsg: null, blockedReason: null, blockedAt: null });
    await createEpisodesGroup(c, sock);
    addLog(`✔ ${name}: החסימה בוטלה, נוצרה קבוצה חדשה`);
  });
  await syncCustomer(c);
}

// ------------------------------------------------------------------ queue
export function queueSync(c) {
  return enqueue(`sync:${c.id}`, `סנכרון ${customerName(c)}`, () => syncCustomer(c));
}

export function queueSyncAll() {
  const list = db().customers.filter((c) => c.status !== "blocked" && customerSession(c.id).isLinked());
  for (const c of list) queueSync(c);
  return list.length;
}

export function queueUnblock(c) {
  return enqueue(`unblock:${c.id}`, `ביטול חסימה ${customerName(c)}`, () => unblockCustomer(c));
}

export function queueLogout(c) {
  return enqueue(`logout:${c.id}`, `ניתוק וואטסאפ ${customerName(c)}`, async () => {
    await customerSession(c.id).logout();
    addLog(`✔ ${customerName(c)}: וואטסאפ נותק`);
  });
}
