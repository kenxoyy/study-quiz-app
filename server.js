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
const port = process.env.PORT || 3000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const sessions = new Map();
const SESSION_TTL = 2 * 60 * 60 * 1000;

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
    choices: question.choices.map((c) => ({ id: c.id, text: c.text }))
  };
}

function buildAttempt(fullQuiz) {
  const questions = shuffle(fullQuiz.questions).map((q) => ({
    ...q,
    choices: shuffle(q.choices)
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
    topics: session.quiz.topics.map((t) => ({ id: t.id, name: t.name })),
    questionCount: session.attempt.questions.length,
    questions: session.attempt.questions.map(sanitizeQuestion),
    diagnostics: session.quiz.diagnostics
  };
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

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - session.createdAt > SESSION_TTL) sessions.delete(id);
  }
}, 15 * 60 * 1000).unref();

app.post("/api/quiz/from-file", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Please choose a file." });
    const parsed = await extractDocumentText(req.file);
    const quiz = await generateQuizFromDocument({
      text: parsed.text,
      wordCount: parsed.wordCount,
      sourceName: req.file.originalname
    });
    const session = {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      sourceName: req.file.originalname,
      quiz,
      attempt: buildAttempt(quiz)
    };
    sessions.set(session.id, session);
    res.json(publicQuizPayload(session));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || "Could not generate the quiz." });
  }
});

app.post("/api/quiz/from-topic", async (req, res) => {
  try {
    const topic = String(req.body?.topic || "").trim();
    if (topic.length < 3) return res.status(400).json({ error: "Enter a study topic." });
    const quiz = await generateQuizFromTopic(topic);
    const session = {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      sourceName: topic,
      quiz,
      attempt: buildAttempt(quiz)
    };
    sessions.set(session.id, session);
    res.json(publicQuizPayload(session));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || "Could not generate the quiz." });
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
  const unanswered = questions.filter((q) => !answers[q.id]);
  if (unanswered.length) {
    return res.status(400).json({ error: `Answer all questions before submitting. ${unanswered.length} unanswered.` });
  }

  let correct = 0;
  const review = questions.map((q, index) => {
    const selectedChoiceId = answers[q.id];
    const isCorrect = selectedChoiceId === q.correctChoiceId;
    if (isCorrect) correct += 1;
    return {
      number: index + 1,
      id: q.id,
      topicId: q.topicId,
      question: q.question,
      choices: q.choices,
      selectedChoiceId,
      correctChoiceId: q.correctChoiceId,
      isCorrect,
      explanation: q.explanation,
      sourceNote: q.sourceNote
    };
  });

  const total = questions.length;
  res.json({
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
  res.json(publicQuizPayload(session));
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "File is too large. Maximum size is 20 MB." });
  }
  console.error(error);
  res.status(500).json({ error: "Unexpected server error." });
});

app.listen(port, () => {
  console.log(`Study Quiz is running at http://localhost:${port}`);
});
