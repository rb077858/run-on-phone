// Tiny JSON database in DATA_DIR/db.json. Everything lives in memory and is written
// atomically after each change.
import crypto from "node:crypto";
import fs from "node:fs";
import { DB_FILE } from "./config.js";

const empty = () => ({
  settings: {},
  // { id, season, episode, title, source: { type: "file", file } (or "drive" from older versions),
  //   media: { key, limit, parts: [{ size, ref, refAt }] }  ← how it was uploaded to WhatsApp
  //   lastUsed, localFiles, addedAt }
  episodes: [],
  // { id, firstName, lastName, phone, status: "new"|"active"|"blocked", groupJid, groupDesc,
  //   blockGroupJid, connectedAs, lastSync, createdAt,
  //   sent: [{ episodeId, sourceKey, title, part, parts, key, timestamp }],
  //   inbox: [{ id, key, timestamp, text, quotedId } | { manual: true, episodeId }] }
  customers: [],
});

export const DEFAULT_SETTINGS = {
  keepDays: 3, // delete episode videos from the phone this many days after they were last used
  reuseUploads: true, // upload each video to WhatsApp once and reuse it for all customers
  maxVideoBytes: null, // learned: the part size WhatsApp accepted
};

let data = empty();
try {
  data = { ...empty(), ...JSON.parse(fs.readFileSync(DB_FILE, "utf8")) };
} catch {}

delete data.manager; // older versions had a manager WhatsApp account

export const db = () => data;
export const settings = () => Object.assign(data.settings, { ...DEFAULT_SETTINGS, ...data.settings });

export function save() {
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

export const newId = () => crypto.randomBytes(6).toString("hex");

// Israeli numbers: 050-1234567 / +972 50… → 972501234567
export function normalizePhone(raw) {
  let digits = String(raw || "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = "972" + digits.slice(1);
  return digits;
}

// ------------------------------------------------------------------ episodes
export const sourceKey = (src) => (src.type === "drive" ? `drive:${src.fileId}` : `file:${src.file}`);

export function sortedEpisodes() {
  return [...data.episodes].sort((a, b) => a.season - b.season || a.episode - b.episode);
}

export const findEpisode = (season, episode) =>
  data.episodes.find((e) => e.season === season && e.episode === episode);

/** Adds an episode, or replaces the source of an existing season+episode. */
export function upsertEpisode({ season, episode, title = "", source }) {
  const existing = findEpisode(season, episode);
  if (existing) {
    Object.assign(existing, { source, title: title || existing.title, updatedAt: Date.now() });
    save();
    return { episode: existing, replaced: true };
  }
  const ep = { id: newId(), season, episode, title, source, addedAt: Date.now() };
  data.episodes.push(ep);
  save();
  return { episode: ep, replaced: false };
}

export function removeEpisode(id) {
  const before = data.episodes.length;
  data.episodes = data.episodes.filter((e) => e.id !== id);
  save();
  return data.episodes.length !== before;
}

export const getCustomer = (id) => data.customers.find((c) => c.id === id);
