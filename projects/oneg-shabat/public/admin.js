// Admin panel (served only to 127.0.0.1).
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const time = (ms) => (ms ? new Date(ms).toLocaleString("he-IL", { weekday: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jerusalem" }) : "–");
  const dayLabel = (d) => d.split("-").reverse().slice(0, 2).join(".");
  let S = null;
  let peopleFilter = "";
  let pairPhone = "";
  try {
    pairPhone = localStorage.getItem("pairPhone") || "";
  } catch {}
  const openDetails = new Set();

  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast.t);
    toast.t = setTimeout(() => t.classList.remove("show"), 2600);
  }

  async function act(body, okMsg) {
    try {
      const r = await fetch("api/admin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || r.status);
      if (okMsg) toast(okMsg);
      await refresh(true);
      return j;
    } catch (e) {
      toast("שגיאה: " + e.message);
      throw e;
    }
  }

  async function copy(text, msg = "הועתק") {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    toast(msg);
  }

  function waCard(w) {
    if (w.status === "open")
      return `<section class="card"><h2><span class="dot on"></span>וואטסאפ מחובר</h2>
        <div class="sub">מחובר כ-${esc(w.me)}. הבוט רק קורא סקרים, הוא לא כותב בקבוצה.</div>
        <button class="danger" data-act="logout">ניתוק וחיבור מספר אחר</button></section>`;
    if (w.status === "qr") {
      const pairing = w.pairing
        ? `<div class="big-code">${esc(w.pairing.code)}</div>
          <div class="row" style="justify-content:center"><button data-copy="${esc(w.pairing.code.replace("-", ""))}">📋 העתק קוד</button></div>
          <ol class="steps">
            <li>פותחים וואטסאפ ← ⋮ (או הגדרות) ← <b>מכשירים מקושרים</b> ← <b>קישור מכשיר</b></li>
            <li>בתחתית מסך הסריקה: <b>"קישור עם מספר טלפון במקום זאת"</b></li>
            <li>מקלידים את הקוד שלמעלה. הוא בתוקף כ-3 דקות (אפשר לבקש חדש)</li>
          </ol>`
        : "";
      return `<section class="card"><h2><span class="dot wait"></span>חיבור וואטסאפ</h2>
        <div class="sub">מזינים את המספר של הטלפון שנמצא בקבוצת עונג שבת (גם אם זה הטלפון הזה) ומקבלים קוד לחיבור, בלי לסרוק.</div>
        <div class="row"><input class="grow" type="tel" id="pairPhone" inputmode="tel" placeholder="050-1234567" value="${esc(pairPhone)}"><button class="primary" id="pairBtn">${w.pairing ? "קוד חדש" : "קבל קוד"}</button></div>
        ${pairing}
        <details ${openDetails.has("qr") ? "open" : ""} data-key="qr" style="margin-top:12px"><summary>או: סריקת ברקוד מטלפון אחר</summary>
          <div class="sub" style="margin-top:6px">בטלפון שבקבוצה: וואטסאפ ← מכשירים מקושרים ← קישור מכשיר, וסורקים:</div>
          <img class="qr" src="${w.qr}" alt="QR"></details></section>`;
    }
    return `<section class="card"><h2><span class="dot off"></span>וואטסאפ: ${w.status === "closed" ? "מתחבר מחדש…" : "מתחבר…"}</h2>
      <div class="sub">${esc(w.error || "")}</div></section>`;
  }

  function render() {
    const s = S.settings;
    const snap = S.snapshot;
    $("hday").textContent = "יום " + dayLabel(S.day);
    const hs = $("hstatus");
    hs.className = "pill " + (S.isFinal ? "final" : s.paused ? "paused" : "live");
    hs.textContent = S.isFinal ? "סיכום סופי" : s.paused ? "מושהה" : `פעיל · כל ${s.intervalMin} דק׳`;

    let h = waCard(S.wa);

    // Control
    const a = snap?.attendance;
    h += `<section class="card"><h2>בקרה</h2>
      <div class="kv">
        <b>קבוצה</b><span>${S.groupJid ? esc(S.groups.find((g) => g.id === S.groupJid)?.subject || S.groupJid) : "⚠ לא נמצאה (בחרו למטה)"}</span>
        <b>יום</b><span>${dayLabel(S.day)} ${s.dayMode === "auto" ? "(אוטומטי)" : "(קבוע)"}</span>
        <b>סנכרון אחרון</b><span>${time(snap?.syncedAt)}</span>
        <b>הבא</b><span>${snap?.nextSyncAt ? time(snap.nextSyncAt) : "–"}</span>
        <b>סקרים היום</b><span>${S.polls.length}${a ? ` · מגיעים ${a.coming} · לא מגיעים ${a.notComing}` : ""}</span>
        ${S.pendingVotes ? `<b>הצבעות ממתינות</b><span>${S.pendingVotes} (לסקרים שהבוט לא ראה)</span>` : ""}
      </div>
      <div class="row" style="margin-top:12px">
        <button class="primary" data-act="sync">🔄 סנכרן עכשיו</button>
        ${s.paused ? `<button data-act="resume">▶ המשך בדיקות</button>` : `<button data-act="pause">⏸ עצור בדיקות</button>`}
        ${S.isFinal ? `<button data-act="unfinalize">🔓 בטל סיכום סופי</button>` : `<button class="gold" data-act="finalize">🔒 סיכום סופי</button>`}
      </div>
      <div class="sub" style="margin-top:8px">סיכום סופי מקפיא את הסיכום של היום: הוא לא יתעדכן יותר, גם אם יצביעו.</div></section>`;

    // Share
    h += `<section class="card"><h2>שיתוף</h2>
      ${S.publish.url ? `<label class="f">קישור ציבורי</label><div class="row"><a class="link grow" href="${esc(S.publish.url)}" target="_blank">${esc(S.publish.url)}</a><button data-copy="${esc(S.publish.url)}">העתק</button></div>` : `<div class="sub">אין קישור ציבורי (חסרות הגדרות Firebase, ראו למטה).</div>`}
      <div class="sub">${S.publish.configured ? (s.publicEnabled ? (S.publish.lastError ? "⚠ " + esc(S.publish.lastError) : S.publish.lastOkAt ? "פורסם לאחרונה " + time(S.publish.lastOkAt) : "") : "הפרסום הציבורי כבוי") : ""}</div>
      <div class="row" style="margin-top:8px">
        <a href="/" target="_blank"><button>👁 דף הסיכום</button></a>
        <button data-act-text>📋 העתק סיכום לוואטסאפ</button>
        <button data-act="sendSelf" data-msg="נשלח אליך בוואטסאפ">📨 שלח אליי</button>
      </div></section>`;

    // Group & day
    h += `<section class="card"><h2>קבוצה ויום</h2>
      <label class="f">קבוצה</label>
      <select id="groupSel"><option value="">אוטומטי: שם שמכיל "${esc(s.groupNameMatch)}"</option>
        ${S.groups.map((g) => `<option value="${esc(g.id)}" ${s.groupJid === g.id ? "selected" : ""}>${esc(g.subject)} (${g.size})</option>`).join("")}</select>
      <label class="f">איזה יום לסכם</label>
      <select id="daySel"><option value="auto">אוטומטי: היום, או היום האחרון עם סקרים</option>
        ${S.days.map((d) => `<option value="${d}" ${s.dayMode === d ? "selected" : ""}>${dayLabel(d)}${S.finalDays.includes(d) ? " 🔒" : ""}</option>`).join("")}</select></section>`;

    // Polls
    h += `<section class="card"><h2>הסקרים של ${dayLabel(S.day)}</h2>
      <div class="sub">סקר "נוכחות" (מי בא / באים היום…) קובע מי לא מגיע. הבחירות של מי שלא מגיע לא נספרות בשאר הסקרים.</div>
      ${S.polls.length ? "" : `<div class="sub">אין סקרים ביום הזה. הבוט רואה רק סקרים שנשלחו או קיבלו הצבעות אחרי שחובר.</div>`}
      ${S.polls
        .map(
          (p) => `<div class="poll"><h3>${esc(p.question)}</h3>
        <div class="sub">${time(p.ts)} · ${p.votes} הצביעו · ${p.role === "attendance" ? "נוכחות" : "רגיל"}</div>
        <div class="row"><select class="grow" data-poll-role="${esc(p.id)}">
            <option value="auto" ${p.roleSetting === "auto" ? "selected" : ""}>סוג: אוטומטי (${p.autoRole === "attendance" ? "נוכחות" : "רגיל"})</option>
            <option value="attendance" ${p.roleSetting === "attendance" ? "selected" : ""}>סקר נוכחות</option>
            <option value="regular" ${p.roleSetting === "regular" ? "selected" : ""}>סקר רגיל</option></select>
          <label class="chk"><input type="checkbox" data-poll-hidden="${esc(p.id)}" ${p.hidden ? "checked" : ""}> הסתר מהסיכום</label></div>
        ${p.role === "attendance" ? `<label class="f">מה כל תשובה אומרת?</label>
          ${p.options
            .map(
              (o, i) => `<div class="row" style="margin:4px 0"><span class="grow">${esc(o)}</span>
              <select data-kind="${esc(p.id)}" data-i="${i}" style="width:auto">
                ${[["yes", "מגיע"], ["maybe", "אולי"], ["no", "לא מגיע"]].map(([k, l]) => `<option value="${k}" ${p.kinds[i] === k ? "selected" : ""}>${l}${p.autoKinds[i] === k ? " (אוטומטי)" : ""}</option>`).join("")}
              </select></div>`,
            )
            .join("")}` : ""}
      </div>`,
        )
        .join("")}</section>`;

    // People
    const people = S.people.filter((p) => !peopleFilter || (p.name + p.key).includes(peopleFilter));
    h += `<section class="card"><details ${openDetails.has("people") ? "open" : ""} data-key="people"><summary>אנשים (${S.people.length}): סימון ידני וכינויים</summary>
      <div class="sub" style="margin-top:6px">סימון ידני גובר על הסקר (למשל מי שהודיע בעל-פה). כינוי מחליף את השם שמופיע בסיכום.</div>
      <input type="text" id="peopleFilter" placeholder="חיפוש…" value="${esc(peopleFilter)}">
      ${people
        .map(
          (p) => `<div class="person"><div><div class="nm">${esc(p.name)}</div><div class="st ${p.status}">${{ coming: "מגיע", maybe: "אולי", notComing: "לא מגיע", none: "לא ענה" }[p.status]}${p.override ? " (ידני)" : ""}</div></div>
        <select data-override="${esc(p.key)}"><option value="">לפי הסקר</option>${[["coming", "מגיע"], ["maybe", "אולי"], ["notComing", "לא מגיע"]].map(([k, l]) => `<option value="${k}" ${p.override === k ? "selected" : ""}>${l}</option>`).join("")}</select>
        <input type="text" data-nick="${esc(p.key)}" value="${esc(p.nickname)}" placeholder="כינוי (${esc(p.key.split("@")[0])})"></div>`,
        )
        .join("")}</details></section>`;

    // Settings
    h += `<section class="card"><h2>הגדרות</h2>
      <label class="f">כותרת</label><input type="text" id="sTitle" value="${esc(s.title)}">
      <label class="f">הודעה שתופיע בראש הדף הציבורי</label><textarea id="sNotice" placeholder="למשל: הסעודה בבית הכנסת, נא להביא כיבוד">${esc(s.notice)}</textarea>
      <label class="f">סנכרון כל (דקות)</label><input type="number" id="sInterval" min="1" max="120" value="${s.intervalMin}">
      <label class="f">חיפוש הקבוצה לפי שם</label><input type="text" id="sMatch" value="${esc(s.groupNameMatch)}">
      <label class="chk"><input type="checkbox" id="sNames" ${s.showNames ? "checked" : ""}> להציג שמות בדף הציבורי</label>
      <label class="chk"><input type="checkbox" id="sPublic" ${s.publicEnabled ? "checked" : ""}> לפרסם לקישור הציבורי</label>
      <button class="primary" id="saveSettings">שמירה</button></section>`;

    // Firebase
    h += `<section class="card"><details ${openDetails.has("fb") ? "open" : ""} data-key="fb"><summary>פרסום ציבורי (Firebase)</summary>
      <div class="sub" style="margin-top:6px">${S.publish.configured ? "מוגדר." : "לא מוגדר."} כדי להריץ את הבוט גם במחשב: מעתיקים מכאן את ההגדרות ומדביקים אותן בממשק הניהול במחשב.</div>
      <div class="row"><button id="fbShow">📋 העתק הגדרות</button></div>
      <label class="f">הדבקת הגדרות (JSON)</label><textarea id="fbJson" placeholder='{"projectId": "...", ...}'></textarea>
      <button id="fbSave">שמירת הגדרות</button></details></section>`;

    $("main").innerHTML = h;
  }

  async function refresh(force) {
    const busy = document.activeElement && document.activeElement.matches("input, textarea, select");
    if (!force && busy) return;
    const r = await fetch("api/admin/state", { cache: "no-store" });
    S = await r.json();
    document.querySelectorAll("details[data-key]").forEach((d) => (d.open ? openDetails.add(d.dataset.key) : openDetails.delete(d.dataset.key)));
    const y = window.scrollY;
    render();
    window.scrollTo(0, y);
  }

  document.addEventListener("click", async (e) => {
    const t = e.target;
    const actBtn = t.closest("[data-act]");
    if (actBtn) {
      const a = actBtn.dataset.act;
      if (a === "logout" && !confirm("לנתק את וואטסאפ מהבוט?")) return;
      if (a === "finalize" && !confirm("לנעול את הסיכום של היום? הוא לא יתעדכן יותר.")) return;
      actBtn.disabled = true;
      await act({ action: a }, actBtn.dataset.msg || "בוצע").catch(() => {});
      return;
    }
    if (t.closest("[data-act-text]")) {
      const j = await act({ action: "text" });
      return copy(j.text, "הסיכום הועתק, אפשר להדביק בוואטסאפ");
    }
    if (t.dataset.copy) return copy(t.dataset.copy);
    if (t.id === "pairBtn") {
      pairPhone = $("pairPhone").value.trim();
      try {
        localStorage.setItem("pairPhone", pairPhone);
      } catch {}
      t.disabled = true;
      t.textContent = "מבקש קוד…";
      return act({ action: "pair", phone: pairPhone }, "הקוד מוכן").catch(() => {});
    }
    if (t.id === "saveSettings") {
      return act(
        {
          action: "settings",
          settings: {
            title: $("sTitle").value.trim() || "עונג שבת",
            notice: $("sNotice").value,
            intervalMin: Number($("sInterval").value),
            groupNameMatch: $("sMatch").value.trim(),
            showNames: $("sNames").checked,
            publicEnabled: $("sPublic").checked,
          },
        },
        "נשמר",
      );
    }
    if (t.id === "fbShow") {
      const j = await act({ action: "firebaseShow" });
      return copy(j.json, "ההגדרות הועתקו");
    }
    if (t.id === "fbSave") return act({ action: "firebase", json: $("fbJson").value }, "נשמר");
  });

  document.addEventListener("change", (e) => {
    const t = e.target;
    if (t.id === "groupSel") return act({ action: "settings", settings: { groupJid: t.value || null } }, "הקבוצה עודכנה");
    if (t.id === "daySel") return act({ action: "settings", settings: { dayMode: t.value } }, "היום עודכן");
    if (t.dataset.pollRole) return act({ action: "poll", id: t.dataset.pollRole, role: t.value }, "עודכן");
    if (t.dataset.pollHidden) return act({ action: "poll", id: t.dataset.pollHidden, hidden: t.checked }, "עודכן");
    if (t.dataset.kind) {
      const p = S.polls.find((x) => x.id === t.dataset.kind);
      const i = Number(t.dataset.i);
      return act({ action: "poll", id: p.id, option: p.options[i], kind: t.value === p.autoKinds[i] ? null : t.value }, "עודכן");
    }
    if (t.dataset.override !== undefined) return act({ action: "person", key: t.dataset.override, override: t.value || null }, "עודכן");
    if (t.dataset.nick !== undefined) return act({ action: "person", key: t.dataset.nick, nickname: t.value }, "הכינוי נשמר");
  });

  document.addEventListener("toggle", (e) => {
    const d = e.target;
    if (d.dataset?.key) d.open ? openDetails.add(d.dataset.key) : openDetails.delete(d.dataset.key);
  }, true);

  document.addEventListener("input", (e) => {
    if (e.target.id === "pairPhone") pairPhone = e.target.value;
    if (e.target.id !== "peopleFilter") return;
    peopleFilter = e.target.value.trim();
    const pos = e.target.selectionStart;
    render();
    const f = $("peopleFilter");
    f.focus();
    f.setSelectionRange(pos, pos);
  });

  refresh(true);
  setInterval(() => refresh(false), 4000);
})();
