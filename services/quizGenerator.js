import OpenAI from "openai";
import crypto from "crypto";
import { chunkText } from "./documentParser.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || "gpt-5.6-luna";

function parseJsonLoose(text) {
  const cleaned = String(text || "")
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const firstObj = cleaned.indexOf("{");
    const lastObj = cleaned.lastIndexOf("}");
    if (firstObj >= 0 && lastObj > firstObj) {
      return JSON.parse(cleaned.slice(firstObj, lastObj + 1));
    }
    throw new Error("The AI returned an invalid response format. Please try again.");
  }
}

async function askJson(prompt) {
  const response = await client.responses.create({
    model: MODEL,
    input: prompt
  });
  return parseJsonLoose(response.output_text);
}

function uniq(items) {
  return [...new Set(items.map((x) => String(x || "").trim()).filter(Boolean))];
}

function normalizeAnalysis(raw, index) {
  return {
    chunk: index + 1,
    headings: uniq(raw.headings || []),
    topics: uniq(raw.topics || []),
    keyFacts: uniq(raw.keyFacts || []),
    terms: uniq(raw.terms || []),
    processes: uniq(raw.processes || []),
    relationships: uniq(raw.relationships || [])
  };
}

async function analyzeChunk(chunk, index, total) {
  const prompt = `
You are analyzing part ${index + 1} of ${total} of a study document.
Read EVERY part of the supplied text. Do not skip lists, definitions, examples, tables represented as text, steps, dates, formulas, names, comparisons, or exceptions.

Return ONLY valid JSON in this exact shape:
{
  "headings": ["..."],
  "topics": ["..."],
  "keyFacts": ["..."],
  "terms": ["term — concise meaning"],
  "processes": ["ordered process or sequence"],
  "relationships": ["cause/effect, comparison, association, distinction, or rule"]
}

Rules:
- Preserve important facts accurately.
- Be comprehensive but concise.
- Include enough information to write factual multiple-choice questions later.
- Do not invent information not present in the text.

DOCUMENT PART:
<<<
${chunk}
>>>
`;
  return normalizeAnalysis(await askJson(prompt), index);
}

function computeQuestionCount(wordCount, topicCount) {
  const byLength = Math.ceil(wordCount / 220);
  const byTopics = Math.max(0, topicCount * 2);
  return Math.max(10, Math.min(60, Math.max(byLength, byTopics)));
}

async function buildCoverageMap(analyses, wordCount, sourceName) {
  const compact = analyses.map((a) => ({
    chunk: a.chunk,
    headings: a.headings,
    topics: a.topics,
    keyFacts: a.keyFacts,
    terms: a.terms,
    processes: a.processes,
    relationships: a.relationships
  }));

  const prompt = `
You are creating a comprehensive study coverage map from an entire uploaded document named "${sourceName}".
The chunk analyses below collectively cover the full document.

Merge overlapping items, preserve distinct subtopics, and identify the teachable topics that a quiz must cover.
Return ONLY valid JSON:
{
  "title": "short study title",
  "summary": "2-4 sentence overview",
  "topics": [
    {
      "id": "T1",
      "name": "topic name",
      "importance": "high|medium|low",
      "studyPoints": ["specific point", "specific point"]
    }
  ]
}

Requirements:
- Cover ALL substantive topics found in the analyses.
- Do not merge unrelated topics just to shorten the list.
- Every study point must be supported by the analyses.
- Keep topic names clear and student-friendly.

FULL-DOCUMENT ANALYSES:
${JSON.stringify(compact)}
`;

  const map = await askJson(prompt);
  const topics = Array.isArray(map.topics) ? map.topics : [];
  const normalizedTopics = topics.map((t, i) => ({
    id: t.id || `T${i + 1}`,
    name: String(t.name || `Topic ${i + 1}`).trim(),
    importance: ["high", "medium", "low"].includes(t.importance) ? t.importance : "medium",
    studyPoints: uniq(t.studyPoints || [])
  })).filter((t) => t.studyPoints.length);

  return {
    title: String(map.title || sourceName).trim(),
    summary: String(map.summary || "").trim(),
    topics: normalizedTopics,
    questionCount: computeQuestionCount(wordCount, normalizedTopics.length)
  };
}

function allocateQuestions(topics, total) {
  if (!topics.length) return [];
  const weights = topics.map((t) => {
    const importanceWeight = t.importance === "high" ? 1.5 : t.importance === "low" ? 0.8 : 1;
    return Math.max(1, t.studyPoints.length) * importanceWeight;
  });
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const allocation = topics.map((t, i) => ({
    topicId: t.id,
    topicName: t.name,
    count: Math.max(1, Math.floor((weights[i] / weightSum) * total))
  }));

  let used = allocation.reduce((s, x) => s + x.count, 0);
  let cursor = 0;
  while (used < total) {
    allocation[cursor % allocation.length].count += 1;
    used += 1;
    cursor += 1;
  }
  while (used > total) {
    const candidates = allocation.filter((x) => x.count > 1);
    if (!candidates.length) break;
    candidates[cursor % candidates.length].count -= 1;
    used -= 1;
    cursor += 1;
  }
  return allocation;
}

function normalizeQuestion(q, fallbackTopicId, index) {
  const choices = Array.isArray(q.choices) ? q.choices.slice(0, 4) : [];
  if (choices.length !== 4) return null;

  const normalizedChoices = choices.map((c, i) => ({
    id: String(c.id || `C${i + 1}`),
    text: String(c.text || "").trim()
  }));
  if (normalizedChoices.some((c) => !c.text)) return null;

  const correctChoiceId = String(q.correctChoiceId || "");
  if (!normalizedChoices.some((c) => c.id === correctChoiceId)) return null;

  return {
    id: crypto.randomUUID(),
    topicId: String(q.topicId || fallbackTopicId),
    question: String(q.question || "").trim(),
    choices: normalizedChoices,
    correctChoiceId,
    explanation: String(q.explanation || "").trim(),
    sourceNote: String(q.sourceNote || "").trim(),
    orderSeed: index
  };
}

async function generateQuestionBatch(topic, count, globalContext) {
  const prompt = `
Create ${count} high-quality multiple-choice study questions for the topic below.
The questions are for a student studying the uploaded material, so they must be answerable ONLY from the supplied study points and context.

Return ONLY valid JSON:
{
  "questions": [
    {
      "topicId": "${topic.id}",
      "question": "clear question",
      "choices": [
        {"id":"A","text":"..."},
        {"id":"B","text":"..."},
        {"id":"C","text":"..."},
        {"id":"D","text":"..."}
      ],
      "correctChoiceId": "A",
      "explanation": "why the correct answer is correct, based on the material",
      "sourceNote": "short study point or concept being tested"
    }
  ]
}

Question-quality rules:
- Exactly 4 choices per question and exactly 1 correct answer.
- Avoid trick questions, "all of the above," and "none of the above."
- Distractors must be plausible but clearly wrong according to the material.
- Mix recall, comprehension, comparison, sequence, and simple application when supported by the material.
- Do not ask about information absent from the supplied material.
- Avoid duplicate questions or merely rewording the same fact.
- Spread questions across the study points rather than concentrating on one point.

TOPIC:
${JSON.stringify(topic)}

BROADER STUDY CONTEXT:
${globalContext}
`;

  const result = await askJson(prompt);
  return Array.isArray(result.questions) ? result.questions : [];
}

function dedupeQuestions(questions) {
  const seen = new Set();
  return questions.filter((q) => {
    const key = q.question.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function generateQuizFromDocument({ text, wordCount, sourceName }) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is missing. Add it to your .env file and restart the server.");
  }

  const chunks = chunkText(text, 14000);
  const analyses = [];
  // Sequential processing avoids rate-limit spikes and guarantees every chunk is examined.
  for (let i = 0; i < chunks.length; i += 1) {
    analyses.push(await analyzeChunk(chunks[i], i, chunks.length));
  }

  const coverage = await buildCoverageMap(analyses, wordCount, sourceName);
  if (!coverage.topics.length) throw new Error("No usable study topics could be identified in the document.");

  const allocation = allocateQuestions(coverage.topics, coverage.questionCount);
  const globalContext = JSON.stringify({
    title: coverage.title,
    summary: coverage.summary,
    topics: coverage.topics.map((t) => ({ id: t.id, name: t.name, studyPoints: t.studyPoints }))
  });

  let rawQuestions = [];
  for (const item of allocation) {
    const topic = coverage.topics.find((t) => t.id === item.topicId);
    const batch = await generateQuestionBatch(topic, item.count, globalContext);
    rawQuestions.push(...batch.map((q, i) => normalizeQuestion(q, topic.id, i)).filter(Boolean));
  }

  rawQuestions = dedupeQuestions(rawQuestions);

  // If formatting/deduplication reduced the count, add a small repair batch.
  if (rawQuestions.length < coverage.questionCount) {
    const missing = coverage.questionCount - rawQuestions.length;
    const repairTopic = {
      id: "MIXED",
      name: "Whole-document review",
      importance: "high",
      studyPoints: coverage.topics.flatMap((t) => t.studyPoints.map((p) => `${t.name}: ${p}`))
    };
    const repair = await generateQuestionBatch(repairTopic, missing, globalContext);
    rawQuestions.push(...repair.map((q, i) => normalizeQuestion(q, q.topicId || "MIXED", i)).filter(Boolean));
    rawQuestions = dedupeQuestions(rawQuestions).slice(0, coverage.questionCount);
  }

  return {
    title: coverage.title,
    summary: coverage.summary,
    topics: coverage.topics,
    questionCount: rawQuestions.length,
    questions: rawQuestions,
    diagnostics: {
      chunksRead: chunks.length,
      wordsRead: wordCount,
      model: MODEL
    }
  };
}

export async function generateQuizFromTopic(topicText) {
  const syntheticText = `Study topic requested by the user: ${topicText}`;
  const prompt = `
Create a comprehensive but concise study map for the topic: "${topicText}".
Return ONLY valid JSON:
{
  "title": "...",
  "summary": "2-4 sentences",
  "topics": [
    {"id":"T1","name":"...","importance":"high|medium|low","studyPoints":["..."]}
  ]
}

Use standard, widely accepted educational knowledge. Break the subject into its major subtopics so the quiz can cover it broadly.
`;
  const map = await askJson(prompt);
  const coverage = {
    title: map.title || topicText,
    summary: map.summary || "",
    topics: (map.topics || []).map((t, i) => ({
      id: t.id || `T${i + 1}`,
      name: t.name || `Topic ${i + 1}`,
      importance: t.importance || "medium",
      studyPoints: uniq(t.studyPoints || [])
    })).filter((t) => t.studyPoints.length)
  };
  const count = Math.max(10, Math.min(30, coverage.topics.length * 3 || 10));
  const allocation = allocateQuestions(coverage.topics, count);
  const context = JSON.stringify(coverage);
  let questions = [];
  for (const item of allocation) {
    const topic = coverage.topics.find((t) => t.id === item.topicId);
    const batch = await generateQuestionBatch(topic, item.count, context);
    questions.push(...batch.map((q, i) => normalizeQuestion(q, topic.id, i)).filter(Boolean));
  }
  questions = dedupeQuestions(questions).slice(0, count);
  return {
    ...coverage,
    questionCount: questions.length,
    questions,
    diagnostics: { chunksRead: 1, wordsRead: syntheticText.split(/\s+/).length, model: MODEL }
  };
}
