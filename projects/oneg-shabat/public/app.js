// Public summary page. Data comes from the bot itself (/api/summary) when served by the bot,
// or from Firestore when served from Firebase Hosting (see config.js).
(function () {
  const cfg = window.ONEG_CONFIG || { source: "local" };
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const DAYS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
  const open = new Set(); // which name lists are expanded (kept across refreshes)

  function dayLabel(day) {
    const [y, m, d] = day.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return `יום ${DAYS[dt.getUTCDay()]} ${d}.${m}`;
  }
  const time = (ms) => new Date(ms).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jerusalem" });

  async function load() {
    if (cfg.source === "firestore") {
      const url = `https://firestore.googleapis.com/v1/projects/${cfg.projectId}/databases/(default)/documents/${cfg.docPath}` + (cfg.apiKey ? `?key=${cfg.apiKey}` : "");
      const r = await fetch(url, { cache: "no-store" });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(r.status);
      const doc = await r.json();
      return JSON.parse(doc.fields.json.stringValue);
    }
    const r = await fetch("api/summary", { cache: "no-store" });
    if (!r.ok) throw new Error(r.status);
    return r.json();
  }

  function names(list, id, cls = "") {
    if (!list || !list.length) return "";
    return `<div class="names" id="${id}" ${open.has(id) ? "" : "hidden"}>${list.map((n) => `<span class="chip ${cls}">${esc(n)}</span>`).join("")}</div>`;
  }

  function render(s) {
    if (!s) {
      $("main").innerHTML = `<div class="empty">עוד אין סיכום. הבוט יפרסם אותו אחרי הסנכרון הראשון.</div>`;
      return;
    }
    document.title = `${s.title} – סיכום`;
    $("title").textContent = s.title;
    $("day").textContent = dayLabel(s.day);
    const st = $("status");
    st.className = "pill " + s.status;
    st.textContent = s.status === "final" ? "סיכום סופי" : s.status === "paused" ? "העדכון מושהה" : `מתעדכן כל ${s.intervalMin} דק׳`;

    let h = "";
    if (s.notice) h += `<div class="notice">${esc(s.notice)}</div>`;
    if (s.status === "final") h += `<div class="banner final">🔒 זה הסיכום הסופי${s.finalizedAt ? ` (נסגר ב-${time(s.finalizedAt)})` : ""}</div>`;

    const a = s.attendance;
    if (a) {
      const stat = (cls, n, label, id) =>
        `<div class="stat ${cls}" role="button" tabindex="0" data-toggle="${id}" aria-expanded="${open.has(id)}"><div class="n">${n ?? "–"}</div><div class="l">${label}</div></div>`;
      h += `<section class="card"><h2>מי מגיע?</h2><div class="sub">${s.namesHidden ? "" : "לחצו על מספר כדי לראות שמות"}</div>
        <div class="stats">${stat("ok", a.coming, "מגיעים", "n-ok")}${stat("mb", a.maybe, "אולי", "n-mb")}${stat("no", a.notComing, "לא מגיעים", "n-no")}${stat("q", a.noAnswer, "לא ענו", "n-q")}</div>
        ${names(a.comingNames, "n-ok")}${names(a.maybeNames, "n-mb")}${names(a.notComingNames, "n-no")}${names(a.noAnswerNames, "n-q")}</section>`;
    }

    if (s.leaders && s.leaders.length)
      h += `<section class="card lead"><h2>${s.status === "final" ? "נקבע" : "מוביל כרגע"}</h2>
        ${s.leaders.map((l) => `<div class="lead-row"><span>${esc(l.question)}</span><b>${esc(l.leader)}</b></div>`).join("")}</section>`;

    if (s.messages && s.messages.length)
      h += `<section class="card"><h2>הודעות בקבוצה היום</h2>
        ${s.messages.map((m) => `<div class="msg"><div class="msg-meta">${esc(m.from)} · ${time(m.ts)}</div><div class="msg-text">${esc(m.text)}</div></div>`).join("")}</section>`;

    for (const p of s.polls) {
      if (p.role === "attendance" && a) continue;
      const max = Math.max(1, ...p.options.map((o) => o.count));
      const excluded = p.excludedVoters
        ? `<div class="excluded">לא נספרו ${p.excludedVoters} שסימנו שלא מגיעים</div>`
        : "";
      h += `<section class="card"><h2>${esc(p.question)}</h2><div class="sub">${p.voters} הצביעו${p.multi ? " · אפשר לבחור כמה" : ""}</div>
        ${p.options
          .map((o, i) => {
            const id = `o-${p.id}-${i}`;
            return `<div class="opt ${o.top ? "win" : ""} ${o.kind === "no" ? "neg" : ""}">
              <div class="opt-head" data-toggle="${id}"><span class="opt-name">${esc(o.name)}</span><span class="opt-count">${o.count}</span></div>
              <div class="bar"><i style="width:${(o.count / max) * 100}%"></i></div>
              ${names(o.voters.concat(o.excluded), id)}</div>`;
          })
          .join("")}
        ${excluded}</section>`;
    }
    if (!s.polls.length) h += `<div class="empty">${s.groupFound === false ? "הבוט עוד לא מצא את הקבוצה" : "עוד אין סקרים היום"}</div>`;
    $("main").innerHTML = h;
    // Excluded voters appear struck through in the option's list.
    for (const p of s.polls)
      p.options.forEach((o, i) => {
        const el = document.getElementById(`o-${p.id}-${i}`);
        if (el) [...el.children].slice(o.voters.length).forEach((c) => c.classList.add("x"));
      });

    $("foot").innerHTML =
      `עודכן לאחרונה ב-${time(s.syncedAt)}` +
      (s.nextSyncAt ? ` · העדכון הבא בסביבות ${time(s.nextSyncAt)}` : "") +
      (s.polls.some((p) => p.excludedVoters) || a ? `<br>בחירות של מי שסימן שלא מגיע לא נספרות בשאר הסקרים` : "");
  }

  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-toggle]");
    if (!t) return;
    const id = t.dataset.toggle;
    const el = document.getElementById(id);
    if (!el) return;
    el.hidden = !el.hidden;
    el.hidden ? open.delete(id) : open.add(id);
    if (t.hasAttribute("aria-expanded")) t.setAttribute("aria-expanded", String(!el.hidden));
  });
  document.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.matches("[data-toggle]")) {
      e.preventDefault();
      e.target.click();
    }
  });

  async function tick() {
    try {
      render(await load());
    } catch (e) {
      if (!document.querySelector(".card")) $("main").innerHTML = `<div class="empty">לא ניתן לטעון את הסיכום כרגע (${esc(e.message)})</div>`;
    }
  }
  tick();
  setInterval(tick, 60_000);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && tick());
})();
