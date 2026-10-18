// The manager's WhatsApp account and the "קופה ראשית מנהל" group, where the manager
// adds episodes by sending a Drive link or the video itself.
import { normalizeMessageContent } from "baileys";
import { MANAGER_GROUP_NAME, MANAGER_HELP } from "./config.js";
import { db, findEpisode, removeEpisode, save, sortedEpisodes, upsertEpisode } from "./db.js";
import { addLog } from "./jobs.js";
import { deleteSourceFile, ensureDriveFile, formatBytes, parseDriveLink, saveWhatsAppVideo, videoContent } from "./media.js";
import { queueSyncAll } from "./customers.js";
import { session } from "./wa.js";

const botSent = new Set(); // ids of messages the bot itself sent in the manager group
let pending = null; // { source | filePromise, season?, episode? } while asking season/episode
let chain = Promise.resolve(); // handle messages one at a time, in order
const startedAt = Math.floor(Date.now() / 1000);

export const managerSession = () =>
  session("manager", { keepAlive: true, onOpen: ensureManagerGroup, onMessages: onManagerMessages });

export function startManager() {
  const s = managerSession();
  if (s.isLinked()) s.start().catch((e) => console.error("manager start:", e));
}

// ------------------------------------------------------------------- group
async function ensureManagerGroup(s) {
  const sock = s.sock;
  const m = db().manager;
  if (m.groupJid) {
    const meta = await sock.groupMetadata(m.groupJid).catch(() => null);
    if (meta) return;
    m.groupJid = null;
  }
  const groups = await sock.groupFetchAllParticipating();
  const existing = Object.values(groups).find((g) => g.subject === MANAGER_GROUP_NAME);
  if (existing) {
    m.groupJid = existing.id;
    addLog(`✔ נמצאה קבוצת "${MANAGER_GROUP_NAME}" קיימת`);
  } else {
    const meta = await sock.groupCreate(MANAGER_GROUP_NAME, []);
    m.groupJid = meta.id;
    await sock.groupToggleEphemeral(meta.id, 0).catch(() => {});
    addLog(`✔ נוצרה קבוצת "${MANAGER_GROUP_NAME}"`);
    await reply(MANAGER_HELP);
  }
  save();
}

async function reply(text) {
  const s = managerSession();
  const jid = db().manager.groupJid;
  if (!s.sock || !jid) return;
  try {
    const msg = await s.sock.sendMessage(jid, { text });
    botSent.add(msg.key.id);
  } catch (e) {
    console.error("manager reply failed:", e.message);
  }
}

// ---------------------------------------------------------------- messages
function onManagerMessages(_s, { messages }) {
  for (const msg of messages) {
    if (!msg.message || msg.key.remoteJid !== db().manager.groupJid) continue;
    if (botSent.has(msg.key.id)) continue;
    if (Number(msg.messageTimestamp) < startedAt - 30) continue; // old history
    chain = chain.then(() => handle(msg)).catch((e) => {
      console.error(e);
      return reply(`⚠ שגיאה: ${e.message}`);
    });
  }
}

const firstNumber = (text) => {
  const m = String(text).match(/\d+/);
  return m ? Number(m[0]) : null;
};
const parseShortcut = (text) => {
  const m = String(text).match(/עונה\s*(\d+)[^\d]*פרק\s*(\d+)/);
  return m ? { season: Number(m[1]), episode: Number(m[2]) } : null;
};

async function handle(msg) {
  const content = normalizeMessageContent(msg.message);
  const video = videoContent(content);
  const text = (
    content?.conversation ||
    content?.extendedTextMessage?.text ||
    video?.content?.caption ||
    ""
  ).trim();
  const drive = parseDriveLink(text);

  // New episode: a video or a Drive link.
  if (video || drive) {
    if (video) {
      const size = Number(video.content.fileLength) || 0;
      pending = { filePromise: saveWhatsAppVideo(video) };
      pending.filePromise.catch(() => {}); // handled when saving
      await reply(`📥 קיבלתי סרטון${size ? ` (${formatBytes(size)})` : ""}, מוריד אותו לטלפון ברקע.`);
    } else {
      pending = { source: { type: "drive", fileId: drive.fileId, link: drive.link } };
    }
    const shortcut = parseShortcut(text);
    if (shortcut) return finish(shortcut.season, shortcut.episode);
    return reply("📺 מה העונה של הפרק? (מספר)");
  }

  if (pending) {
    if (/^ביטול$/.test(text)) {
      pending.filePromise?.then((file) => deleteSourceFile({ type: "file", file }), () => {});
      pending = null;
      return reply("❌ בוטל.");
    }
    const n = firstNumber(text);
    if (n == null) return reply(pending.season == null ? "שלח מספר עונה (למשל 5), או *ביטול*" : "שלח מספר פרק (למשל 3), או *ביטול*");
    if (pending.season == null) {
      pending.season = n;
      return reply(`עונה ${n}. מה מספר הפרק?`);
    }
    return finish(pending.season, n);
  }

  if (/^(עזרה|help)$/i.test(text)) return reply(MANAGER_HELP);
  if (/^רשימה$/.test(text)) return reply(episodeList());
  if (/^סנכרון$/.test(text)) {
    const n = queueSyncAll();
    return reply(n ? `🔄 התחלתי סנכרון של ${n} לקוחות. ההתקדמות בממשק הניהול.` : "אין לקוחות מחוברים לסנכרון.");
  }
  const del = text.match(/^מחק\s+(\d+)\s+(\d+)$/);
  if (del) {
    const ep = findEpisode(Number(del[1]), Number(del[2]));
    if (!ep) return reply("לא מצאתי פרק כזה.");
    removeEpisode(ep.id);
    deleteSourceFile(ep.source);
    return reply(`🗑 נמחק: עונה ${ep.season} פרק ${ep.episode}. בסנכרון הבא הוא יימחק גם אצל הלקוחות.`);
  }
}

async function finish(season, episode) {
  const p = pending;
  pending = null;
  let source = p.source;
  if (!source) {
    await reply("⏳ מחכה שהסרטון יסיים לרדת…");
    try {
      source = { type: "file", file: await p.filePromise };
    } catch (e) {
      return reply(`⚠ הורדת הסרטון נכשלה: ${e.message}. שלח אותו שוב.`);
    }
  }
  const old = findEpisode(season, episode)?.source;
  const { replaced } = upsertEpisode({ season, episode, source });
  if (old && old.type === "file" && old.file !== source.file) deleteSourceFile(old);
  addLog(`➕ ${replaced ? "עודכן" : "נוסף"} פרק: עונה ${season} פרק ${episode} (מקבוצת המנהל)`);
  await reply(
    `✅ ${replaced ? "עודכן" : "נשמר"}: עונה ${season} פרק ${episode}.\n` +
      `סה״כ ${db().episodes.length} פרקים. לסנכרון ללקוחות: כתוב *סנכרון* או לחץ בממשק הניהול.`,
  );
  if (source.type === "drive") {
    // Download now, so a bad link is reported right away and the sync is faster.
    ensureDriveFile(source.fileId).catch((e) => reply(`⚠ עונה ${season} פרק ${episode}: ${e.message}`));
  }
}

function episodeList() {
  const eps = sortedEpisodes();
  if (!eps.length) return "אין עדיין פרקים.";
  const lines = [];
  let season;
  for (const ep of eps) {
    if (ep.season !== season) {
      season = ep.season;
      lines.push(`\n*עונה ${season}*`);
    }
    lines.push(`• פרק ${ep.episode}${ep.title ? ` – ${ep.title}` : ""} ${ep.source.type === "drive" ? "🔗" : "📁"}`);
  }
  return `🎬 ${eps.length} פרקים:${lines.join("\n")}`;
}
