// Paths, names and all the texts the bot sends to WhatsApp.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PORT = Number(process.env.PORT || 3000);
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(APP_DIR, "data"));
export const SESSIONS_DIR = path.join(DATA_DIR, "sessions");
// Split parts (and Drive downloads of older versions). Can be cleared.
export const CACHE_DIR = path.join(DATA_DIR, "cache");
// Video files sent directly (WhatsApp / admin upload). Kept until the episode is deleted.
export const MEDIA_DIR = path.join(DATA_DIR, "media");
export const DB_FILE = path.join(DATA_DIR, "db.json");
// The admin panel has no password, so by default it is reachable only from the phone itself.
export const ALLOW_LAN = process.env.ALLOW_LAN === "1";

for (const dir of [DATA_DIR, SESSIONS_DIR, CACHE_DIR, MEDIA_DIR]) fs.mkdirSync(dir, { recursive: true });

const asset = (name) => fs.readFileSync(path.join(APP_DIR, "assets", name));
export const THUMBNAIL = asset("thumb.jpg");
// Group pictures, already 640×640 JPEG as WhatsApp wants them (no image library on the phone).
export const GROUP_LOGO = asset("group-logo.jpg");
export const BLOCKED_LOGO = asset("blocked-logo.jpg");

export const BRAND = "ראם בוטים ואוטומציות";
export const EPISODES_GROUP_NAME = "קופה ראשית פרקים";
export const BLOCKED_GROUP_NAME = `נחסמת על ידי ${BRAND}`;
export const REQUEST_GROUP_NAME = "פנייה למנהל";
export const CHAT_GROUP_NAME = "שיחה עם המנהל";
// What a customer writes in the episodes group to contact the manager.
export const CONTACT_WORD = /^\s*פני(?:י)?ה\s*[.!]?\s*$/;

export const EPISODES_GROUP_DESC = [
  "🎬 קופה ראשית – כל הפרקים.",
  `נוצר על ידי ${BRAND} 🤖✨`,
  "",
  "🔎 לחיפוש פרק: חפשו בקבוצה למשל ע6פ4 (עונה 6 פרק 4).",
  "📥 פרק לא נפתח? עשו \"השב\" על הקובץ וכתבו משהו, או כתבו \"עונה 6 פרק 4\". הוא יישלח שוב בעדכון הבא.",
  "✉️ רוצים לפנות למנהל? כתבו בקבוצה: פנייה",
  "",
  "⛔ חל איסור מוחלט לצרף אנשים לקבוצה.",
  "⛔ חל איסור מוחלט לערוך את פרטי הקבוצה (שם, תיאור, תמונה) – בתכלית האיסור.",
  "⛔ חל איסור למחוק ידנית הודעות בקבוצה – אף הודעה. רק המערכת מוחקת הודעות, אוטומטית, כשצריך.",
  "⛔ חל איסור מוחלט לאפס את קישור ההזמנה לקבוצה.",
  "⛔ אם המנהל צורף לקבוצה – חל איסור מוחלט להוציא אותו או לבטל את ההזמנה שלו.",
  "הפרה של הכללים תגרום לחסימה אוטומטית ולמחיקת הקבוצה.",
].join("\n");

// First message in every new episodes group (pinned).
export const WELCOME_MESSAGE = [
  `👋 *ברוכים הבאים ל"${EPISODES_GROUP_NAME}"!*`,
  "כאן מופיעים כל הפרקים של קופה ראשית, כקבצי MP4.",
  "לוחצים על הקובץ כדי להוריד אותו ולצפות.",
  "",
  "🔎 *איך מוצאים פרק?*",
  "בחיפוש של הקבוצה כותבים למשל ע6פ4 (עונה 6 פרק 4).",
  "",
  "📥 *פרק לא נפתח או לא הספקת להוריד?*",
  "• עושים \"השב\" על הקובץ וכותבים משהו (למשל \"שוב\"),",
  "• או שולחים הודעה: עונה 6 פרק 4",
  "הפרק יישלח שוב בעדכון הבא, וההודעה שלך תימחק אוטומטית.",
  "",
  "✉️ *רוצים לפנות למנהל?*",
  "כותבים כאן: פנייה",
  "בעדכון הבא תיפתח לכם קבוצה \"פנייה למנהל\", ושם כותבים לו הודעה אחת.",
  "",
  "⛔ אסור לצרף אנשים לקבוצה, לשנות את פרטי הקבוצה, למחוק הודעות, לאפס את קישור ההזמנה או להוציא את המנהל. זה גורם לחסימה.",
  "",
  `נוצר על ידי ${BRAND} 🤖✨`,
].join("\n");

/** The message in the "blocked" group. kind: "violation" | "manual" | "final" (after a chat with the manager). */
export function blockedMessage(kind) {
  if (kind === "final") {
    return [
      `⛔ *נחסמת על ידי ${BRAND}*`,
      "",
      "המנהל סגר את השיחה איתך, והחסימה נשארת.",
      "אי אפשר לפנות שוב.",
      "",
      "(הודעה אוטומטית. אי אפשר להשיב בקבוצה הזאת.)",
    ].join("\n");
  }
  const why = {
    violation: [
      `זוהתה הפרה של כללי הקבוצה "${EPISODES_GROUP_NAME}":`,
      "צירוף משתתפים, שינוי פרטי הקבוצה, מחיקת הודעות, איפוס קישור ההזמנה או הוצאת המנהל.",
    ],
    manual: ["הגישה שלך לפרקים נחסמה על ידי המנהל."],
  }[kind];
  return [
    `⛔ *נחסמת על ידי ${BRAND}*`,
    "",
    ...why,
    "",
    "הקבוצה נמחקה והגישה לפרקים נחסמה.",
    "",
    "✍️ *אפשר לכתוב כאן הודעה אחת בלבד*, והמנהל יקרא אותה.",
    "רק ההודעה הראשונה נשלחת למנהל.",
  ].join("\n");
}

// ------------------------------------------------------- contacting the manager
export const REQUEST_GROUP_MESSAGE = [
  `✉️ *פנייה ל${BRAND}*`,
  "",
  "✍️ כתבו כאן *הודעה אחת בלבד*, והמנהל יקרא אותה.",
  "רק ההודעה הראשונה נשלחת למנהל.",
  "",
  "אם המנהל יאשר, תיפתח לכם קבוצה לשיחה איתו.",
].join("\n");
export const CONTACT_RECEIVED = "✅ ההודעה שלך נשלחה למנהל. התשובה תגיע כאן.";
export const CONTACT_ONLY_FIRST = "✅ רק ההודעה הזאת נשלחה למנהל. שאר ההודעות נמחקו.";
export const contactRejected = (origin) =>
  [
    "✖ *המנהל דחה את הפנייה שלך.*",
    origin === "blocked" ? "החסימה נשארת, ואי אפשר לפנות שוב." : `אפשר לפנות שוב בעתיד: כותבים פנייה בקבוצה "${EPISODES_GROUP_NAME}".`,
    "",
    "(אי אפשר להשיב בקבוצה הזאת.)",
  ].join("\n");
export const CONTACT_DISABLED = [
  "🔒 *המנהל סגר את האפשרות לפנות.*",
  "החסימה נשארת, ואי אפשר לכתוב יותר בקבוצה הזאת.",
].join("\n");
export const CHAT_OPENED = [
  `💬 *${CHAT_GROUP_NAME}*`,
  "",
  "המנהל אישר את הפנייה שלך ויענה לך כאן.",
  "זו ההודעה ששלחת:",
].join("\n");

// ------------------------------------------------- the manager in the episodes group
export const MANAGER_ADDED = [
  "👑 *המנהל צורף לקבוצה.*",
  "חל איסור מוחלט להוציא אותו מהקבוצה. הוצאת המנהל גורמת לחסימה.",
].join("\n");
export const MANAGER_INVITED = [
  "👑 *נשלחה למנהל הזמנה לקבוצה.*",
  "אין לבטל את ההזמנה. כשהמנהל יצטרף, חל איסור מוחלט להוציא אותו.",
  "ביטול ההזמנה או הוצאת המנהל גורמים לחסימה.",
].join("\n");

/** A message from the manager, sent to customers' groups from the admin panel. */
export const noticeText = (text) => `📢 *הודעה חדשה מ${BRAND}:*\n\n${text.trim()}`;

const pad = (n) => String(n).padStart(2, "0");

/**
 * Video caption. Includes short search tokens (ע6פ4, S06E04) so customers can find an
 * episode with WhatsApp's search.
 */
export function episodeCaption(ep, part = 1, parts = 1) {
  return [
    `🎬 קופה ראשית – עונה ${ep.season} פרק ${ep.episode}`,
    ep.title || null,
    parts > 1 ? `🧩 חלק ${part} מתוך ${parts}` : null,
    `🔎 ע${ep.season}פ${ep.episode} · S${pad(ep.season)}E${pad(ep.episode)}`,
  ]
    .filter(Boolean)
    .join("\n");
}
