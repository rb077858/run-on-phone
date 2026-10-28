// All bot state in one JSON file under DATA_DIR, written atomically and debounced.
import fs from "node:fs";
import path from "node:path";

const DEFAULT_SETTINGS = {
  title: "עונג שבת",
  groupJid: null, // null = pick the group whose name contains groupNameMatch
  groupNameMatch: "עונג שבת",
  dayMode: "auto", // "auto" or a fixed "YYYY-MM-DD"
  intervalMin: 5,
  paused: false,
  publicEnabled: true,
  showNames: true,
  notice: "",
};

export function openDb(dataDir) {
  const file = path.join(dataDir, "db.json");
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {}
  data.settings = { ...DEFAULT_SETTINGS, ...data.settings };
  for (const key of ["polls", "people", "lidToPn", "groups", "overrides", "finals", "nicknames"]) data[key] ??= {};
  data.pendingVotes ??= [];

  let timer = null;
  function flush() {
    clearTimeout(timer);
    timer = null;
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  }
  function save() {
    if (!timer) timer = setTimeout(flush, 1500);
  }
  return { data, save, flush };
}

// Keep the file small: forget polls (and their votes) older than ~10 weeks.
export function prune(db) {
  const cutoff = Date.now() / 1000 - 70 * 86400;
  for (const [id, poll] of Object.entries(db.data.polls)) if (poll.ts < cutoff) delete db.data.polls[id];
  db.data.pendingVotes = db.data.pendingVotes.filter((v) => v.ts > cutoff).slice(-1000);
}
