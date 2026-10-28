// Turns the stored polls and votes of one day into the summary shown on the pages.
const TZ = "Asia/Jerusalem";
const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });

export const dayOf = (unixSeconds) => dayFmt.format(new Date(unixSeconds * 1000));
export const today = () => dayFmt.format(new Date());

// Option texts seen in the group: "אני", "כן", "כעע", "ברור" / "אולי", "אוחי", "לא יודע", "נראה" /
// "לא", "לט", "לאא", "נעע", "אל פהה", "אני לא", "לא פה שבת", "אין לי כח", "אני לא יכול"…
const clean = (s) =>
  (s || "")
    .replace(/[‎‏‪-‮]/g, "")
    .replace(/(\p{L})\1+/gu, "$1") // "לאאא" -> "לא", "כעע" -> "כע"
    .trim();
const MAYBE_RE = /אולי|אוחי|לא\s*(משנה|אכפת)|לא\s*(בטוח|בטוחה|יודע|יודעת|ידוע)|נראה|תלוי|מקוו|יכול להיות|^\?+$|🤷/;
const NO_RE =
  /^(אני\s*)?(לא|לט|לו|נע|אל פה|פחות)(?![\p{L}])|לא קשור|^(❌|✖|👎)|אין לי (כח|כוח)|לא\s*(פה|כאן|בבית|ב?עיר|מגיע|אגיע|נגיע|בא|באה|באים|יכול|יכולה|יכולים|נמצא|נמצאת|אהיה|רלוונטי|משתתף|זורם|הולך|הולכת)/u;
// A poll is about attendance if its question asks who is coming / meeting today.
const ATTENDANCE_Q_RE =
  /מי\s*(בא|באה|באים|הולך|הולכת|יוצא|פה|כאן|זורם|רוצה|יכול|מגיע|נמצא)|באים|מגיע|נפגשים|להיפגש|יוצאים|יוצא|פה\s*ב?(שבת|חג)|זורמים|למי מותר/;
const NOT_ATTENDANCE_Q_RE = /^\s*(איפה|מתי|באיזו?ה?\s*שעה|איזו?ה?\s*שעה|שעה|לאן|מה\s)/;

export function autoKind(option) {
  const t = clean(option);
  if (MAYBE_RE.test(t)) return "maybe";
  if (NO_RE.test(t)) return "no";
  return "yes";
}

export function optionKind(poll, option) {
  return poll.config?.kinds?.[option] || autoKind(option);
}

export function autoRole(poll) {
  const q = clean(poll.question);
  if (NOT_ATTENDANCE_Q_RE.test(q)) return "regular";
  if (ATTENDANCE_Q_RE.test(q)) return "attendance";
  // Unknown question: attendance if it has both a "yes" and a clear "no" answer.
  const kinds = poll.options.map(autoKind);
  return kinds.includes("no") && kinds.includes("yes") && poll.options.length <= 4 ? "attendance" : "regular";
}

export function pollRole(poll) {
  const role = poll.config?.role || "auto";
  return role === "auto" ? autoRole(poll) : role;
}

export function personKey(db, jid) {
  return db.data.lidToPn[jid] || jid;
}

export function personName(db, key) {
  if (db.data.nicknames[key]) return db.data.nicknames[key];
  const p = db.data.people[key];
  if (p?.name) return p.name;
  const user = key.split("@")[0].split(":")[0];
  if (key.endsWith("@s.whatsapp.net")) {
    return user.startsWith("972") ? "0" + user.slice(3, 5) + "-" + user.slice(5) : "+" + user;
  }
  return "משתתף …" + user.slice(-4);
}

export function groupPolls(db, groupJid) {
  return Object.values(db.data.polls)
    .filter((p) => p.chat === groupJid)
    .sort((a, b) => a.ts - b.ts);
}

export function daysWithPolls(db, groupJid) {
  return [...new Set(groupPolls(db, groupJid).map((p) => dayOf(p.ts)))].sort().reverse();
}

export function activeDay(db, groupJid) {
  const { dayMode } = db.data.settings;
  if (dayMode && dayMode !== "auto") return dayMode;
  const days = daysWithPolls(db, groupJid);
  const t = today();
  return days.includes(t) || !days.length ? t : days[0];
}

// The latest vote of every person in a poll (a person may appear under both their LID and phone JID).
function votesByPerson(db, poll) {
  const out = new Map();
  for (const [voter, v] of Object.entries(poll.votes || {})) {
    const key = personKey(db, voter);
    const prev = out.get(key);
    if (!prev || v.ts >= prev.ts) out.set(key, v);
  }
  for (const [k, v] of out) if (!v.opts.length) out.delete(k);
  return out;
}

function dayPolls(db, groupJid, day) {
  return groupPolls(db, groupJid).filter((p) => dayOf(p.ts) === day && !p.config?.hidden);
}

// Attendance of each person on a day: their latest answer in any attendance poll, unless the
// admin set it by hand. Returns Map(personKey -> { status: "coming" | "maybe" | "notComing", manual? }).
export function attendance(db, groupJid, day, polls = dayPolls(db, groupJid, day)) {
  const status = new Map();
  for (const poll of polls) {
    if (pollRole(poll) !== "attendance") continue;
    for (const [key, v] of votesByPerson(db, poll)) {
      const kinds = v.opts.map((o) => optionKind(poll, o));
      const st = kinds.includes("yes") ? "coming" : kinds.includes("maybe") ? "maybe" : "notComing";
      const prev = status.get(key);
      if (!prev || v.ts >= prev.ts) status.set(key, { status: st, ts: v.ts });
    }
  }
  for (const [key, o] of Object.entries(db.data.overrides[day] || {})) status.set(key, { status: o, manual: true });
  return status;
}

export function computeSummary(db, { groupJid, day, now = Date.now() }) {
  const s = db.data.settings;
  const group = db.data.groups[groupJid];
  const polls = dayPolls(db, groupJid, day);
  const name = (k) => personName(db, k);
  const sortNames = (keys) => [...keys].map(name).sort((a, b) => a.localeCompare(b, "he"));

  const status = attendance(db, groupJid, day, polls);
  const keysWith = (st) => [...status].filter(([, x]) => x.status === st).map(([k]) => k);
  const notComing = new Set(keysWith("notComing"));

  const pollSummaries = polls.map((poll) => {
    const role = pollRole(poll);
    const votes = votesByPerson(db, poll);
    const options = poll.options.map((opt) => {
      const voters = [...votes].filter(([, v]) => v.opts.includes(opt)).map(([k]) => k);
      const counted = role === "attendance" ? voters : voters.filter((k) => !notComing.has(k));
      const excluded = role === "attendance" ? [] : voters.filter((k) => notComing.has(k));
      return {
        name: opt,
        count: counted.length,
        voters: sortNames(counted),
        excluded: sortNames(excluded),
        kind: role === "attendance" ? optionKind(poll, opt) : null,
      };
    });
    const max = Math.max(0, ...options.map((o) => o.count));
    const leaders = options.filter((o) => o.count === max);
    for (const o of options) o.top = role !== "attendance" && max > 0 && o.count === max;
    const countedVoters = [...votes.keys()].filter((k) => role === "attendance" || !notComing.has(k));
    return {
      id: poll.id,
      question: poll.question,
      role,
      multi: poll.selectable !== 1,
      createdAt: poll.ts * 1000,
      options,
      leader: role !== "attendance" && max > 0 ? leaders.map((o) => o.name).join(" / ") : null,
      voters: countedVoters.length,
      excludedVoters: votes.size - countedVoters.length,
    };
  });

  const participants = [...new Set((group?.participants || []).map((j) => personKey(db, j)))];
  const noAnswer = participants.filter((k) => !status.has(k));
  const hasAttendance = pollSummaries.some((p) => p.role === "attendance") || status.size > 0;
  const messages = (group?.messages || []).filter((m) => dayOf(m.ts) === day).slice(-5);

  return {
    title: s.title,
    notice: s.notice,
    day,
    groupName: group?.subject || null,
    groupSize: participants.length || null,
    generatedAt: now,
    attendance: hasAttendance
      ? {
          coming: keysWith("coming").length,
          maybe: keysWith("maybe").length,
          notComing: notComing.size,
          noAnswer: participants.length ? noAnswer.length : null,
          comingNames: sortNames(keysWith("coming")),
          maybeNames: sortNames(keysWith("maybe")),
          notComingNames: sortNames(notComing),
          noAnswerNames: sortNames(noAnswer),
        }
      : null,
    leaders: pollSummaries.filter((p) => p.leader).map((p) => ({ question: p.question, leader: p.leader })),
    messages: messages.map((m) => ({ ts: m.ts * 1000, text: m.text, from: name(personKey(db, m.from)) })),
    polls: pollSummaries,
  };
}

// The public copy: without names when the admin turned them off.
export function redact(summary, showNames) {
  if (showNames) return summary;
  const copy = structuredClone(summary);
  if (copy.attendance) for (const k of ["comingNames", "maybeNames", "notComingNames", "noAnswerNames"]) copy.attendance[k] = [];
  for (const p of copy.polls) for (const o of p.options) (o.voters = []), (o.excluded = []);
  copy.namesHidden = true;
  return copy;
}

export function summaryText(summary) {
  const d = summary.day.split("-").reverse().slice(0, 2).join(".");
  const lines = [`*${summary.title} – סיכום ${d}*`];
  const a = summary.attendance;
  if (a) {
    lines.push("", `✅ מגיעים: ${a.coming}`);
    if (a.maybe) lines.push(`🤔 אולי: ${a.maybe}`);
    lines.push(`❌ לא מגיעים: ${a.notComing}`);
    if (a.noAnswer != null) lines.push(`❔ לא ענו: ${a.noAnswer}`);
  }
  for (const p of summary.polls) {
    if (p.role === "attendance") continue;
    lines.push("", `*${p.question}*`);
    for (const o of p.options) lines.push(`${o.top ? "🏆 " : "• "}${o.name}: ${o.count}`);
  }
  if (a) lines.push("", "_לא נספרו בחירות של מי שסימן שלא מגיע_");
  return lines.join("\n");
}
