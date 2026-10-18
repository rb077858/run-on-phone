// Paths, names and all the texts the bot sends to WhatsApp.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PORT = Number(process.env.PORT || 3000);
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(APP_DIR, "data"));
export const SESSIONS_DIR = path.join(DATA_DIR, "sessions");
// Videos downloaded from Drive (can be cleared; re-downloaded when needed).
export const CACHE_DIR = path.join(DATA_DIR, "cache");
// Video files sent directly (WhatsApp / admin upload). Kept until the episode is deleted.
export const MEDIA_DIR = path.join(DATA_DIR, "media");
export const DB_FILE = path.join(DATA_DIR, "db.json");
// The admin panel has no password, so by default it is reachable only from the phone itself.
export const ALLOW_LAN = process.env.ALLOW_LAN === "1";

for (const dir of [DATA_DIR, SESSIONS_DIR, CACHE_DIR, MEDIA_DIR]) fs.mkdirSync(dir, { recursive: true });

export const THUMBNAIL = fs.readFileSync(path.join(APP_DIR, "assets", "thumb.jpg"));

export const MANAGER_GROUP_NAME = "קופה ראשית מנהל";
export const EPISODES_GROUP_NAME = "קופה ראשית פרקים";
export const BLOCKED_GROUP_NAME = "נחסמת על ידי ראם בוטים";

export const EPISODES_GROUP_DESC = [
  "🎬 קופה ראשית – כל הפרקים, לפי הסדר.",
  "נוצר על ידי ראם בוטים 🤖✨",
  "",
  "⛔ חל איסור מוחלט לצרף אנשים לקבוצה.",
  "⛔ חל איסור מוחלט לערוך את פרטי הקבוצה (שם, תיאור, תמונה) – בתכלית האיסור.",
  "הפרה של הכללים תגרום לחסימה אוטומטית ולמחיקת הקבוצה.",
].join("\n");

export const BLOCKED_MESSAGE = [
  "⛔ *נחסמת על ידי ראם בוטים*",
  "",
  `זוהתה הפרה של כללי הקבוצה "${EPISODES_GROUP_NAME}":`,
  "צירוף משתתפים לקבוצה או שינוי של פרטי הקבוצה.",
  "",
  "לכן הקבוצה נמחקה והגישה לפרקים נחסמה.",
  "לביטול החסימה יש לפנות למנהל.",
].join("\n");

export const MANAGER_HELP = [
  "🎬 *קופה ראשית – קבוצת ניהול*",
  "",
  "שלח כאן פרק: קישור לדרייב או את קובץ הסרטון עצמו (כסרטון או כקובץ),",
  "ואני אשאל מה העונה ומה הפרק.",
  "קיצור: אפשר לכתוב בהודעה/בכיתוב \"עונה 5 פרק 3\".",
  "",
  "פקודות:",
  "• *רשימה* – כל הפרקים",
  "• *מחק 5 3* – מחיקת עונה 5 פרק 3",
  "• *סנכרון* – סנכרון כל הלקוחות",
  "• *ביטול* – ביטול הוספה באמצע",
  "• *עזרה* – ההודעה הזאת",
].join("\n");

export const episodeCaption = (ep) => `🎬 קופה ראשית · עונה ${ep.season} · פרק ${ep.episode}${ep.title ? `\n${ep.title}` : ""}`;
