// Minimal Run on Phone example: a web server with an "admin" page and a counter
// stored in DATA_DIR, plus a heartbeat in the logs. No dependencies.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const counterFile = path.join(DATA_DIR, "counter.json");

function readCount() {
  try {
    return JSON.parse(fs.readFileSync(counterFile, "utf8")).count;
  } catch {
    return 0;
  }
}

const server = http.createServer((req, res) => {
  if (req.url === "/admin") {
    const count = readCount() + 1;
    fs.writeFileSync(counterFile, JSON.stringify({ count }));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html dir="rtl"><meta name="viewport" content="width=device-width">
      <body style="font-family:sans-serif;padding:24px">
      <h2>ממשק ניהול לדוגמה</h2>
      <p>Node ${process.version} על ${process.platform}/${process.arch}</p>
      <p>הדף נפתח ${count} פעמים (נשמר ב-DATA_DIR)</p>
      <p>פועל ${Math.round(process.uptime())} שניות</p></body></html>`);
    return;
  }
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end("ok\n");
});

server.listen(PORT, "0.0.0.0", () => console.log(`listening on ${PORT}, data in ${DATA_DIR}`));

setInterval(() => console.log(`heartbeat ${new Date().toISOString()}`), 60_000);

fetch("https://www.google.com", { method: "HEAD" })
  .then((r) => console.log(`internet check: HTTP ${r.status}`))
  .catch((e) => console.error(`internet check failed: ${e.message}`));

process.on("SIGTERM", () => {
  console.log("stopping");
  server.close(() => process.exit(0));
});
