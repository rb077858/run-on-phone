# פרומפט להדבקה בסשן של פרויקט

העתק את כל מה שמתחת לקו והדבק בסשן Claude Code שבו בנית (או בונה) את הפרויקט.

---

I want this project to run 24/7 on my Android phone using my app **"Run on Phone"**. Please make the project compatible, publish it, and give me its 6-digit code. Talk to me in Hebrew.

## How the phone runs projects

- The phone runs **Node.js 24 (linux/arm64, Android)** — a real `node` binary, one separate process per project, kept alive in the background, auto-restarted 3s→60s after a crash, restarted after phone reboot.
- The code is uploaded to Firebase by a publisher script on this PC. The phone downloads it by a 6-digit code and unpacks it. **`node_modules` is installed on the PC** (`npm ci --omit=dev --ignore-scripts`) and shipped as is. Nothing is installed on the phone.
- stdout/stderr go to the app's "לוגים" screen. Keep logs useful and not too chatty.
- When the user presses Stop, the process gets `SIGTERM` and is killed 5s later. Handle `SIGTERM` gracefully (close sockets, flush data).

### Environment variables the app sets
| Var | Meaning |
|---|---|
| `PORT` | The local HTTP port assigned to this project (e.g. 3101). Any web UI **must** listen on it. |
| `DATA_DIR` | Persistent folder. **All state must live here**: WhatsApp/Baileys auth, databases, uploads, config written at runtime. The app folder is replaced on every update; `DATA_DIR` is kept. |
| `APP_DIR` | Folder with the published code (read-only in spirit). Also the working directory. |
| `RUN_ON_PHONE` | `"1"` when running on the phone. |
| `PROJECT_CODE` | The project's 6-digit code. |
| `TZ` | The phone's time zone. `NODE_ENV=production`. |
Plus anything from `env` in `run-on-phone.json`.

The project must still run on the PC for testing. Use fallbacks such as `process.env.PORT || 3000` and `process.env.DATA_DIR || "./data"`.

### Hard constraints (the phone is not a PC)
1. **No native addons** (`.node` files). They are built for Windows and will not load. Do not use `better-sqlite3`, `sqlite3`, `bcrypt`, `canvas`, `sharp` (as a hard requirement), `node-pty` and so on. Use pure-JS or WASM alternatives:
   - Database: built-in **`node:sqlite`** (`const { DatabaseSync } = require("node:sqlite")`, works on the phone), or JSON files in `DATA_DIR`.
   - Hashing: `bcryptjs` or `node:crypto` (scrypt). Images: avoid, or use `jimp` (pure JS).
   - The publisher prints a warning listing any `.node` files. Fix those before you finish.
2. **No external programs.** There is no `npm`, `npx`, `git`, `python`, `ffmpeg`, `chromium`/puppeteer/playwright, or shell tools beyond basic Android `sh`. Do not `spawn("node", …)`. `worker_threads` is fine.
3. **One process, one port.** If the project has several web pages (admin, sign-up, QR…), serve them all from **one** HTTP server on `PORT` under different paths. Listen on `0.0.0.0`.
4. Memory is limited. Avoid huge in-memory caches. If needed, add `"nodeOptions": ["--max-old-space-size=256"]`.
5. TypeScript or bundling is fine. Build on the PC via the `build` field and point `entry` at the built JS.

### WhatsApp bots (Baileys)
Baileys (`baileys` 7.x / `@whiskeysockets/baileys`) is **tested and works** on the phone, including connecting and getting a QR, without `sharp`. Requirements:
- Store auth with `useMultiFileAuthState(path.join(DATA_DIR, "auth"))`.
- **Pairing UI**: the phone has no terminal, so do not rely on `printQRInTerminal`. Serve a page at **`/qr`** that:
  - shows the current QR as an image (`qrcode` package → `QRCode.toDataURL(qr)`), refreshing every few seconds (QRs rotate);
  - shows the connection status (connected as +972…, or waiting for scan);
  - optionally offers **pairing by phone number** (`sock.requestPairingCode(number)`) with a small form;
  - is RTL / Hebrew and mobile-friendly.
- Add a UI button for it: `{ "label": "חיבור וואטסאפ", "path": "/qr" }`.
- Reconnect on `connection === "close"` unless `DisconnectReason.loggedOut`. On logout, delete the auth folder and restart the socket so a new QR appears.
- Don't crash on transient network errors. The phone may switch Wi-Fi/cellular.

### Admin / sign-up pages
- If the project has an admin interface, sign-up page or similar, expose each as a path on the `PORT` server and list them in `ui` (they become buttons in the app that open the page inside the app).
- These pages are reachable from the phone itself (`127.0.0.1`) and from other devices **on the same Wi-Fi** (`http://<phone-ip>:PORT`). Protect admin pages: allow requests from `127.0.0.1`/`::1` freely, and require a password (HTTP Basic or a login form) for any other address. Store the password in `DATA_DIR`, or generate it on first run and print it once to the log.
- Make the pages mobile-friendly, RTL Hebrew.
- If something must be reachable from the public internet, tell me first. It needs a tunnel and is a separate decision.

### Secrets
Everything published (code, `.env` files in the folder, and `env` in the manifest) is stored in my Firebase project. Anyone holding the Firebase API key plus the 6-digit code can download it. That's acceptable for personal bots, but don't put highly sensitive keys there without telling me. Secrets that the user can enter at runtime are better saved through the admin page into `DATA_DIR`.

## The manifest: `run-on-phone.json` (in the project root)
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
    { "label": "ממשק ניהול", "path": "/admin" },
    { "label": "הרשמה", "path": "/register" }
  ],
  "build": "npm run build",
  "include": [],
  "exclude": ["data", ".phone-data", "auth_info"]
}
```
- Required: `name`, `entry`. `ui` is optional. Add only buttons the project really supports (none at all is fine). `url` may be used instead of `path` for an external page.
- `build`, `include` and `exclude` are used only on the PC and are not sent to the phone. `exclude` takes exact paths relative to the project root (folders or files, no wildcards). `node_modules` and `.git` are always excluded, and dependencies are reinstalled cleanly. If `include` is set, only those paths (plus `package.json`/lock) are packaged.
- **Exclude local state** (auth folders, local DBs, logs) so the PC's WhatsApp session is not uploaded.

## Publish
1. Test locally the way the phone runs it:
   `PORT=3101 DATA_DIR=./.phone-data RUN_ON_PHONE=1 node <entry>` (PowerShell: set `$env:PORT` and so on). Open the UI paths in a browser, and check that the QR page works.
2. Publish:
   ```
   node "C:\Projects\AAA\run-on-phone\publisher\publish.mjs" "<absolute path of this project>"
   ```
   - The first publish creates a 6-digit code and saves it in `.run-on-phone-state.json`. Later publishes keep the same code and bump the version. Don't delete that file, but you may commit it.
   - `--dry-run` packages without uploading. `--info` prints the code.
   - If it says the service account is missing, tell me. Setup is in `C:\Projects\AAA\run-on-phone\SETUP.md`.
3. **Finish by telling me in Hebrew**: the **code** in large text, which buttons will appear in the app, any first-run steps (for example "open חיבור וואטסאפ and scan the QR"), and any limitation you hit.
4. After future changes, publish again. On the phone the new version installs automatically when the project starts (Stop → הרצה), or via ⋮ → "בדוק עדכון".
