const STATE_KEY = "studypath_state_v1";
const PROGRESS_KEY = "studypath_progress_v1";
const LAST_ACTIVE_KEY = "studypath_last_active_v1";
const XP_PER_QUESTION = 1;
const XP_PER_THEORY = 1;
const XP_PER_FITB = 1;
const XP_CHAPTER_BONUS = 10;

const ICONS = {
  star: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.9 6.6 7.1.6-5.4 4.7 1.7 6.9L12 17l-6.3 3.8 1.7-6.9L2 8.2l7.1-.6z"/></svg>',
  flame: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 23c-4.42 0-8-3.4-8-7.6 0-3.6 2.6-6.4 3.8-9.9.7 1.7 1.7 2.6 1.7 4.3 0 1.3-.9 2.2-.9 3.5a2.9 2.9 0 005.8 0c0-1.3-.9-1.8-.9-3.2 0-.9.4-1.3.9-1.8 2.7 1.8 4.6 4.9 4.6 7.1 0 4.2-3.58 7.6-8 7.6z"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="4,12.5 9,17.5 20,5.5"/></svg>',
  arrowLeft: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="11,5 5,12 11,19"/></svg>',
  checkCircle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="7.5,12.5 10.5,15.5 16.5,8.5"/></svg>'
};
function icon(name, cls = "") {
  return `<span class="icon ${cls}">${ICONS[name]}</span>`;
}

function withTransition(fn) {
  const wrapped = () => { fn(); window.scrollTo(0, 0); };
  if (document.startViewTransition) {
    document.startViewTransition(wrapped);
  } else {
    wrapped();
  }
}

// Pushes a browser history entry so back/swipe-back steps through the app
// (chapter -> path -> home) instead of leaving the page entirely, since
// nothing else in this SPA ever calls pushState on its own.
function goHome() {
  history.pushState({ view: "home" }, "");
  renderHome();
}
function goPath(courseId) {
  history.pushState({ view: "path", courseId }, "");
  renderPath(courseId);
}
function goChapter(courseId, chapterId) {
  history.pushState({ view: "chapter", courseId, chapterId }, "");
  if (!resumeChapterProgress(courseId, chapterId)) startLesson(courseId, chapterId);
}

window.addEventListener("popstate", (e) => {
  const s = e.state || { view: "home" };
  if (s.view === "path") withTransition(() => renderPath(s.courseId));
  // Going back from anywhere inside a chapter (lesson/quiz/theory/fitb) lands
  // on the path view, same as clicking "Exit lesson" — this no longer loses
  // progress, since per-chapter progress is preserved (not cleared) on exit
  // and will silently resume next time this chapter is entered.
  else if (s.view === "chapter") withTransition(() => renderPath(s.courseId));
  else withTransition(renderHome);
});

const app = document.getElementById("app");
const statXp = document.getElementById("stat-xp");
const statStreak = document.getElementById("stat-streak");

let COURSES = [];         // loaded from data/courses.json + each course file
let state = loadState();
let nav = { view: "home", courseId: null, chapterId: null };
let lessonIndex = 0;
let quizQueue = [];       // array of question indices, wrong answers pushed to back
let quizAwarded = new Set(); // question indices already awarded XP this attempt
let currentQuestion = null;
let theoryQueue = [];       // array of theory question indices, "need review" pushed to back
let theoryAwarded = new Set();
let currentTheory = null;
let fitbQueue = [];       // array of fill-in-the-blank question indices, wrong answers pushed to back
let fitbAwarded = new Set();
let currentFitb = null;

// ---------------- state ----------------

function loadState() {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.courses) return parsed;
    }
  } catch (e) {
    console.error("Saved progress was corrupted, starting fresh:", e);
  }
  return { xp: 0, streak: 0, lastActiveDate: null, courses: {} };
}

function saveState() {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch (e) {
    console.error("Could not save progress (storage may be full or disabled):", e);
  }
  renderStats();
}

function ensureCourseState(courseId) {
  if (!state.courses[courseId]) {
    state.courses[courseId] = { completed: [], weakSpots: {}, earnedQuiz: [], earnedTheory: [], earnedFitb: [] };
  }
  const cs = state.courses[courseId];
  if (!cs.earnedQuiz) cs.earnedQuiz = [];
  if (!cs.earnedTheory) cs.earnedTheory = [];
  if (!cs.earnedFitb) cs.earnedFitb = [];
  return cs;
}

// ---------------- per-chapter progress (Duolingo-style resume) ----------------
//
// Two separate things are tracked, on purpose:
//  - PROGRESS_KEY: a map of chapterId -> saved position, one entry per
//    chapter. Survives forever (until that chapter is completed), so
//    clicking back into a chapter you left mid-way — even days later —
//    silently resumes it instead of restarting from card 1.
//  - LAST_ACTIVE_KEY: a single small pointer to whichever chapter the user
//    was literally inside (lesson/quiz/theory/fitb) at the moment the page
//    was last unloaded. Only used to handle an accidental refresh: on boot,
//    if this is set, jump straight back into that chapter. It's cleared the
//    moment the user deliberately leaves (Exit lesson / back / home), so a
//    normal refresh on the home or path screen never gets redirected.

function loadAllProgress() {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed;
    }
  } catch (e) {
    console.error("Saved progress was corrupted, ignoring:", e);
  }
  return {};
}

function hasChapterProgress(chapterId) {
  return !!loadAllProgress()[chapterId];
}

function saveChapterProgress() {
  if (!nav.chapterId) return;
  const all = loadAllProgress();
  all[nav.chapterId] = {
    courseId: nav.courseId,
    phase: nav.view,
    lessonIndex,
    quizQueue,
    quizAwarded: [...quizAwarded],
    currentQuestion,
    theoryQueue,
    theoryAwarded: [...theoryAwarded],
    currentTheory,
    fitbQueue,
    fitbAwarded: [...fitbAwarded],
    currentFitb,
  };
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(all));
    localStorage.setItem(LAST_ACTIVE_KEY, JSON.stringify({ courseId: nav.courseId, chapterId: nav.chapterId }));
  } catch (e) {
    console.error("Could not save chapter progress:", e);
  }
}

function clearChapterProgress(chapterId) {
  const all = loadAllProgress();
  if (all[chapterId]) {
    delete all[chapterId];
    try {
      localStorage.setItem(PROGRESS_KEY, JSON.stringify(all));
    } catch (e) {
      console.error("Could not clear chapter progress:", e);
    }
  }
}

function clearLastActive() {
  try {
    localStorage.removeItem(LAST_ACTIVE_KEY);
  } catch (e) {
    console.error("Could not clear last-active pointer:", e);
  }
}

function loadLastActive() {
  try {
    const raw = localStorage.getItem(LAST_ACTIVE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {
    console.error("Last-active pointer was corrupted, ignoring:", e);
  }
  return null;
}

// Restores exactly where the user left off in a specific chapter (which
// card/question, and how far through the requeue any wrong answers had
// gotten). Returns false if there's nothing valid to resume, so the caller
// can fall back to starting that chapter fresh (or, from init, the home
// screen).
function resumeChapterProgress(courseId, chapterId) {
  const all = loadAllProgress();
  const p = all[chapterId];
  if (!p) return false;

  const course = getCourse(courseId);
  const chapter = course && course.chapters.find(c => c.id === chapterId);
  if (!chapter) { clearChapterProgress(chapterId); return false; }

  nav = { view: p.phase, courseId, chapterId };
  history.replaceState({ view: "chapter", courseId, chapterId }, "");

  if (p.phase === "lesson" && chapter.cards && chapter.cards[p.lessonIndex]) {
    lessonIndex = p.lessonIndex || 0;
    renderLessonCard();
    return true;
  }
  if (p.phase === "quiz" && chapter.quiz && chapter.quiz[p.currentQuestion]) {
    quizQueue = Array.isArray(p.quizQueue) ? p.quizQueue : [];
    quizAwarded = new Set(p.quizAwarded || []);
    currentQuestion = p.currentQuestion;
    renderQuizQuestion(currentQuestion);
    return true;
  }
  if (p.phase === "theory" && chapter.theory && chapter.theory[p.currentTheory]) {
    theoryQueue = Array.isArray(p.theoryQueue) ? p.theoryQueue : [];
    theoryAwarded = new Set(p.theoryAwarded || []);
    currentTheory = p.currentTheory;
    renderTheoryQuestion(currentTheory, false);
    return true;
  }
  if (p.phase === "fitb" && chapter.fitb && chapter.fitb[p.currentFitb]) {
    fitbQueue = Array.isArray(p.fitbQueue) ? p.fitbQueue : [];
    fitbAwarded = new Set(p.fitbAwarded || []);
    currentFitb = p.currentFitb;
    renderFitbQuestion(currentFitb);
    return true;
  }
  clearChapterProgress(chapterId);
  return false;
}

function localDateString(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function touchStreakAndSave() {
  const today = localDateString();
  if (state.lastActiveDate !== today) {
    const y = new Date();
    y.setDate(y.getDate() - 1);
    const yesterday = localDateString(y);
    state.streak = state.lastActiveDate === yesterday ? state.streak + 1 : 1;
    state.lastActiveDate = today;
  }
  saveState();
}

function bumpStat(el, newValue) {
  if (el.textContent !== String(newValue)) {
    el.textContent = newValue;
    el.parentElement.classList.remove("bump");
    void el.parentElement.offsetWidth; // restart animation
    el.parentElement.classList.add("bump");
  }
}

function renderStats() {
  bumpStat(statXp, state.xp);
  bumpStat(statStreak, state.streak);
}

// ---------------- data loading ----------------

async function loadCourses() {
  const list = await fetch("data/courses.json").then(r => {
    if (!r.ok) throw new Error(`Could not load course list (${r.status})`);
    return r.json();
  });
  const results = await Promise.allSettled(
    list.map(c => fetch(`data/${c.file}`).then(r => {
      if (!r.ok) throw new Error(`${c.file} (${r.status})`);
      return r.json();
    }))
  );
  COURSES = results.filter(r => r.status === "fulfilled").map(r => r.value);
  const failed = results.filter(r => r.status === "rejected");
  if (failed.length) {
    console.error("Some courses failed to load and were skipped:", failed.map(f => f.reason));
  }
  if (COURSES.length === 0) {
    throw new Error("No course data could be loaded.");
  }
}

function renderLoadError() {
  app.innerHTML = "";
  const box = document.createElement("div");
  box.className = "card glass";
  box.innerHTML = `
    <h2>Couldn't load StudyPath</h2>
    <p>Something went wrong loading course data. Check your connection and try reloading the page. If this keeps happening, the course files may be missing or corrupted.</p>
  `;
  app.appendChild(box);
  const bar = document.createElement("div");
  bar.className = "bottom-bar";
  bar.style.justifyContent = "center";
  const btn = document.createElement("button");
  btn.className = "btn-primary";
  btn.textContent = "Reload";
  btn.addEventListener("click", () => window.location.reload());
  bar.appendChild(btn);
  app.appendChild(bar);
}

function getCourse(courseId) {
  return COURSES.find(c => c.id === courseId);
}

function progressTrackHtml(filled, total) {
  let html = '<div class="progress-track">';
  for (let i = 0; i < total; i++) {
    let cls = "progress-seg";
    if (i < filled) cls += " filled";
    else if (i === filled) cls += " current";
    html += `<div class="${cls}"></div>`;
  }
  html += "</div>";
  return html;
}

function hasContent(ch) {
  return (ch.cards && ch.cards.length > 0) || (ch.quiz && ch.quiz.length > 0) || (ch.theory && ch.theory.length > 0);
}

function getChapterStatus(chapters, i, completedSet) {
  const ch = chapters[i];
  if (!hasContent(ch)) return "empty";
  if (completedSet.has(ch.id)) return "completed";
  for (let j = i - 1; j >= 0; j--) {
    if (hasContent(chapters[j])) {
      return completedSet.has(chapters[j].id) ? "available" : "locked";
    }
  }
  return "available";
}

// ---------------- views ----------------

let homeFilter = "All";

function renderHome() {
  nav = { view: "home", courseId: null, chapterId: null };
  clearLastActive();
  app.innerHTML = "";

  const categories = ["All", ...new Set(COURSES.flatMap(c => c.category || []))];
  if (categories.length > 2) {
    const tabs = document.createElement("div");
    tabs.className = "filter-tabs";
    categories.forEach(cat => {
      const tab = document.createElement("button");
      tab.className = "filter-tab" + (cat === homeFilter ? " active" : "");
      tab.textContent = cat;
      tab.addEventListener("click", () => {
        homeFilter = cat;
        withTransition(renderHome);
      });
      tabs.appendChild(tab);
    });
    app.appendChild(tabs);
  }

  const list = document.createElement("div");
  list.className = "course-list";

  const visibleCourses = (homeFilter === "All" ? COURSES : COURSES.filter(c => (c.category || []).includes(homeFilter)))
    .slice()
    .sort((a, b) => a.code.localeCompare(b.code));

  visibleCourses.forEach(course => {
    const cs = state.courses[course.id];
    const completedCount = cs ? cs.completed.length : 0;
    const readyChapters = course.chapters.filter(hasContent);
    const pct = readyChapters.length
      ? Math.round((completedCount / readyChapters.length) * 100)
      : 0;

    const tpl = document.getElementById("tpl-course-card");
    const node = tpl.content.cloneNode(true);
    const btn = node.querySelector(".course-card");
    node.querySelector(".course-code").textContent = course.code;
    node.querySelector(".course-title").textContent = course.title;
    node.querySelector(".course-progress-bar").style.width = pct + "%";
    if (readyChapters.length === 0) {
      btn.disabled = true;
      btn.classList.add("empty");
      node.querySelector(".course-progress").remove();
    } else {
      btn.addEventListener("click", () => withTransition(() => goPath(course.id)));
    }
    list.appendChild(node);
  });

  app.appendChild(list);
}

function renderPath(courseId) {
  nav = { view: "path", courseId, chapterId: null };
  clearLastActive();
  const course = getCourse(courseId);
  const cs = ensureCourseState(courseId);
  const completedSet = new Set(cs.completed);

  app.innerHTML = "";

  const back = document.createElement("button");
  back.className = "back-btn";
  back.innerHTML = icon("arrowLeft") + "All courses";
  back.addEventListener("click", () => withTransition(goHome));
  app.appendChild(back);

  const heading = document.createElement("div");
  heading.className = "course-heading";
  heading.innerHTML = `<h1>${escapeHtml(course.code)}</h1><p>${escapeHtml(course.title)}</p>` +
    (course.note ? `<p class="course-note">${escapeHtml(course.note)}</p>` : "");
  app.appendChild(heading);

  const path = document.createElement("div");
  path.className = "path";

  course.chapters.forEach((ch, i) => {
    const status = getChapterStatus(course.chapters, i, completedSet);
    const inProgress = status === "available" && hasChapterProgress(ch.id);
    const wrap = document.createElement("div");
    wrap.className = `node-wrap pos-${i % 4}`;

    const tpl = document.getElementById("tpl-chapter-node");
    const node = tpl.content.cloneNode(true);
    const btn = node.querySelector(".chapter-node");
    btn.classList.add(status);
    if (inProgress) btn.classList.add("in-progress");
    node.querySelector(".node-num").innerHTML =
      status === "completed" ? icon("check") : ch.number;
    node.querySelector(".node-title").textContent =
      status === "empty" ? `Ch.${ch.number} — coming soon` : inProgress ? `${ch.title} · In progress` : ch.title;

    if (status === "available" || status === "completed") {
      btn.addEventListener("click", () => withTransition(() => goChapter(courseId, ch.id)));
    }

    wrap.appendChild(node);
    path.appendChild(wrap);
  });

  app.appendChild(path);
}

// ---------------- lesson ----------------

function startLesson(courseId, chapterId) {
  nav = { view: "lesson", courseId, chapterId };
  lessonIndex = 0;
  const ch = currentChapter();
  if (ch.cards && ch.cards.length > 0) {
    renderLessonCard();
  } else {
    afterLesson(); // no lesson content — straight to quiz/theory (pure test-practice chapters)
  }
}

function currentChapter() {
  return getCourse(nav.courseId).chapters.find(c => c.id === nav.chapterId);
}

function renderLessonCard() {
  const ch = currentChapter();
  const total = ch.cards.length;
  app.innerHTML = "";

  const back = document.createElement("button");
  back.className = "back-btn";
  back.innerHTML = icon("x") + "Exit lesson";
  back.addEventListener("click", () => withTransition(() => goPath(nav.courseId)));
  app.appendChild(back);

  const progress = document.createElement("div");
  progress.innerHTML = progressTrackHtml(lessonIndex, total);
  app.appendChild(progress.firstChild);

  const card = ch.cards[lessonIndex];
  const cardEl = document.createElement("div");
  cardEl.className = "card glass";
  const visualHtml = card.visual ? renderVisualHTML(card.visual, `${ch.id}-${lessonIndex}`) : "";
  cardEl.innerHTML = `<h2>${escapeHtml(card.heading)}</h2><p>${escapeHtml(card.body)}</p>${visualHtml}`;
  app.appendChild(cardEl);
  if (card.visual) initVisual(cardEl, card.visual);

  const bar = document.createElement("div");
  bar.className = "bottom-bar";
  bar.style.justifyContent = lessonIndex > 0 ? "space-between" : "flex-end";

  if (lessonIndex > 0) {
    const prevBtn = document.createElement("button");
    prevBtn.className = "btn-secondary";
    prevBtn.textContent = "Previous";
    prevBtn.addEventListener("click", () => withTransition(() => {
      lessonIndex--;
      renderLessonCard();
    }));
    bar.appendChild(prevBtn);
  }

  const btn = document.createElement("button");
  btn.className = "btn-primary";
  btn.textContent = lessonIndex === total - 1 ? nextPhaseLabel() : "Continue";
  btn.addEventListener("click", () => withTransition(() => {
    lessonIndex++;
    if (lessonIndex >= total) {
      afterLesson();
    } else {
      renderLessonCard();
    }
  }));
  bar.appendChild(btn);
  app.appendChild(bar);
  saveChapterProgress();
}

function nextPhaseLabel() {
  const ch = currentChapter();
  if (ch.quiz && ch.quiz.length > 0) return "Start quiz";
  if (ch.fitb && ch.fitb.length > 0) return "Start fill-in-the-blank";
  if (ch.theory && ch.theory.length > 0) return "Start practice";
  return "Finish";
}

function afterLesson() {
  const ch = currentChapter();
  if (ch.quiz && ch.quiz.length > 0) startQuiz();
  else if (ch.fitb && ch.fitb.length > 0) startFitb();
  else if (ch.theory && ch.theory.length > 0) startTheory();
  else finishChapter();
}

function afterQuiz() {
  const ch = currentChapter();
  if (ch.fitb && ch.fitb.length > 0) startFitb();
  else if (ch.theory && ch.theory.length > 0) startTheory();
  else finishChapter();
}

function afterFitb() {
  const ch = currentChapter();
  if (ch.theory && ch.theory.length > 0) startTheory();
  else finishChapter();
}

// ---------------- quiz ----------------

function startQuiz() {
  nav.view = "quiz";
  const ch = currentChapter();
  quizQueue = ch.quiz.map((_, i) => i);
  quizAwarded = new Set();
  nextQuizQuestion();
}

function nextQuizQuestion() {
  if (quizQueue.length === 0) {
    afterQuiz();
    return;
  }
  const qIndex = quizQueue.shift();
  currentQuestion = qIndex;
  renderQuizQuestion(qIndex);
}

function renderQuizQuestion(qIndex) {
  const ch = currentChapter();
  const q = ch.quiz[qIndex];
  app.innerHTML = "";

  const back = document.createElement("button");
  back.className = "back-btn";
  back.innerHTML = icon("x") + "Exit lesson";
  back.addEventListener("click", () => withTransition(() => goPath(nav.courseId)));
  app.appendChild(back);

  const progress = document.createElement("div");
  progress.innerHTML = progressTrackHtml(quizAwarded.size, ch.quiz.length);
  app.appendChild(progress.firstChild);

  const qEl = document.createElement("div");
  qEl.className = "quiz-question";
  qEl.textContent = q.question;
  app.appendChild(qEl);

  const optsEl = document.createElement("div");
  optsEl.className = "options";

  q.options.forEach((opt, i) => {
    const optBtn = document.createElement("button");
    optBtn.className = "option";
    optBtn.textContent = opt;
    optBtn.addEventListener("click", () => handleAnswer(qIndex, i, optsEl));
    optsEl.appendChild(optBtn);
  });
  app.appendChild(optsEl);
  saveChapterProgress();
}

function handleAnswer(qIndex, chosenIndex, optsEl) {
  const ch = currentChapter();
  const q = ch.quiz[qIndex];
  const correct = chosenIndex === q.correctIndex;

  [...optsEl.children].forEach((btn, i) => {
    btn.disabled = true;
    if (i === q.correctIndex) btn.classList.add("correct");
    else if (i === chosenIndex) btn.classList.add("incorrect");
  });

  if (correct) {
    quizAwarded.add(qIndex);
    const cs = ensureCourseState(nav.courseId);
    const earnedKey = `${ch.id}:${qIndex}`;
    if (!cs.earnedQuiz.includes(earnedKey)) {
      cs.earnedQuiz.push(earnedKey);
      state.xp += XP_PER_QUESTION;
    }
    saveState();
  } else {
    const cs = ensureCourseState(nav.courseId);
    const key = `${ch.id}:${qIndex}`;
    cs.weakSpots[key] = (cs.weakSpots[key] || 0) + 1;
    saveState();
    quizQueue.push(qIndex); // re-ask this one again before finishing
  }

  const fb = document.createElement("div");
  fb.className = "feedback-box " + (correct ? "correct" : "incorrect");
  fb.innerHTML = `<div class="fb-title">${correct ? "Correct!" : "Not quite"}</div>${escapeHtml(q.explanation)}`;
  app.appendChild(fb);

  const bar = document.createElement("div");
  bar.className = "bottom-bar";
  const btn = document.createElement("button");
  btn.className = "btn-primary";
  btn.textContent = "Continue";
  btn.addEventListener("click", () => withTransition(nextQuizQuestion));
  bar.appendChild(btn);
  app.appendChild(bar);
}

// ---------------- fill in the blank ----------------

function normalizeFitbAnswer(s) {
  return (s || "").trim().toLowerCase().replace(/[.,;:]+$/, "");
}

// `accepted` is either a single answer string or an array of acceptable
// variants (e.g. "Trojan" / "Trojan horse") — matches if any variant equals
// the given answer once both sides are trimmed, lowercased and stripped of
// trailing punctuation.
function fitbAnswerMatches(given, accepted) {
  const list = Array.isArray(accepted) ? accepted : [accepted];
  const norm = normalizeFitbAnswer(given);
  return list.some(a => normalizeFitbAnswer(a) === norm);
}

function startFitb() {
  nav.view = "fitb";
  const ch = currentChapter();
  fitbQueue = ch.fitb.map((_, i) => i);
  fitbAwarded = new Set();
  nextFitbQuestion();
}

function nextFitbQuestion() {
  if (fitbQueue.length === 0) {
    afterFitb();
    return;
  }
  const fIndex = fitbQueue.shift();
  currentFitb = fIndex;
  renderFitbQuestion(fIndex);
}

function renderFitbQuestion(fIndex) {
  const ch = currentChapter();
  const item = ch.fitb[fIndex];
  saveChapterProgress();
  app.innerHTML = "";

  const back = document.createElement("button");
  back.className = "back-btn";
  back.innerHTML = icon("x") + "Exit lesson";
  back.addEventListener("click", () => withTransition(() => goPath(nav.courseId)));
  app.appendChild(back);

  const progress = document.createElement("div");
  progress.innerHTML = progressTrackHtml(fitbAwarded.size, ch.fitb.length);
  app.appendChild(progress.firstChild);

  const label = document.createElement("div");
  label.className = "theory-label";
  label.textContent = "Fill in the blank";
  app.appendChild(label);

  const sentence = document.createElement("div");
  sentence.className = "fitb-sentence";
  const parts = item.text.split("___");
  const inputs = [];
  parts.forEach((part, i) => {
    sentence.appendChild(document.createTextNode(part));
    if (i < parts.length - 1) {
      const inp = document.createElement("input");
      inp.type = "text";
      inp.className = "fitb-input";
      inp.autocomplete = "off";
      inp.spellcheck = false;
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); checkBtn.click(); }
      });
      inputs.push(inp);
      sentence.appendChild(inp);
    }
  });
  app.appendChild(sentence);

  const bar = document.createElement("div");
  bar.className = "bottom-bar";
  const checkBtn = document.createElement("button");
  checkBtn.className = "btn-primary";
  checkBtn.textContent = "Check answer";
  checkBtn.addEventListener("click", () => {
    bar.remove(); // prevent re-clicking Check answer from duplicating the feedback below
    handleFitbSubmit(fIndex, inputs);
  });
  bar.appendChild(checkBtn);
  app.appendChild(bar);

  if (inputs[0]) inputs[0].focus();
}

function handleFitbSubmit(fIndex, inputs) {
  const ch = currentChapter();
  const item = ch.fitb[fIndex];
  const given = inputs.map(i => i.value);
  const results = item.answers.map((ans, i) => fitbAnswerMatches(given[i], ans));
  const allCorrect = results.every(Boolean);

  inputs.forEach((inp, i) => {
    inp.disabled = true;
    inp.classList.add(results[i] ? "correct" : "incorrect");
  });

  if (allCorrect) {
    fitbAwarded.add(fIndex);
    const cs = ensureCourseState(nav.courseId);
    const earnedKey = `${ch.id}:${fIndex}`;
    if (!cs.earnedFitb.includes(earnedKey)) {
      cs.earnedFitb.push(earnedKey);
      state.xp += XP_PER_FITB;
    }
    saveState();
  } else {
    const cs = ensureCourseState(nav.courseId);
    const key = `${ch.id}:fitb:${fIndex}`;
    cs.weakSpots[key] = (cs.weakSpots[key] || 0) + 1;
    saveState();
    fitbQueue.push(fIndex);
  }

  const correctAnswers = item.answers.map(a => Array.isArray(a) ? a[0] : a).join(", ");
  const fb = document.createElement("div");
  fb.className = "feedback-box " + (allCorrect ? "correct" : "incorrect");
  fb.innerHTML = `<div class="fb-title">${allCorrect ? "Correct!" : "Not quite"}</div>` +
    `Answer: ${escapeHtml(correctAnswers)}` +
    (item.explanation ? `<br>${escapeHtml(item.explanation)}` : "");
  app.appendChild(fb);

  const bar = document.createElement("div");
  bar.className = "bottom-bar";
  const btn = document.createElement("button");
  btn.className = "btn-primary";
  btn.textContent = "Continue";
  btn.addEventListener("click", () => withTransition(nextFitbQuestion));
  bar.appendChild(btn);
  app.appendChild(bar);
}

// ---------------- theory practice ----------------

function startTheory() {
  nav.view = "theory";
  const ch = currentChapter();
  theoryQueue = ch.theory.map((_, i) => i);
  theoryAwarded = new Set();
  nextTheoryQuestion();
}

function nextTheoryQuestion() {
  if (theoryQueue.length === 0) {
    finishChapter();
    return;
  }
  const tIndex = theoryQueue.shift();
  currentTheory = tIndex;
  renderTheoryQuestion(tIndex, false);
}

function renderTheoryQuestion(tIndex, revealed, draftAnswer = "") {
  const ch = currentChapter();
  const t = ch.theory[tIndex];
  saveChapterProgress();
  app.innerHTML = "";

  const back = document.createElement("button");
  back.className = "back-btn";
  back.innerHTML = icon("x") + "Exit lesson";
  back.addEventListener("click", () => withTransition(() => goPath(nav.courseId)));
  app.appendChild(back);

  const progress = document.createElement("div");
  progress.innerHTML = progressTrackHtml(theoryAwarded.size, ch.theory.length);
  app.appendChild(progress.firstChild);

  const label = document.createElement("div");
  label.className = "theory-label";
  label.textContent = "Theory practice — write your answer first";
  app.appendChild(label);

  const qEl = document.createElement("div");
  qEl.className = "quiz-question";
  qEl.textContent = t.question;
  app.appendChild(qEl);

  const bar = document.createElement("div");
  bar.className = "bottom-bar";

  if (!revealed) {
    const draftBox = document.createElement("textarea");
    draftBox.className = "theory-draft";
    draftBox.placeholder = "Type your answer here — actually write it out, don't just think it. This is what makes it stick.";
    draftBox.value = draftAnswer;
    app.appendChild(draftBox);

    const revealBtn = document.createElement("button");
    revealBtn.className = "btn-primary";
    revealBtn.textContent = "Reveal model answer";
    revealBtn.addEventListener("click", () => withTransition(() => renderTheoryQuestion(tIndex, true, draftBox.value)));
    bar.appendChild(revealBtn);
    app.appendChild(bar);
    return;
  }

  if (draftAnswer.trim()) {
    const yourBox = document.createElement("div");
    yourBox.className = "feedback-box your-answer";
    yourBox.innerHTML = `<div class="fb-title">Your answer</div>${escapeHtml(draftAnswer)}`;
    app.appendChild(yourBox);
  }

  const answerBox = document.createElement("div");
  answerBox.className = "feedback-box theory-answer";
  let html = `<div class="fb-title">Model answer</div>${escapeHtml(t.modelAnswer)}`;
  if (t.keyPoints && t.keyPoints.length) {
    html += `<ul class="key-points">${t.keyPoints.map(k => `<li>${escapeHtml(k)}</li>`).join("")}</ul>`;
  }
  answerBox.innerHTML = html;
  app.appendChild(answerBox);

  const rateRow = document.createElement("div");
  rateRow.className = "bottom-bar";
  rateRow.style.justifyContent = "space-between";

  const needReviewBtn = document.createElement("button");
  needReviewBtn.className = "btn-secondary";
  needReviewBtn.textContent = "Need review";
  needReviewBtn.addEventListener("click", () => withTransition(() => handleTheoryRate(tIndex, false)));
  rateRow.appendChild(needReviewBtn);

  const gotItBtn = document.createElement("button");
  gotItBtn.className = "btn-primary";
  gotItBtn.textContent = "Got it";
  gotItBtn.addEventListener("click", () => withTransition(() => handleTheoryRate(tIndex, true)));
  rateRow.appendChild(gotItBtn);

  app.appendChild(rateRow);
}

function handleTheoryRate(tIndex, gotIt) {
  const ch = currentChapter();
  const cs = ensureCourseState(nav.courseId);
  if (gotIt) {
    theoryAwarded.add(tIndex);
    const earnedKey = `${ch.id}:${tIndex}`;
    if (!cs.earnedTheory.includes(earnedKey)) {
      cs.earnedTheory.push(earnedKey);
      state.xp += XP_PER_THEORY;
    }
    saveState();
  } else {
    const key = `${ch.id}:theory:${tIndex}`;
    cs.weakSpots[key] = (cs.weakSpots[key] || 0) + 1;
    saveState();
    theoryQueue.push(tIndex);
  }
  nextTheoryQuestion();
}

// ---------------- completion ----------------

function confettiHtml() {
  const colors = ["#58cc02", "#1cb0f6", "#ffc800", "#ff4b4b", "#ce82ff"];
  let html = '<div class="confetti-container">';
  for (let i = 0; i < 28; i++) {
    const left = Math.random() * 100;
    const delay = Math.random() * 0.4;
    const duration = 1.4 + Math.random() * 0.9;
    const color = colors[i % colors.length];
    const drift = (Math.random() * 80 - 40).toFixed(0);
    html += `<span class="confetti-piece" style="left:${left}%; background:${color}; animation-delay:${delay}s; animation-duration:${duration}s; --drift:${drift}px;"></span>`;
  }
  html += "</div>";
  return html;
}

function finishChapter() {
  clearChapterProgress(nav.chapterId);
  clearLastActive();
  const cs = ensureCourseState(nav.courseId);
  const ch = currentChapter();
  if (!cs.completed.includes(ch.id)) {
    cs.completed.push(ch.id);
    state.xp += XP_CHAPTER_BONUS;
  }
  touchStreakAndSave();

  app.innerHTML = "";
  const done = document.createElement("div");
  done.className = "complete-screen";
  done.innerHTML = `
    ${confettiHtml()}
    <div class="complete-badge">${icon("checkCircle")}</div>
    <h1>Chapter complete!</h1>
    <p>${escapeHtml(ch.title)}</p>
    <div class="xp-earned">+${XP_CHAPTER_BONUS} XP chapter bonus</div>
  `;
  app.appendChild(done);

  const bar = document.createElement("div");
  bar.className = "bottom-bar";
  bar.style.justifyContent = "center";
  const btn = document.createElement("button");
  btn.className = "btn-primary";
  btn.textContent = "Back to path";
  btn.addEventListener("click", () => withTransition(() => goPath(nav.courseId)));
  bar.appendChild(btn);
  app.appendChild(done);
  app.appendChild(bar);
}

// ---------------- utils ----------------

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML.replace(/\n/g, "<br>");
}

// ---------------- boot ----------------

(async function init() {
  renderStats();
  try {
    await loadCourses();
    const lastActive = loadLastActive();
    if (!lastActive || !resumeChapterProgress(lastActive.courseId, lastActive.chapterId)) {
      history.replaceState({ view: "home" }, "");
      renderHome();
    }
  } catch (e) {
    console.error("Failed to load course data:", e);
    renderLoadError();
  }
})();
