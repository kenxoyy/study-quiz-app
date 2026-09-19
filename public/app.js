const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const MAX_LOCAL_FILE_BYTES = 10 * 1024 * 1024;

const state = {
  quiz: null,
  answers: {},
  result: null,
  filter: "all",
  submitting: false,
  cooldownUntil: 0,
  cooldownTimer: null
};

const COOLDOWN_STORAGE_KEY = "studyquiz-generation-cooldown-until";

const views = {
  setup: $("#setupView"),
  quiz: $("#quizView"),
  result: $("#resultView")
};

function showView(name) {
  Object.entries(views).forEach(([key, el]) => el.classList.toggle("hidden", key !== name));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function showError(selector, message = "") {
  const el = $(selector);
  el.textContent = message;
  el.classList.toggle("hidden", !message);
}

function generationIsCoolingDown() {
  return state.cooldownUntil > Date.now();
}

function refreshGenerationButtons(loading = false) {
  const disabled = loading || generationIsCoolingDown();
  $$("#fileForm button[type='submit'], #topicForm button[type='submit']").forEach((button) => {
    button.disabled = disabled;
  });
}

function setLoading(on, title, text) {
  const box = $("#loadingBox");
  box.classList.toggle("hidden", !on);
  if (title) $("#loadingTitle").textContent = title;
  if (text) $("#loadingText").textContent = text;
  refreshGenerationButtons(on);
}

function formatRemaining(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatRetryTime(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return new Intl.DateTimeFormat(undefined, {
    ...(sameDay ? {} : { month: "short", day: "numeric" }),
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function clearCooldown() {
  state.cooldownUntil = 0;
  localStorage.removeItem(COOLDOWN_STORAGE_KEY);
  $("#cooldownBox").classList.add("hidden");
  if (state.cooldownTimer) clearInterval(state.cooldownTimer);
  state.cooldownTimer = null;
  refreshGenerationButtons(false);
}

function renderCooldown() {
  if (!generationIsCoolingDown()) {
    clearCooldown();
    return;
  }

  const remaining = state.cooldownUntil - Date.now();
  $("#cooldownBox").classList.remove("hidden");
  $("#cooldownTitle").textContent = "Quiz generation temporarily unavailable";
  $("#cooldownText").textContent = `Try again at ${formatRetryTime(state.cooldownUntil)} (in ${formatRemaining(remaining)}). The Create Quiz buttons are disabled until then. Existing quizzes can still be retaken without new AI generation.`;
  refreshGenerationButtons(false);
}

function startCooldown(retryAt, retryAfterSeconds) {
  let until = retryAt ? Date.parse(retryAt) : NaN;
  if (!Number.isFinite(until) && Number(retryAfterSeconds) > 0) {
    until = Date.now() + Number(retryAfterSeconds) * 1000;
  }
  if (!Number.isFinite(until) || until <= Date.now()) return;

  state.cooldownUntil = until;
  localStorage.setItem(COOLDOWN_STORAGE_KEY, String(until));
  if (state.cooldownTimer) clearInterval(state.cooldownTimer);
  renderCooldown();
  state.cooldownTimer = setInterval(renderCooldown, 1000);
}

class RequestError extends Error {
  constructor(message, data, status) {
    super(message);
    this.name = "RequestError";
    this.data = data || {};
    this.status = status;
  }
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  let data;
  try { data = await response.json(); } catch { data = {}; }
  if (!response.ok) throw new RequestError(data.error || "Something went wrong.", data, response.status);
  return data;
}

function handleGenerationError(error) {
  if (error?.status === 429) {
    startCooldown(error.data?.retryAt, error.data?.retryAfterSeconds);
    return showError("#setupError", "Generation is paused until the retry time shown below.");
  }
  showError("#setupError", error.message);
}

function switchMode(mode) {
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.mode === mode));
  $("#fileForm").classList.toggle("hidden", mode !== "file");
  $("#topicForm").classList.toggle("hidden", mode !== "topic");
  showError("#setupError");
}

$$(".tab").forEach((tab) => tab.addEventListener("click", () => switchMode(tab.dataset.mode)));

$("#fileInput").addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  $("#fileLabel").textContent = file ? file.name : "Choose a study file";
});

$("#fileForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  showError("#setupError");
  if (generationIsCoolingDown()) {
    renderCooldown();
    return showError("#setupError", "Quiz generation is temporarily unavailable. Please wait until the cooldown ends.");
  }
  const file = $("#fileInput").files?.[0];
  if (!file) return showError("#setupError", "Please choose a study file first.");
  if (file.size > MAX_LOCAL_FILE_BYTES) {
    return showError("#setupError", "This file is larger than 10 MB. Please use a smaller study file.");
  }

  const form = new FormData();
  form.append("file", file);
  setLoading(true, "Reading the complete file…", "Optimized mode reads the accepted material once to build a full coverage map, then creates the quiz from that compact map.");
  try {
    const quiz = await requestJson("/api/quiz/from-file", { method: "POST", body: form });
    loadQuiz(quiz);
  } catch (error) {
    handleGenerationError(error);
  } finally {
    setLoading(false);
  }
});

$("#topicForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  showError("#setupError");
  if (generationIsCoolingDown()) {
    renderCooldown();
    return showError("#setupError", "Quiz generation is temporarily unavailable. Please wait until the cooldown ends.");
  }
  const topic = $("#topicInput").value.trim();
  if (topic.length < 3) return showError("#setupError", "Enter a study topic first.");

  setLoading(true, "Building the topic map…", "The app is breaking the subject into its major areas before generating the quiz.");
  try {
    const quiz = await requestJson("/api/quiz/from-topic", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic })
    });
    loadQuiz(quiz);
  } catch (error) {
    handleGenerationError(error);
  } finally {
    setLoading(false);
  }
});

function topicName(topicId) {
  return state.quiz?.topics?.find((t) => t.id === topicId)?.name || "Review";
}

function loadQuiz(quiz) {
  state.quiz = quiz;
  state.answers = {};
  state.result = null;
  state.submitting = false;
  $("#quizTitle").textContent = quiz.title;
  $("#quizSummary").textContent = quiz.summary || "Answer all questions, then submit to check your work.";
  $("#questionCount").textContent = `${quiz.questionCount} questions`;
  const diagnostics = quiz.diagnostics || {};
  if (diagnostics.wordsRead) {
    $("#readStats").textContent = `${diagnostics.wordsRead.toLocaleString()} words read · optimized 2-pass generation${diagnostics.cached ? " · cached" : ""}`;
  } else {
    $("#readStats").textContent = `Optimized generation${diagnostics.cached ? " · cached" : ""}`;
  }
  renderQuestions();
  updateAnswerStatus();
  showView("quiz");
}

function renderQuestions() {
  const form = $("#quizForm");
  const nav = $("#questionNav");
  form.innerHTML = "";
  nav.innerHTML = "";

  state.quiz.questions.forEach((q, index) => {
    const card = document.createElement("article");
    card.className = "question-card";
    card.id = `question-${q.id}`;

    const top = document.createElement("div");
    top.className = "q-top";
    top.innerHTML = `<span class="q-number">Question ${index + 1}</span><span>${escapeHtml(topicName(q.topicId))}</span>`;

    const h2 = document.createElement("h2");
    h2.textContent = q.question;

    const choices = document.createElement("div");
    choices.className = "choices";
    q.choices.forEach((choice) => {
      const label = document.createElement("label");
      label.className = "choice";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = `q-${q.id}`;
      input.value = choice.id;
      input.checked = state.answers[q.id] === choice.id;
      input.addEventListener("change", () => {
        state.answers[q.id] = choice.id;
        updateAnswerStatus();
      });
      const text = document.createElement("span");
      text.textContent = choice.text;
      label.append(input, text);
      choices.append(label);
    });

    card.append(top, h2, choices);
    form.append(card);

    const navBtn = document.createElement("button");
    navBtn.type = "button";
    navBtn.textContent = String(index + 1);
    navBtn.dataset.questionId = q.id;
    navBtn.addEventListener("click", () => card.scrollIntoView({ behavior: "smooth", block: "start" }));
    nav.append(navBtn);
  });
}

function updateAnswerStatus() {
  if (!state.quiz) return;
  const total = state.quiz.questions.length;
  const answered = state.quiz.questions.filter((q) => state.answers[q.id]).length;
  const remaining = total - answered;
  $("#answerStatus").textContent = `${answered} of ${total} answered`;
  $("#submitStatus").textContent = remaining === 0 ? "All questions answered." : `${remaining} question${remaining === 1 ? "" : "s"} left.`;
  $("#submitQuiz").disabled = remaining !== 0;
  $$("#questionNav button").forEach((btn) => {
    btn.classList.toggle("answered", Boolean(state.answers[btn.dataset.questionId]));
  });
}

async function submitCurrentQuiz({ autoSubmitted = false } = {}) {
  if (!state.quiz || state.result || state.submitting) return;
  state.submitting = true;
  showError("#quizError");
  $("#submitQuiz").disabled = true;
  $("#submitQuiz").textContent = autoSubmitted ? "Auto-submitting…" : "Checking…";

  try {
    const result = await requestJson(`/api/quiz/${state.quiz.sessionId}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        attemptId: state.quiz.attemptId,
        answers: state.answers,
        autoSubmitted
      }),
      keepalive: autoSubmitted
    });
    state.result = result;
    state.filter = "all";
    renderResult();
    showView("result");
  } catch (error) {
    state.submitting = false;
    showError("#quizError", error.message);
    updateAnswerStatus();
  } finally {
    if (!state.result) state.submitting = false;
    $("#submitQuiz").textContent = "Submit answers";
  }
}

$("#submitQuiz").addEventListener("click", () => submitCurrentQuiz());

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "hidden") return;
  const quizIsActive = state.quiz && !state.result && !views.quiz.classList.contains("hidden");
  if (quizIsActive) submitCurrentQuiz({ autoSubmitted: true });
});

function renderResult() {
  const r = state.result;
  $("#scoreText").textContent = `${r.score}/${r.total} · ${r.percent}%`;
  const incorrect = r.total - r.score;
  if (r.autoSubmitted) {
    const unansweredText = r.unanswered
      ? ` ${r.unanswered} unanswered question${r.unanswered === 1 ? " was" : "s were"} counted as incorrect.`
      : "";
    $("#scoreSubtext").textContent = `This attempt was submitted automatically because the quiz tab was left or hidden.${unansweredText} Review the answers below or retake with a shuffled order.`;
  } else {
    $("#scoreSubtext").textContent = incorrect === 0
      ? "Perfect score. You can still retake to practice with a shuffled order."
      : `${incorrect} question${incorrect === 1 ? "" : "s"} to review. Correct answers and explanations are shown below.`;
  }
  $$(".filter").forEach((b) => b.classList.toggle("active", b.dataset.filter === state.filter));
  renderReviewList();
}

function renderReviewList() {
  const list = $("#reviewList");
  list.innerHTML = "";
  const items = state.result.review.filter((item) => {
    if (state.filter === "correct") return item.isCorrect;
    if (state.filter === "incorrect") return !item.isCorrect;
    return true;
  });

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "panel";
    empty.style.padding = "20px";
    empty.textContent = "No questions in this filter.";
    list.append(empty);
    return;
  }

  items.forEach((item) => {
    const card = document.createElement("article");
    card.className = `review-card ${item.isCorrect ? "correct" : "incorrect"}`;
    const label = document.createElement("div");
    label.className = "review-result";
    label.textContent = `Question ${item.number} · ${item.isCorrect ? "Correct" : "Incorrect"}`;
    const h2 = document.createElement("h2");
    h2.textContent = item.question;
    card.append(label, h2);

    if (!item.selectedChoiceId) {
      const unanswered = document.createElement("div");
      unanswered.className = "unanswered-note";
      unanswered.textContent = "No answer was selected — counted as incorrect.";
      card.append(unanswered);
    }

    item.choices.forEach((choice) => {
      const row = document.createElement("div");
      const isCorrectAnswer = choice.id === item.correctChoiceId;
      const isSelected = choice.id === item.selectedChoiceId;
      row.className = "review-choice";
      if (isCorrectAnswer) row.classList.add("correct-answer");
      if (isSelected && !isCorrectAnswer) row.classList.add("wrong-selected");
      const prefix = isCorrectAnswer ? "✓" : isSelected ? "✕" : "•";
      row.textContent = `${prefix} ${choice.text}${isSelected ? " — your answer" : ""}${isCorrectAnswer ? " — correct answer" : ""}`;
      card.append(row);
    });

    const explanation = document.createElement("div");
    explanation.className = "explanation";
    explanation.innerHTML = `<strong>Explanation:</strong> ${escapeHtml(item.explanation || "Review the related concept in your material.")}`;
    card.append(explanation);

    if (item.sourceNote) {
      const source = document.createElement("div");
      source.className = "source-note";
      source.textContent = `Study point: ${item.sourceNote}`;
      card.append(source);
    }
    list.append(card);
  });
}

$$(".filter").forEach((button) => {
  button.addEventListener("click", () => {
    state.filter = button.dataset.filter;
    $$(".filter").forEach((b) => b.classList.toggle("active", b === button));
    renderReviewList();
  });
});

$("#retakeBtn").addEventListener("click", async () => {
  if (!state.quiz) return;
  showError("#resultError");
  $("#retakeBtn").disabled = true;
  $("#retakeBtn").textContent = "Shuffling…";
  try {
    const quiz = await requestJson(`/api/quiz/${state.quiz.sessionId}/retake`, { method: "POST" });
    loadQuiz(quiz);
  } catch (error) {
    showError("#resultError", error.message);
  } finally {
    $("#retakeBtn").disabled = false;
    $("#retakeBtn").textContent = "Retake with shuffled order";
  }
});

$("#homeLink").addEventListener("click", (event) => {
  event.preventDefault();
  state.quiz = null;
  state.answers = {};
  state.result = null;
  state.submitting = false;
  showView("setup");
});


function restoreCooldown() {
  const saved = Number(localStorage.getItem(COOLDOWN_STORAGE_KEY) || 0);
  if (saved > Date.now()) {
    state.cooldownUntil = saved;
    renderCooldown();
    state.cooldownTimer = setInterval(renderCooldown, 1000);
  } else {
    localStorage.removeItem(COOLDOWN_STORAGE_KEY);
    refreshGenerationButtons(false);
  }
}

restoreCooldown();

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
