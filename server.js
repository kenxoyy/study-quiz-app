import "dotenv/config";
import express from "express";
import multer from "multer";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { extractDocumentText } from "./services/documentParser.js";
import { generateQuizFromDocument, generateQuizFromTopic } from "./services/quizGenerator.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = Number(process.env.PORT || 3000);

const MAX_FILE_MB = Math.max(1, Math.min(25, Number(process.env.MAX_FILE_MB || 10)));
const MAX_DOCUMENT_WORDS = Math.max(1000, Number(process.env.MAX_DOCUMENT_WORDS || 12000));
const MAX_DOCUMENT_CHARS = Math.max(10000, Number(process.env.MAX_DOCUMENT_CHARS || 90000));
const MAX_CONCURRENT_GENERATIONS = Math.max(1, Number(process.env.MAX_CONCURRENT_GENERATIONS || 1));
const GENERATION_LIMIT = Math.max(1, Number(process.env.GENERATION_LIMIT || 4));
const GENERATION_WINDOW_MINUTES = Math.max(5, Number(process.env.GENERATION_WINDOW_MINUTES || 60));
const GLOBAL_GENERATION_COOLDOWN_SECONDS = Math.max(0, Number(process.env.GLOBAL_GENERATION_COOLDOWN_SECONDS || 45));
const CACHE_TTL_HOURS = Math.max(1, Number(process.env.QUIZ_CACHE_HOURS || 12));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024 }
});

app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const sessions = new Map();
const quizCache = new Map();
const generationHistory = new Map();
const SESSION_TTL = 2 * 60 * 60 * 1000;
const CACHE_TTL = CACHE_TTL_HOURS * 60 * 60 * 1000;
const GENERATION_WINDOW_MS = GENERATION_WINDOW_MINUTES * 60 * 1000;
let activeGenerations = 0;
let lastGenerationStartedAt = 0;

function shuffle(array) {
  const out = [...array];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function sanitizeQuestion(question) {
  return {
    id: question.id,
    topicId: question.topicId,
    question: question.question,
    choices: question.choices.map((choice) => ({ id: choice.id, text: choice.text }))
  };
}

function buildAttempt(fullQuiz) {
  const questions = shuffle(fullQuiz.questions).map((question) => ({
    ...question,
    choices: shuffle(question.choices)
  }));
  return {
    attemptId: crypto.randomUUID(),
    questions
  };
}

function publicQuizPayload(session) {
  return {
    sessionId: session.id,
    attemptId: session.attempt.attemptId,
    title: session.quiz.title,
    summary: session.quiz.summary,
    topics: session.quiz.topics.map((topic) => ({ id: topic.id, name: topic.name })),
    questionCount: session.attempt.questions.length,
    questions: session.attempt.questions.map(sanitizeQuestion),
    diagnostics: session.quiz.diagnostics
  };
}

function createSession(sourceName, quiz) {
  const session = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    sourceName,
    quiz,
    attempt: buildAttempt(quiz)
  };
  sessions.set(session.id, session);
  return session;
}

function getSession(id) {
  const session = sessions.get(id);
  if (!session) return null;
  if (Date.now() - session.createdAt > SESSION_TTL) {
    sessions.delete(id);
    return null;
  }
  return session;
}

function cacheKey(prefix, value) {
  return crypto.createHash("sha256").update(`${prefix}:optimized-v2:${value}`).digest("hex");
}

function readCache(key) {
  const item = quizCache.get(key);
  if (!item) return null;
  if (Date.now() - item.createdAt > CACHE_TTL) {
    quizCache.delete(key);
    return null;
  }
  const quiz = structuredClone(item.quiz);
  quiz.diagnostics = { ...(quiz.diagnostics || {}), cached: true };
  return quiz;
}

function writeCache(key, quiz) {
  const copy = structuredClone(quiz);
  copy.diagnostics = { ...(copy.diagnostics || {}), cached: false };
  quizCache.set(key, { createdAt: Date.now(), quiz: copy });
}

function clientKey(req) {
  return req.ip || req.socket?.remoteAddress || "unknown";
}

function canStartGeneration(req) {
  const now = Date.now();

  if (activeGenerations >= MAX_CONCURRENT_GENERATIONS) {
    return {
      ok: false,
      status: 429,
      message: "Another quiz is being generated right now. Please wait a moment and try again."
    };
  }

  if (GLOBAL_GENERATION_COOLDOWN_SECONDS > 0 && lastGenerationStartedAt) {
    const cooldownMs = GLOBAL_GENERATION_COOLDOWN_SECONDS * 1000;
    const elapsed = now - lastGenerationStartedAt;
    if (elapsed < cooldownMs) {
      const waitSeconds = Math.max(1, Math.ceil((cooldownMs - elapsed) / 1000));
      return {
        ok: false,
        status: 429,
        message: `The quiz generator is cooling down to protect the API limit. Please try again in about ${waitSeconds} second${waitSeconds === 1 ? "" : "s"}. Existing quizzes can still be retaken.`
      };
    }
  }

  const key = clientKey(req);
  const recent = (generationHistory.get(key) || []).filter((time) => now - time < GENERATION_WINDOW_MS);
  generationHistory.set(key, recent);

  if (recent.length >= GENERATION_LIMIT) {
    const waitMs = GENERATION_WINDOW_MS - (now - recent[0]);
    const waitMinutes = Math.max(1, Math.ceil(waitMs / 60000));
    return {
      ok: false,
      status: 429,
      message: `Generation limit reached for this device/network. Please try again in about ${waitMinutes} minute${waitMinutes === 1 ? "" : "s"}. Existing quizzes can still be retaken without using AI.`
    };
  }

  recent.push(now);
  generationHistory.set(key, recent);
  activeGenerations += 1;
  lastGenerationStartedAt = now;
  return { ok: true };
}

function finishGeneration() {
  activeGenerations = Math.max(0, activeGenerations - 1);
}

function friendlyGenerationError(error) {
  const message = String(error?.message || "");
  const status = Number(error?.status || 0);

  if (status === 429 || /rate limit|too many requests|429/i.test(message)) {
    const retryMatch = message.match(/try again in\s+([^\.]+(?:\.[0-9]+s)?)/i);
    const retry = retryMatch?.[1]?.trim();
    return {
      status: 429,
      message: retry
        ? `OpenAI's generation rate limit has been reached. Please try again in ${retry}. Retakes of an existing quiz do not use additional AI generation.`
        : "OpenAI's generation rate limit has been reached. Please wait and try again later. Retakes of an existing quiz do not use additional AI generation."
    };
  }

  if (status === 401 || /missing credentials|invalid api key|incorrect api key/i.test(message)) {
    return {
      status: 503,
      message: "The site's OpenAI API key is missing or invalid. Update OPENAI_API_KEY in the Render environment settings."
    };
  }

  if (/insufficient_quota|billing|credits/i.test(message)) {
    return {
      status: 503,
      message: "The OpenAI API account does not currently have available usage. Check the API billing/usage settings and try again."
    };
  }

  return {
    status: 500,
    message: error?.message || "Could not generate the quiz."
  };
}

setInterval(() => {
  const now = Date.now();

  for (const [id, session] of sessions.entries()) {
    if (now - session.createdAt > SESSION_TTL) sessions.delete(id);
  }

  for (const [key, item] of quizCache.entries()) {
    if (now - item.createdAt > CACHE_TTL) quizCache.delete(key);
  }

  for (const [key, times] of generationHistory.entries()) {
    const recent = times.filter((time) => now - time < GENERATION_WINDOW_MS);
    if (recent.length) generationHistory.set(key, recent);
    else generationHistory.delete(key);
  }
}, 15 * 60 * 1000).unref();

app.post("/api/quiz/from-file", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Please choose a file." });

    const parsed = await extractDocumentText(req.file);

    if (parsed.wordCount > MAX_DOCUMENT_WORDS || parsed.text.length > MAX_DOCUMENT_CHARS) {
      return res.status(413).json({
        error: `This file is too long for one thorough quiz generation. The current limit is ${MAX_DOCUMENT_WORDS.toLocaleString()} words. Please split the material into smaller files so no section is silently skipped.`
      });
    }

    const key = cacheKey("document", parsed.text);
    const cachedQuiz = readCache(key);
    if (cachedQuiz) {
      const session = createSession(req.file.originalname, cachedQuiz);
      return res.json(publicQuizPayload(session));
    }

    const gate = canStartGeneration(req);
    if (!gate.ok) return res.status(gate.status).json({ error: gate.message });

    try {
      const quiz = await generateQuizFromDocument({
        text: parsed.text,
        wordCount: parsed.wordCount,
        sourceName: req.file.originalname
      });
      quiz.diagnostics = { ...(quiz.diagnostics || {}), cached: false };
      writeCache(key, quiz);
      const session = createSession(req.file.originalname, quiz);
      return res.json(publicQuizPayload(session));
    } catch (error) {
      console.error("Quiz generation error:", error);
      const friendly = friendlyGenerationError(error);
      return res.status(friendly.status).json({ error: friendly.message });
    } finally {
      finishGeneration();
    }
  } catch (error) {
    console.error("File processing error:", error);
    return res.status(500).json({ error: error.message || "Could not process the uploaded file." });
  }
});

app.post("/api/quiz/from-topic", async (req, res) => {
  const topic = String(req.body?.topic || "").trim();
  if (topic.length < 3) return res.status(400).json({ error: "Enter a study topic." });
  if (topic.length > 500) return res.status(400).json({ error: "Keep the topic description under 500 characters." });

  const key = cacheKey("topic", topic.toLowerCase());
  const cachedQuiz = readCache(key);
  if (cachedQuiz) {
    const session = createSession(topic, cachedQuiz);
    return res.json(publicQuizPayload(session));
  }

  const gate = canStartGeneration(req);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.message });

  try {
    const quiz = await generateQuizFromTopic(topic);
    quiz.diagnostics = { ...(quiz.diagnostics || {}), cached: false };
    writeCache(key, quiz);
    const session = createSession(topic, quiz);
    return res.json(publicQuizPayload(session));
  } catch (error) {
    console.error("Topic generation error:", error);
    const friendly = friendlyGenerationError(error);
    return res.status(friendly.status).json({ error: friendly.message });
  } finally {
    finishGeneration();
  }
});

app.post("/api/quiz/:sessionId/submit", (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Quiz session expired. Generate the quiz again." });
  if (req.body?.attemptId !== session.attempt.attemptId) {
    return res.status(409).json({ error: "This quiz attempt is no longer active." });
  }

  const answers = req.body?.answers || {};
  const questions = session.attempt.questions;
  const unanswered = questions.filter((question) => !answers[question.id]);
  if (unanswered.length) {
    return res.status(400).json({ error: `Answer all questions before submitting. ${unanswered.length} unanswered.` });
  }

  let correct = 0;
  const review = questions.map((question, index) => {
    const selectedChoiceId = answers[question.id];
    const isCorrect = selectedChoiceId === question.correctChoiceId;
    if (isCorrect) correct += 1;
    return {
      number: index + 1,
      id: question.id,
      topicId: question.topicId,
      question: question.question,
      choices: question.choices,
      selectedChoiceId,
      correctChoiceId: question.correctChoiceId,
      isCorrect,
      explanation: question.explanation,
      sourceNote: question.sourceNote
    };
  });

  const total = questions.length;
  return res.json({
    score: correct,
    total,
    percent: total ? Math.round((correct / total) * 100) : 0,
    review
  });
});

app.post("/api/quiz/:sessionId/retake", (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Quiz session expired. Generate the quiz again." });
  session.attempt = buildAttempt(session.quiz);
  return res.json(publicQuizPayload(session));
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    optimized: true,
    maxFileMB: MAX_FILE_MB,
    maxDocumentWords: MAX_DOCUMENT_WORDS,
    maxQuestions: Number(process.env.MAX_QUESTIONS || 30)
  });
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: `File is too large. Maximum upload size is ${MAX_FILE_MB} MB.` });
  }
  console.error("Unexpected server error:", error);
  return res.status(500).json({ error: "Unexpected server error." });
});

app.listen(port, () => {
  console.log(`Study Quiz is running at http://localhost:${port}`);
  console.log(`Optimized mode: max ${MAX_DOCUMENT_WORDS.toLocaleString()} words, max ${MAX_FILE_MB} MB, cache ${CACHE_TTL_HOURS}h.`);
});
