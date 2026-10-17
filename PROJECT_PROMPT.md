# פרומפט להדבקה בסשן של פרויקט

מדביקים את כל מה שמתחת לקו בכל סשן Claude Code שבו כבר יש פרויקט (חדש או קיים). Claude יתאים את הפרויקט, יפרסם אותו, ויחזיר קוד בן 6 ספרות להזנה באפליקציה. אם הפרויקט כבר פורסם בעבר, הקוד יישאר אותו קוד והגרסה תתעדכן.

---

# Run this project on my phone: give me a 6-digit code

I have an Android app called **"Run on Phone"** that runs Node.js projects 24/7 in the background. You add a project to it with a 6-digit code. **Your job: take the project in this session and get it running on the phone, all the way to a code.** Work on your own. Ask me only if you are truly blocked (for example a missing secret that only I have). Make the minimum changes needed, and keep the project working on the PC too. Talk to me in Hebrew.

## Workflow

**0. Already published?** If the project root has `.run-on-phone-state.json`, it was published before. Check whether anything needs fixing (steps 1–4), then publish again (step 5). The code stays the same and the version goes up.

**1. Understand the project.** Language, how it starts (`package.json` scripts / main file), whether it has a web server and on which port, where it writes state (sessions, DB, files), whether it prints a QR code to the terminal, and which dependencies are native addons.
- **Not Node.js** (Python and so on)? Stop. Tell me in Hebrew that the phone app runs only Node.js and ask whether to port it. Don't publish.
- TypeScript is fine: build it on the PC (see `build` below).

**2. Make it phone-compatible**, following the "Phone environment" rules below:
- `PORT` / `DATA_DIR` with PC fallbacks;
- all state under `DATA_DIR`;
- one HTTP server on `0.0.0.0:PORT` for any UI;
- a `/qr` page for WhatsApp bots;
- password protection for admin pages when accessed from outside the phone;
- graceful `SIGTERM`;
- replace native addons with pure-JS alternatives.

**3. Create `run-on-phone.json`** in the project root (format below). Add `ui` buttons only for pages that really exist. Exclude local state folders.

**4. Smoke test like the phone does.** Start it with `PORT=3101 DATA_DIR=<temp dir> RUN_ON_PHONE=1 node <entry>` (PowerShell: `$env:PORT=3101; $env:DATA_DIR=...; $env:RUN_ON_PHONE=1; node <entry>`). Check that it stays up for ~15 seconds without crashing, request each `ui` path and expect HTTP 200 (or a login prompt), then stop it. For a WhatsApp bot, confirm that `/qr` shows a QR. Don't scan it, and don't keep a PC session.

**5. Publish:**
```
node "C:\Projects\AAA\run-on-phone\publisher\publish.mjs" "<absolute path of the project root>"
```
- If `C:\Projects\AAA\run-on-phone\publisher\node_modules` is missing, run `npm install` in that folder first.
- If the publisher folder doesn't exist on this machine: `git clone https://github.com/rb077858/run-on-phone C:\Projects\AAA\run-on-phone`, then run `npm install` in `publisher`.
- If it reports that `service-account.json` is missing, stop. Tell me it's a one-time setup: download the Firebase service account key for project `run-on-phone` and save it as `C:\Projects\AAA\run-on-phone\publisher\service-account.json` (instructions in that repo's SETUP.md).
- If it warns about native addons (`.node` files), fix them and publish again.
- Use `--dry-run` to package without uploading.

**6. Final answer, in Hebrew, short:**
```
✅ הקוד שלך: 123456
באפליקציה: הוסף פרויקט ← 123456 ← הרצה
כפתורים שיופיעו: …
בהפעלה הראשונה: …   (e.g. "open חיבור וואטסאפ and scan the QR from WhatsApp → Linked devices")
מה שיניתי בפרויקט: … (one or two lines)
```
If it was a re-publish: "הקוד נשאר <code>. בטלפון: עצור ← הרצה (העדכון יורד אוטומטית)".

---

## Phone environment (reference)

- Runs **Node.js 24, linux/arm64 on Android**: a real `node` binary, one process per project, kept alive in the background, auto-restarted after crashes (3s→60s backoff) and after the phone reboots.
- The publisher installs **production `node_modules` on the PC** (`npm ci --omit=dev --ignore-scripts`) and ships them. Nothing gets installed on the phone.
- stdout/stderr appear in the app's "לוגים" screen. On Stop the process gets `SIGTERM`, then a kill after 5s.

### Environment variables
| Var | Meaning |
|---|---|
| `PORT` | Local HTTP port assigned to this project (e.g. 3101). Any web UI must listen on it. |
| `DATA_DIR` | Persistent folder. **All state goes here**: Baileys auth, DBs, uploads, runtime config. The app folder is replaced on every update. |
| `APP_DIR` | Published code folder; also the working directory. |
| `RUN_ON_PHONE` | `"1"` on the phone. |
| `PROJECT_CODE` | The 6-digit code. |
| `TZ`, `NODE_ENV=production` | Set by the app. |
Plus `env` from `run-on-phone.json`. On the PC, fall back to `process.env.PORT || 3000` and `process.env.DATA_DIR || "./data"`.

### Hard constraints
1. **No native addons** (`.node` files): no `better-sqlite3`, `sqlite3`, `bcrypt`, `canvas`, `node-pty`, and `sharp` only as optional. Instead:
   - Database: built-in `node:sqlite` (`const { DatabaseSync } = require("node:sqlite")`, verified on the phone) or JSON files in `DATA_DIR`.
   - Hashing: `bcryptjs` / `node:crypto` scrypt. Images: `jimp` or none.
2. **No external programs**: no npm/npx/git/python/ffmpeg/chromium/puppeteer/playwright. Never `spawn("node", …)`. `worker_threads` is OK.
3. **One process, one port**: serve every page (admin, sign-up, QR…) from one HTTP server on `PORT`, bound to `0.0.0.0`.
4. Limited memory: avoid huge caches. If needed, use `"nodeOptions": ["--max-old-space-size=256"]`.

### WhatsApp bots (Baileys)
Baileys 7.x (`baileys` / `@whiskeysockets/baileys`) is **verified on the phone**, connecting and producing a QR without `sharp`. Requirements:
- Auth: `useMultiFileAuthState(path.join(DATA_DIR, "auth"))`.
- The phone has no terminal, so `printQRInTerminal` is useless. Serve **`/qr`**: the current QR as an image (`qrcode` → `QRCode.toDataURL(qr)`) auto-refreshing every few seconds, the connection status (connected as +972… / waiting), optionally pairing by phone number (`sock.requestPairingCode(number)`), RTL Hebrew and mobile-friendly. Add the button `{ "label": "חיבור וואטסאפ", "path": "/qr" }`.
- Reconnect on `connection === "close"` unless `DisconnectReason.loggedOut`. On logout, delete the auth folder and restart the socket so a new QR appears.
- Survive transient network errors (Wi-Fi/cellular switches).

### Admin / sign-up pages
- Each page is a path on the `PORT` server and listed in `ui`. They become buttons that open inside the app.
- Reachable from the phone (`127.0.0.1`) and from the same Wi-Fi (`http://<phone-ip>:PORT`). Allow `127.0.0.1`/`::1` freely; require a password from any other address. Keep the password in `DATA_DIR`, or generate it on first run and print it once to the log.
- Mobile-friendly, RTL Hebrew. If something must be public on the internet, ask me first (it needs a tunnel).

### Secrets
The published package (including `.env` files and manifest `env`) is stored in Firebase. Anyone with the Firebase API key plus the code can download it. That's fine for personal bots, but warn me before publishing highly sensitive keys. Prefer having secrets entered at runtime through the admin page and saved in `DATA_DIR`.

## `run-on-phone.json` format
```json
{
  "name": "בוט וואטסאפ לדוגמה",
  "description": "שורה קצרה שתוצג באפליקציה",
  "entry": "index.js",
  "args": [],
  "nodeOptions": [],
  "env": { "SOME_SETTING": "value" },
  "ui": [
    { "label": "חיבור וואטסאפ", "path": "/qr" },
    { "label": "ממשק ניהול", "path": "/admin" }
  ],
  "build": "npm run build",
  "include": [],
  "exclude": ["data", "auth_info"]
}
```
- Required: `name`, `entry` (path relative to the root, after `build`). `ui` is optional; use `url` instead of `path` for an external page.
- `build`, `include` and `exclude` are used only on the PC. `exclude` takes exact root-relative paths (no wildcards). `node_modules`, `.git` and `.run-on-phone-state.json` are always excluded. If `include` is set, only those paths (plus `package.json`/lock) are packaged.
- Always exclude local state (WhatsApp auth folders, local DBs, logs) so the PC's session isn't uploaded.
- `.run-on-phone-state.json` holds the code. Keep it (it's fine to commit), so later publishes reuse the same code.
