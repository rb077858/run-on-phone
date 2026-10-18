// One Baileys socket per WhatsApp account: "manager" plus one per customer.
// Customer sockets are opened only when needed (connect / sync / unblock) and close
// themselves after a few idle minutes; the manager socket stays up while the bot runs.
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from "baileys";
import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import QRCode from "qrcode";
import { SESSIONS_DIR } from "./config.js";

const logger = pino({ level: "silent" });
const IDLE_CLOSE_MS = 3 * 60_000;

let versionPromise;
function waVersion() {
  versionPromise ??= Promise.race([
    fetchLatestBaileysVersion().then((r) => r.version),
    new Promise((resolve) => setTimeout(() => resolve(undefined), 8000)),
  ]).catch(() => undefined);
  return versionPromise;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class WaSession {
  constructor(id, { keepAlive = false, onOpen, onMessages } = {}) {
    this.id = id;
    this.dir = path.join(SESSIONS_DIR, id);
    this.keepAlive = keepAlive;
    this.onOpen = onOpen;
    this.onMessages = onMessages;
    this.sock = null;
    this.state = "closed"; // closed | connecting | qr | open | loggedOut
    this.qrDataUrl = null;
    this.pairingCode = null;
    this.pairingPhone = null;
    this.me = null;
    this.lastError = null;
    this.busy = 0;
    this.retries = 0;
    this.sentCache = new Map(); // message id → content, for WhatsApp retry requests
    this.waiters = [];
    this.idleTimer = null;
  }

  /** True if this account was linked before (has saved credentials). */
  isLinked() {
    try {
      return !!JSON.parse(fs.readFileSync(path.join(this.dir, "creds.json"), "utf8")).me;
    } catch {
      return false;
    }
  }

  async start() {
    if (this.sock && this.state !== "closed" && this.state !== "loggedOut") return;
    this.stopped = false;
    this.state = "connecting";
    this.qrDataUrl = null;
    this.pairingCode = null;
    this.pairingRequested = false;
    fs.mkdirSync(this.dir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(this.dir);
    const sock = makeWASocket({
      version: await waVersion(),
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      logger,
      browser: Browsers.macOS("Chrome"),
      markOnlineOnConnect: false, // so the customer keeps getting notifications on their phone
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      generateHighQualityLinkPreview: false,
      getMessage: async (key) => this.sentCache.get(key.id),
    });
    this.sock = sock;
    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", (u) => this.#onUpdate(sock, u).catch((e) => console.error(`[${this.id}]`, e)));
    if (this.onMessages) sock.ev.on("messages.upsert", (m) => this.onMessages(this, m));
    this.touch();
  }

  async #onUpdate(sock, { connection, lastDisconnect, qr }) {
    if (sock !== this.sock) return;
    if (qr) {
      this.state = "qr";
      this.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
      if (this.pairingPhone && !this.pairingRequested) this.#requestPairing();
      this.#settle(new Error("החשבון לא מחובר לוואטסאפ"));
    }
    if (connection === "open") {
      this.state = "open";
      this.retries = 0;
      this.qrDataUrl = null;
      this.pairingCode = null;
      this.lastError = null;
      this.me = sock.user;
      console.log(`[${this.id}] connected as +${sock.user?.id?.split(/[:@]/)[0]}`);
      try {
        await this.onOpen?.(this);
      } catch (e) {
        console.error(`[${this.id}] onOpen failed:`, e.message);
        this.lastError = e.message;
        return this.#settle(e);
      }
      this.#settle();
    }
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      this.sock = null;
      if (this.stopped) {
        this.state = "closed";
        return;
      }
      if (code === DisconnectReason.loggedOut) {
        console.log(`[${this.id}] logged out`);
        fs.rmSync(this.dir, { recursive: true, force: true });
        this.state = "loggedOut";
        this.me = null;
        this.#settle(new Error("החשבון התנתק מוואטסאפ"));
        if (this.keepAlive) setTimeout(() => this.start(), 1000);
        return;
      }
      // restartRequired after pairing, network changes, etc.
      this.state = "connecting";
      const delay = code === DisconnectReason.restartRequired ? 200 : Math.min(30_000, 2000 * 2 ** this.retries++);
      console.log(`[${this.id}] connection closed (${code ?? lastDisconnect?.error?.message}), reconnecting in ${delay}ms`);
      setTimeout(() => !this.stopped && this.start().catch((e) => console.error(e)), delay);
    }
  }

  async #requestPairing() {
    this.pairingRequested = true;
    try {
      await sleep(1500);
      const code = await this.sock.requestPairingCode(this.pairingPhone);
      this.pairingCode = code?.match(/.{1,4}/g)?.join("-") ?? code;
    } catch (e) {
      this.lastError = `קוד צימוד נכשל: ${e.message}`;
      this.pairingRequested = false;
    }
  }

  /** Link with an 8-character code instead of a QR. */
  async requestPairingCode(phone) {
    this.pairingPhone = phone;
    this.pairingCode = null;
    if (this.state === "qr") await this.#requestPairing();
    else await this.start();
  }

  #settle(err) {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) err ? w.reject(err) : w.resolve(this.sock);
  }

  /** Resolves with the socket once connected. Rejects if the account needs linking. */
  async ready(timeoutMs = 60_000) {
    this.touch();
    if (this.state === "open" && this.sock) return this.sock;
    if (!this.isLinked()) throw new Error("החשבון לא מחובר לוואטסאפ");
    await this.start();
    if (this.state === "open") return this.sock;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("תם הזמן לחיבור לוואטסאפ")), timeoutMs);
      this.waiters.push({
        resolve: (s) => (clearTimeout(timer), resolve(s)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
    });
  }

  /** Runs fn(sock) while keeping the session from closing as idle. */
  async use(fn) {
    this.busy++;
    try {
      return await fn(await this.ready());
    } finally {
      this.busy--;
      this.touch();
    }
  }

  touch() {
    if (this.keepAlive) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      // Never close in the middle of linking, nor while in use.
      if (this.busy || this.state === "qr") return this.touch();
      this.stop();
    }, IDLE_CLOSE_MS);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.idleTimer);
    try {
      this.sock?.end(undefined);
    } catch {}
    this.sock = null;
    if (this.state !== "loggedOut") this.state = "closed";
    this.qrDataUrl = null;
    this.pairingCode = null;
    this.#settle(new Error("החיבור נסגר"));
  }

  /** Unlinks this bot from the WhatsApp account and deletes the saved session. */
  async logout() {
    try {
      if (this.isLinked()) {
        const sock = await this.ready(30_000);
        this.stopped = true;
        await sock.logout();
      }
    } catch (e) {
      console.error(`[${this.id}] logout:`, e.message);
    }
    this.stop();
    fs.rmSync(this.dir, { recursive: true, force: true });
    this.state = "closed";
    this.me = null;
  }

  status() {
    return {
      state: this.state,
      linked: this.isLinked(),
      qr: this.qrDataUrl,
      pairingCode: this.pairingCode,
      number: this.me?.id ? this.me.id.split(/[:@]/)[0] : null,
      error: this.lastError,
    };
  }
}

const sessions = new Map();

export function session(id, opts) {
  let s = sessions.get(id);
  if (!s) sessions.set(id, (s = new WaSession(id, opts)));
  return s;
}

export function stopAll() {
  for (const s of sessions.values()) s.stop();
}

export const numberOf = (sock) => sock?.user?.id?.split(/[:@]/)[0];
