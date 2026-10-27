// Client for the Akinator game: screens, language picker and calls to /api/*.
const LANGS = [
  { region: "il", name: "עברית", flag: "🇮🇱" },
  { region: "en", name: "English", flag: "🇬🇧" },
  { region: "ar", name: "العربية", flag: "🇸🇦" },
  { region: "ru", name: "Русский", flag: "🇷🇺" },
  { region: "fr", name: "Français", flag: "🇫🇷" },
  { region: "es", name: "Español", flag: "🇪🇸" },
  { region: "de", name: "Deutsch", flag: "🇩🇪" },
  { region: "it", name: "Italiano", flag: "🇮🇹" },
  { region: "pt", name: "Português", flag: "🇧🇷" },
  { region: "nl", name: "Nederlands", flag: "🇳🇱" },
  { region: "pl", name: "Polski", flag: "🇵🇱" },
  { region: "tr", name: "Türkçe", flag: "🇹🇷" },
  { region: "jp", name: "日本語", flag: "🇯🇵" },
  { region: "kr", name: "한국어", flag: "🇰🇷" },
  { region: "cn", name: "中文", flag: "🇨🇳" },
  { region: "id", name: "Indonesia", flag: "🇮🇩" },
];

// Texts around the game follow the chosen language: Hebrew for "il", English otherwise.
const UI = {
  he: {
    dir: "rtl",
    question: (n) => `שאלה ${n}`,
    back: "↩ חזרה לשאלה הקודמת",
    quit: "יציאה",
    thinking: "חושב…",
    guessIntro: "אני חושב שזה…",
    yes: "כן, צדקת!",
    no: "לא, זה לא",
    winTitle: "ניחשתי! 🎉",
    winText: (name) => `ידעתי שזה ${name}. רוצים לנסות לנצח אותי?`,
    loseTitle: "ניצחת אותי! 🏆",
    loseText: "לא הצלחתי לנחש את הדמות שלך. כל הכבוד!",
    again: "משחק חדש",
    home: "החלפת שפה",
    quitConfirm: "לצאת מהמשחק?",
  },
  en: {
    dir: "ltr",
    question: (n) => `Question ${n}`,
    back: "↩ Previous question",
    quit: "Quit",
    thinking: "Thinking…",
    guessIntro: "I think of…",
    yes: "Yes, that's it!",
    no: "No, it isn't",
    winTitle: "Got it! 🎉",
    winText: (name) => `I knew it was ${name}. Want to try to beat me?`,
    loseTitle: "You beat me! 🏆",
    loseText: "I couldn't guess your character. Well done!",
    again: "Play again",
    home: "Change language",
    quitConfirm: "Quit this game?",
  },
};

const $ = (id) => document.getElementById(id);
const screens = ["screenHome", "screenGame", "screenGuess", "screenEnd"];

let region = loadPref("region", "il");
let game = null; // last state from the server
let busy = false;
let lastGuessName = "";

function loadPref(key, fallback) {
  try {
    return localStorage.getItem(`aki.${key}`) ?? fallback;
  } catch {
    return fallback;
  }
}

function savePref(key, value) {
  try {
    localStorage.setItem(`aki.${key}`, value);
  } catch {}
}

function t() {
  return region === "il" ? UI.he : UI.en;
}

function show(id) {
  for (const s of screens) $(s).hidden = s !== id;
  const ui = t();
  // The home screen is always Hebrew; game screens follow the chosen language.
  document.documentElement.dir = id === "screenHome" ? "rtl" : ui.dir;
  window.scrollTo(0, 0);
}

function mood(name) {
  $("genieWrap").className = `genie-wrap ${name || ""}`;
}

function bubble(text) {
  $("bubble").hidden = !text;
  $("bubble").textContent = text || "";
}

function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), 4500);
}

async function api(action, body = {}) {
  const res = await fetch(`/api/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: "שגיאת תקשורת" }));
  if (!res.ok) throw Object.assign(new Error(data.error || "שגיאה"), { status: res.status });
  return data;
}

// Runs one server call while the genie "thinks"; locks the buttons meanwhile.
async function withThinking(fn) {
  if (busy) return;
  busy = true;
  setButtonsDisabled(true);
  mood("thinking");
  bubble(t().thinking);
  try {
    await fn();
  } catch (err) {
    mood("sad");
    toast(err.message);
    if (err.status === 410) goHome();
  } finally {
    busy = false;
    bubble("");
    setButtonsDisabled(false);
    if ($("genieWrap").classList.contains("thinking")) mood("");
  }
}

function setButtonsDisabled(disabled) {
  document.querySelectorAll("#screenGame button, #screenGuess button, #playBtn, #againBtn").forEach((b) => {
    b.disabled = disabled;
  });
  if (!disabled) {
    $("playBtn").disabled = !region;
    if (game && game.type === "question") $("backBtn").disabled = game.step <= 0;
  }
}

// --------------------------------------------------------------- rendering
function renderLangs() {
  const wrap = $("langs");
  wrap.innerHTML = "";
  for (const l of LANGS) {
    const b = document.createElement("button");
    b.className = `lang${l.region === region ? " selected" : ""}`;
    b.innerHTML = `<span class="flag">${l.flag}</span><span></span>`;
    b.lastChild.textContent = l.name;
    b.onclick = () => {
      region = l.region;
      savePref("region", region);
      renderLangs();
    };
    wrap.appendChild(b);
  }
  $("playBtn").disabled = !region;
}

function renderStats(stats) {
  if (!stats || !stats.games) return ($("stats").textContent = "");
  $("stats").textContent = `שוחקו ${stats.games} משחקים · אקינטור ניחש ${stats.akiWins} · ניצחתם ${stats.playerWins}`;
}

function render(state) {
  game = state;
  const ui = t();
  if (state.type === "question") {
    mood("");
    $("qNum").textContent = ui.question(state.step + 1);
    $("bar").style.width = `${Math.max(3, state.progress)}%`;
    $("question").textContent = state.question;
    const answers = $("answers");
    answers.innerHTML = "";
    state.answers.forEach((text, i) => {
      const b = document.createElement("button");
      b.className = "answer";
      b.dataset.a = i;
      b.dir = "auto";
      b.textContent = text;
      b.onclick = () => withThinking(async () => render(await api("answer", { id: game.id, answer: i })));
      answers.appendChild(b);
    });
    $("backBtn").textContent = ui.back;
    $("backBtn").disabled = state.step <= 0;
    $("quitBtn").textContent = ui.quit;
    show("screenGame");
  } else if (state.type === "guess") {
    mood("happy");
    lastGuessName = state.name;
    $("guessIntro").textContent = ui.guessIntro;
    $("guessName").textContent = state.name;
    $("guessDesc").textContent = state.description;
    const img = $("photo");
    $("photoWrap").classList.toggle("empty", !state.photo);
    img.onerror = () => $("photoWrap").classList.add("empty");
    img.src = state.photo || "";
    $("yesBtn").textContent = ui.yes;
    $("noBtn").textContent = ui.no;
    show("screenGuess");
  } else if (state.type === "giveup") {
    finish(false);
  }
}

async function finish(akiWon) {
  const ui = t();
  try {
    const { stats } = await api("finish", { id: game.id, won: akiWon });
    renderStats(stats);
  } catch {}
  game = null;
  mood(akiWon ? "happy" : "sad");
  $("endTitle").textContent = akiWon ? ui.winTitle : ui.loseTitle;
  $("endText").textContent = akiWon ? ui.winText(lastGuessName) : ui.loseText;
  $("againBtn").textContent = ui.again;
  $("homeBtn").textContent = ui.home;
  show("screenEnd");
}

function startGame() {
  const childMode = $("childMode").checked;
  savePref("childMode", childMode ? "1" : "0");
  withThinking(async () => render(await api("start", { region, childMode })));
}

function goHome() {
  game = null;
  mood("");
  show("screenHome");
  api("stats").then((r) => renderStats(r.stats)).catch(() => {});
}

// ------------------------------------------------------------------ events
$("playBtn").onclick = startGame;
$("againBtn").onclick = startGame;
$("homeBtn").onclick = goHome;
$("backBtn").onclick = () => withThinking(async () => render(await api("back", { id: game.id })));
$("quitBtn").onclick = () => {
  if (confirm(t().quitConfirm)) goHome();
};
$("yesBtn").onclick = () => finish(true);
$("noBtn").onclick = () => withThinking(async () => render(await api("continue", { id: game.id })));

$("childMode").checked = loadPref("childMode", "0") === "1";
renderLangs();
goHome();
