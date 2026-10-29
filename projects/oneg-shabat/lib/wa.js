// WhatsApp connection (Baileys): keeps the session alive, records the polls of every group
// and decrypts their votes. Baileys 7 no longer decrypts poll votes itself, so we do it here.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import QRCode from "qrcode";
import pino from "pino";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  decryptPollVote,
  fetchLatestBaileysVersion,
  isJidGroup,
  jidNormalizedUser,
  normalizeMessageContent,
  useMultiFileAuthState,
} from "baileys";

const logger = pino({ level: process.env.WA_LOG_LEVEL || "silent" });
const toNum = (x) => (x && typeof x === "object" && x.toNumber ? x.toNumber() : Number(x || 0));
const b64 = (u8) => (u8 ? Buffer.from(u8).toString("base64") : null);
const unb64 = (s) => (s ? Buffer.from(s, "base64") : null);
const sha256hex = (s) => crypto.createHash("sha256").update(Buffer.from(s || "")).digest("hex");

export function createWhatsApp({ db, dataDir, onChange }) {
  const authDir = path.join(dataDir, "auth");
  const state = { status: "starting", qr: null, qrDataUrl: null, me: null, error: null, pairing: null };
  let sock = null;
  let stopping = false;
  let retry = 0;

  const changed = () => {
    db.save();
    onChange?.();
  };

  // ------------------------------------------------------------ identities
  function learnLid(lid, pn) {
    if (!lid || !pn || !lid.endsWith("@lid")) return;
    lid = jidNormalizedUser(lid);
    pn = jidNormalizedUser(pn);
    if (db.data.lidToPn[lid] === pn) return;
    db.data.lidToPn[lid] = pn;
    // Move what we knew about the LID onto the phone number.
    const p = db.data.people[lid];
    if (p) {
      db.data.people[pn] = { ...p, ...db.data.people[pn] };
      delete db.data.people[lid];
    }
  }

  function learnName(jid, name, strong = false) {
    if (!jid || !name || isJidGroup(jid)) return;
    const key = db.data.lidToPn[jidNormalizedUser(jid)] || jidNormalizedUser(jid);
    const p = (db.data.people[key] ??= {});
    if (strong || !p.name) p.name = name;
  }

  function learnContact(c) {
    if (!c?.id) return;
    if (c.lid && c.phoneNumber) learnLid(c.lid, c.phoneNumber);
    if (c.id.endsWith("@lid") && c.phoneNumber) learnLid(c.id, c.phoneNumber);
    if (c.lid && c.id.endsWith("@s.whatsapp.net")) learnLid(c.lid, c.id);
    if (c.name) learnName(c.id, c.name, true);
    else if (c.notify || c.verifiedName) learnName(c.id, c.notify || c.verifiedName);
  }

  function myIds() {
    const u = sock?.user;
    return [u?.id, u?.lid].filter(Boolean).map(jidNormalizedUser);
  }

  // Every id the author of a message key may have used (LID and phone number forms).
  function authorIds(key) {
    const ids = key.fromMe
      ? myIds()
      : [key.participant, key.participantAlt, key.participant ? null : key.remoteJid]
          .filter(Boolean)
          .map(jidNormalizedUser);
    for (const id of [...ids]) {
      const pn = db.data.lidToPn[id];
      if (pn) ids.push(pn);
      for (const [lid, p] of Object.entries(db.data.lidToPn)) if (p === id) ids.push(lid);
    }
    return [...new Set(ids)];
  }

  // ------------------------------------------------------------------ polls
  function recordPoll(msg) {
    const content = normalizeMessageContent(msg.message);
    if (!content) return false;
    const pollKey = Object.keys(content).find((k) => k.startsWith("pollCreationMessage") && content[k]);
    if (!pollKey) return false;
    const chat = msg.key.remoteJid;
    if (!isJidGroup(chat)) return false;
    const pc = content[pollKey];
    const secret = msg.message?.messageContextInfo?.messageSecret || content.messageContextInfo?.messageSecret;
    const id = msg.key.id;
    const existing = db.data.polls[id];
    db.data.polls[id] = {
      id,
      chat,
      creatorIds: authorIds(msg.key),
      ts: toNum(msg.messageTimestamp) || Math.floor(Date.now() / 1000),
      question: pc.name || "",
      options: (pc.options || []).map((o) => o.optionName || ""),
      selectable: pc.selectableOptionsCount || 0,
      secret: b64(secret) || existing?.secret || null,
      votes: existing?.votes || {},
      config: existing?.config || {},
    };
    if (msg.pushName) learnName(msg.key.participant || msg.key.remoteJid, msg.pushName);
    // History sync delivers polls with their (already decrypted) votes.
    for (const u of msg.pollUpdates || []) {
      const voter = authorIds(u.pollUpdateMessageKey || {})[0];
      if (voter) applyVote(db.data.polls[id], voter, u.vote?.selectedOptions || [], toNum(u.senderTimestampMs));
    }
    retryPending(id);
    console.log(`📊 poll ${existing ? "updated" : "recorded"}: "${pc.name}" (${db.data.polls[id].options.length} options)`);
    return true;
  }

  function applyVote(poll, voter, selectedHashes, tsMs) {
    const byHash = new Map(poll.options.map((o) => [sha256hex(o), o]));
    const opts = selectedHashes.map((h) => byHash.get(Buffer.from(h).toString("hex"))).filter(Boolean);
    const prev = poll.votes[voter];
    const ts = tsMs || Date.now();
    if (prev && prev.ts > ts) return;
    poll.votes[voter] = { opts, ts };
  }

  function tryDecrypt(poll, voteMsg) {
    const { pollUpdateMessage: pu } = voteMsg.content;
    const pollEncKey = unb64(poll.secret);
    if (!pollEncKey) return false;
    const creators = poll.creatorIds;
    const voters = authorIds(voteMsg.key);
    for (const pollCreatorJid of creators) {
      for (const voterJid of voters) {
        try {
          const vote = decryptPollVote(pu.vote, { pollEncKey, pollCreatorJid, pollMsgId: poll.id, voterJid });
          applyVote(poll, voterJid, vote.selectedOptions || [], toNum(pu.senderTimestampMs));
          return true;
        } catch {}
      }
    }
    return false;
  }

  function recordVote(msg) {
    const content = normalizeMessageContent(msg.message);
    const pu = content?.pollUpdateMessage;
    if (!pu?.vote) return false;
    if (msg.pushName && !msg.key.fromMe) learnName(msg.key.participant || msg.key.remoteJid, msg.pushName);
    const pollId = pu.pollCreationMessageKey?.id;
    const poll = db.data.polls[pollId];
    const item = { key: msg.key, content: { pollUpdateMessage: pu } };
    if (poll && tryDecrypt(poll, item)) return true;
    // The poll itself may arrive later (or we lack the voter's other id): keep the vote for a retry.
    db.data.pendingVotes.push({
      pollId,
      ts: toNum(msg.messageTimestamp) || Math.floor(Date.now() / 1000),
      key: { ...msg.key },
      vote: { encPayload: b64(pu.vote.encPayload), encIv: b64(pu.vote.encIv) },
      senderTimestampMs: toNum(pu.senderTimestampMs),
    });
    return true;
  }

  function retryPending(onlyPollId) {
    const left = [];
    let n = 0;
    for (const p of db.data.pendingVotes) {
      const poll = db.data.polls[p.pollId];
      if ((!onlyPollId || p.pollId === onlyPollId) && poll) {
        const item = {
          key: p.key,
          content: {
            pollUpdateMessage: {
              vote: { encPayload: unb64(p.vote.encPayload), encIv: unb64(p.vote.encIv) },
              senderTimestampMs: p.senderTimestampMs,
            },
          },
        };
        if (tryDecrypt(poll, item)) {
          n++;
          continue;
        }
      }
      left.push(p);
    }
    db.data.pendingVotes = left;
    return n;
  }

  // Only admins can write in the group, so its text messages are announcements ("בלוקיישן ב22:00").
  function recordText(msg) {
    const c = normalizeMessageContent(msg.message);
    const text = (c?.conversation || c?.extendedTextMessage?.text || "").trim();
    if (!text) return false;
    const g = (db.data.groups[msg.key.remoteJid] ??= { subject: null, participants: [] });
    g.messages ??= [];
    if (g.messages.some((m) => m.id === msg.key.id)) return false;
    g.messages.push({
      id: msg.key.id,
      ts: toNum(msg.messageTimestamp) || Math.floor(Date.now() / 1000),
      from: authorIds(msg.key)[0] || null,
      text: text.slice(0, 1000),
    });
    g.messages.sort((a, b) => a.ts - b.ts);
    g.messages = g.messages.slice(-40);
    return true;
  }

  function handleMessages(messages) {
    let any = false;
    for (const msg of messages) {
      try {
        if (!msg.message) continue;
        if (msg.key?.participantAlt && msg.key?.participant) learnLid(msg.key.participant, msg.key.participantAlt);
        if (msg.key?.participantAlt && msg.key.participantAlt.endsWith("@lid")) learnLid(msg.key.participantAlt, msg.key.participant);
        if (recordPoll(msg) || recordVote(msg)) any = true;
        else if (isJidGroup(msg.key.remoteJid)) {
          if (msg.pushName && !msg.key.fromMe) learnName(msg.key.participant, msg.pushName);
          if (recordText(msg)) any = true;
        }
      } catch (e) {
        console.error("message handling failed:", e.message);
      }
    }
    if (any) changed();
  }

  // ----------------------------------------------------------------- groups
  function storeGroup(meta) {
    if (!meta?.id) return;
    const participants = [];
    for (const p of meta.participants || []) {
      learnContact(p);
      const id = p.phoneNumber && p.id.endsWith("@lid") ? jidNormalizedUser(p.phoneNumber) : jidNormalizedUser(p.id);
      participants.push(id);
    }
    db.data.groups[meta.id] = {
      ...db.data.groups[meta.id],
      subject: meta.subject,
      participants,
      announce: !!meta.announce,
      updatedAt: Date.now(),
    };
  }

  async function refreshGroups({ all = false } = {}) {
    if (state.status !== "open") return;
    const s = db.data.settings;
    if (all || !s.groupJid) {
      const groups = await sock.groupFetchAllParticipating();
      for (const meta of Object.values(groups)) storeGroup(meta);
    } else {
      storeGroup(await sock.groupMetadata(s.groupJid));
    }
    db.save();
  }

  // ------------------------------------------------------------- connection
  async function start() {
    stopping = false;
    fs.mkdirSync(authDir, { recursive: true });
    const { state: auth, saveCreds } = await useMultiFileAuthState(authDir);
    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch {}
    state.status = "connecting";
    sock = makeWASocket({
      ...(version ? { version } : {}),
      auth,
      logger,
      // Linking with a pairing code works only with a standard browser name (a custom one is rejected).
      browser: Browsers.macOS("Chrome"),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => true,
      getMessage: async (key) => {
        const poll = db.data.polls[key.id];
        if (!poll) return undefined;
        return {
          messageContextInfo: { messageSecret: unb64(poll.secret) },
          pollCreationMessage: { name: poll.question, options: poll.options.map((optionName) => ({ optionName })) },
        };
      },
    });
    const thisSock = sock;

    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", async (u) => {
      if (thisSock !== sock) return;
      if (u.qr) {
        state.status = "qr";
        state.qr = u.qr;
        state.qrDataUrl = await QRCode.toDataURL(u.qr, { margin: 1, width: 320 });
        onChange?.();
      }
      if (u.connection === "open") {
        retry = 0;
        state.status = "open";
        state.qr = state.qrDataUrl = state.error = state.pairing = null;
        state.me = sock.user;
        console.log(`✅ WhatsApp connected as ${sock.user?.id?.split(":")[0]}`);
        learnName(sock.user?.id, sock.user?.name);
        refreshGroups({ all: true }).catch((e) => console.error("group refresh failed:", e.message));
        onChange?.();
      }
      if (u.connection === "close") {
        const code = u.lastDisconnect?.error?.output?.statusCode;
        state.status = "closed";
        state.error = u.lastDisconnect?.error?.message || null;
        onChange?.();
        if (stopping) return;
        if (code === DisconnectReason.loggedOut) {
          console.log("⚠ WhatsApp logged out – deleting the session and showing a new QR");
          fs.rmSync(authDir, { recursive: true, force: true });
          state.me = null;
          reconnect(1000);
          return;
        }
        const delay = Math.min(60_000, 2000 * 2 ** retry++);
        console.log(`WhatsApp disconnected (${code || state.error}); reconnecting in ${delay / 1000}s`);
        reconnect(delay);
      }
    });
    sock.ev.on("messages.upsert", ({ messages }) => handleMessages(messages));
    sock.ev.on("messaging-history.set", ({ messages, contacts, lidPnMappings }) => {
      for (const m of lidPnMappings || []) learnLid(m.lid, m.pn);
      for (const c of contacts || []) learnContact(c);
      handleMessages(messages || []);
      db.save();
    });
    sock.ev.on("lid-mapping.update", (m) => {
      for (const x of Array.isArray(m) ? m : [m]) learnLid(x?.lid, x?.pn);
      db.save();
    });
    sock.ev.on("contacts.upsert", (cs) => (cs.forEach(learnContact), db.save()));
    sock.ev.on("contacts.update", (cs) => (cs.forEach(learnContact), db.save()));
    sock.ev.on("groups.upsert", (gs) => (gs.forEach(storeGroup), db.save()));
    sock.ev.on("groups.update", (gs) => {
      for (const g of gs) if (db.data.groups[g.id] && g.subject) db.data.groups[g.id].subject = g.subject;
      db.save();
    });
  }

  let reconnectTimer = null;
  function reconnect(ms) {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => !stopping && start().catch((e) => console.error("WhatsApp start failed:", e)), ms);
  }

  // Closes the current socket and starts a new one on a clean session.
  async function restartFresh() {
    clearTimeout(reconnectTimer);
    stopping = true;
    sock?.end?.(undefined);
    fs.rmSync(authDir, { recursive: true, force: true });
    state.me = state.pairing = null;
    stopping = false;
    await start();
  }

  async function waitForStatus(status, ms) {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 200)))
      if (state.status === status) return true;
    return false;
  }

  async function requestPairingCode(phone) {
    if (sock?.authState?.creds?.registered && state.status === "open") throw new Error("כבר מחובר");
    const digits = String(phone).replace(/\D/g, "").replace(/^0/, "972");
    if (digits.length < 11 || digits.length > 15) throw new Error("מספר טלפון לא תקין");
    // Every request starts from a clean session, so leftovers of earlier attempts can't interfere.
    await restartFresh();
    if (!(await waitForStatus("qr", 30_000))) throw new Error("החיבור לוואטסאפ לא מוכן, נסו שוב");
    const s = sock;
    // WhatsApp answers the request with an error when it rejects it; Baileys does not wait for that.
    let rejected = null;
    const onError = (node) => (rejected = node?.content?.[0]?.attrs || {});
    s.ws.on("CB:iq,type:error", onError);
    const raw = await s.requestPairingCode(digits);
    await new Promise((r) => setTimeout(r, 3000));
    s.ws.off("CB:iq,type:error", onError);
    if (rejected) {
      console.error("pairing code rejected:", rejected);
      throw new Error(`וואטסאפ דחה את הבקשה (${rejected.code || ""} ${rejected.text || ""}). בדקו שזה המספר של חשבון וואטסאפ פעיל.`);
    }
    const code = raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
    state.pairing = { code, phone: digits, at: Date.now() };
    console.log(`🔑 pairing code requested for +${digits}`);
    return code;
  }

  async function logout() {
    try {
      await sock?.logout();
    } catch {}
    await restartFresh();
  }

  async function sendToSelf(text) {
    const me = sock?.user?.id && jidNormalizedUser(sock.user.id);
    if (!me || state.status !== "open") throw new Error("וואטסאפ לא מחובר");
    await sock.sendMessage(me, { text });
  }

  function stop() {
    stopping = true;
    sock?.end?.(undefined);
  }

  return { state, start, stop, refreshGroups, retryPending, requestPairingCode, logout, sendToSelf, ingest: handleMessages };
}
