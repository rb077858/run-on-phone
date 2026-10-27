// Akinator for Run on Phone: a styled web game on top of aki-api.
// One HTTP server on PORT serves the page (public/) and a small JSON API that
// keeps one aki-api session per game in memory. Stats are saved in DATA_DIR.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// Load the Akinator class directly: aki-api's index.js reads a CA bundle that only
// exists after an npm install script, and the phone build skips install scripts.
const Aki = process.env.AKI_MOCK === "1" ? require("./mock") : require("aki-api/dist/src/Akinator").default;
const { regions } = require("aki-api/dist/src/constants/Client");

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");
const SESSION_TTL_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20_000;

fs.mkdirSync(DATA_DIR, { recursive: true });
const statsFile = path.join(DATA_DIR, "stats.json");

function readStats() {
  try {
    return { games: 0, akiWins: 0, playerWins: 0, ...JSON.parse(fs.readFileSync(statsFile, "utf8")) };
  } catch {
    return { games: 0, akiWins: 0, playerWins: 0 };
  }
}

function bumpStat(key) {
  const stats = readStats();
  stats[key]++;
  fs.writeFileSync(statsFile, JSON.stringify(stats));
  return stats;
}

// ------------------------------------------------------------------ sessions
const sessions = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.lastUsed > SESSION_TTL_MS) sessions.delete(id);
}, 60_000).unref();

function questionState(s) {
  return {
    id: s.id,
    type: "question",
    question: s.aki.question,
    answers: s.aki.answers,
    progress: Math.round(Number(s.aki.progress) || 0),
    step: s.aki.currentStep,
  };
}

function guessState(s, guess) {
  return {
    id: s.id,
    type: "guess",
    name: guess.name_proposition,
    description: guess.description_proposition || "",
    photo: guess.photo || "",
    step: s.aki.currentStep,
  };
}

// The server answers with a guess, or with a step that has no question once
// Akinator runs out of ideas. Both are turned into a state for the page.
function afterStep(s, result) {
  if (result && result.id_base_proposition) return guessState(s, result);
  if (!result || !result.question) return { id: s.id, type: "giveup" };
  return questionState(s);
}

const actions = {
  async start({ region, childMode }) {
    if (!regions.includes(region)) throw new UserError("שפה לא נתמכת");
    const aki = new Aki({ region, childMode: childMode === true });
    aki.config = { ...aki.config, timeout: REQUEST_TIMEOUT_MS };
    await aki.start();
    const s = { id: crypto.randomUUID(), aki, lastUsed: Date.now() };
    sessions.set(s.id, s);
    bumpStat("games");
    console.log(`new game (${region}${childMode ? ", child mode" : ""})`);
    return questionState(s);
  },
  async answer(s, { answer }) {
    if (![0, 1, 2, 3, 4].includes(answer)) throw new UserError("תשובה לא חוקית");
    return afterStep(s, await s.aki.step(answer));
  },
  async back(s) {
    if (s.aki.currentStep <= 0) return questionState(s);
    await s.aki.back();
    return questionState(s);
  },
  async continue(s) {
    const result = await s.aki.continue();
    return afterStep(s, result);
  },
  async finish(s, { won }) {
    sessions.delete(s.id);
    return { type: "stats", stats: bumpStat(won ? "akiWins" : "playerWins") };
  },
};

class UserError extends Error {}

function friendlyError(err) {
  if (err instanceof UserError) return err.message;
  const status = err.response && err.response.status;
  if (status === 403 || status === 503) return "השרת של אקינטור חסם את הבקשה כרגע. נסו שוב בעוד כמה דקות.";
  if (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT") return "אקינטור לא עונה. בדקו את החיבור לאינטרנט ונסו שוב.";
  if (err.code === "ENOTFOUND" || err.code === "EAI_AGAIN") return "אין חיבור לאינטרנט.";
  if (/TIMEOUT/.test(err.message)) return "המשחק פג תוקף. התחילו משחק חדש.";
  if (/NO QUESTION/.test(err.message)) return "לאקינטור נגמרו השאלות!";
  return "משהו השתבש מול השרת של אקינטור. נסו שוב.";
}

async function handleApi(action, body) {
  if (action === "stats") return { type: "stats", stats: readStats() };
  if (action === "start") return actions.start(body);
  const handler = actions[action];
  if (!handler) throw Object.assign(new UserError("not found"), { status: 404 });
  const s = sessions.get(body.id);
  if (!s) throw Object.assign(new UserError("המשחק פג תוקף. התחילו משחק חדש."), { status: 410 });
  if (s.busy) throw Object.assign(new UserError("רגע, אקינטור עוד חושב…"), { status: 409 });
  s.busy = true;
  s.lastUsed = Date.now();
  try {
    return await handler(s, body);
  } finally {
    s.busy = false;
  }
}

// -------------------------------------------------------------------- server
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function sendJson(res, status, data) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 10_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new UserError("bad json"));
      }
    });
    req.on("error", reject);
  });
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const rel = urlPath === "/" ? "index.html" : urlPath.slice(1);
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 404, { error: "not found" });
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: "not found" });
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const m = req.url.match(/^\/api\/(\w+)$/);
  if (!m) return serveStatic(req, res);
  if (req.method !== "POST") return sendJson(res, 405, { error: "POST only" });
  try {
    sendJson(res, 200, await handleApi(m[1], await readBody(req)));
  } catch (err) {
    if (!(err instanceof UserError)) console.error(`api ${m[1]} failed: ${err.message}`);
    sendJson(res, err.status || (err instanceof UserError ? 400 : 502), { error: friendlyError(err) });
  }
});

server.listen(PORT, "0.0.0.0", () => console.log(`Akinator listening on ${PORT}, data in ${DATA_DIR}`));

process.on("SIGTERM", () => {
  console.log("stopping");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
});
