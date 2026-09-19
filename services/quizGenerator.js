import OpenAI from "openai";
import crypto from "crypto";

let client = null;
const MODEL = process.env.OPENAI_MODEL || "gpt-5.6-luna";
const MAX_QUESTIONS = Math.max(10, Math.min(30, Number(process.env.MAX_QUESTIONS || 30)));

function getOpenAIClient() {
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured on the server.");
  }
  if (!client) client = new OpenAI({ apiKey });
  return client;
}

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
    throw new Error("The AI returned an invalid response format. Please try again later.");
  }
}

async function askJson(prompt, maxOutputTokens = 8000) {
  const response = await getOpenAIClient().responses.create({
    model: MODEL,
    input: prompt,
    max_output_tokens: maxOutputTokens
  });
  return parseJsonLoose(response.output_text);
}

function uniq(items) {
  return [...new Set((items || []).map((x) => String(x || "").trim()).filter(Boolean))];
}

function normalizeCoverage(raw, sourceName) {
  const topics = (Array.isArray(raw?.topics) ? raw.topics : [])
    .map((topic, index) => ({
      id: String(topic.id || `T${index + 1}`).trim(),
      name: String(topic.name || `Topic ${index + 1}`).trim(),
      importance: ["high", "medium", "low"].includes(topic.importance) ? topic.importance : "medium",
      studyPoints: uniq(topic.studyPoints).slice(0, 18)
    }))
    .filter((topic) => topic.name && topic.studyPoints.length);

  return {
    title: String(raw?.title || sourceName || "Study Quiz").trim(),
    summary: String(raw?.summary || "").trim(),
    topics
  };
}

function computeQuestionCount(wordCount, topics) {
  const topicCount = topics.length;
  const studyPointCount = topics.reduce((sum, topic) => sum + topic.studyPoints.length, 0);

  // Keep generation useful but economical. Every major topic can receive at least one item,
  // while longer files receive more questions up to the configured cap.
  const byLength = Math.ceil(wordCount / 450);
  const byCoverage = Math.ceil(studyPointCount / 2.5);
  return Math.max(10, Math.min(MAX_QUESTIONS, Math.max(topicCount, byLength, byCoverage)));
}

async function buildCoverageMapFromDocument({ text, sourceName }) {
  const prompt = `
You are a careful study-material analyst. Read the ENTIRE document below from beginning to end before answering.
The document has already been limited to a size that fits in this request, so do not sample, truncate, or ignore later sections.

Create a compact coverage map that preserves every substantive topic in the file. Combine only closely related subtopics. Keep the number of MAJOR topics at 18 or fewer, but preserve smaller subtopics as specific study points under the correct major topic.

Return ONLY valid JSON in this exact shape:
{
  "title": "short study title",
  "summary": "2-4 sentence overview",
  "topics": [
    {
      "id": "T1",
      "name": "major topic",
      "importance": "high|medium|low",
      "studyPoints": [
        "specific factual point from the document",
        "definition, process, distinction, example, formula, date, exception, or relationship"
      ]
    }
  ]
}

Coverage requirements:
- Inspect all headings, paragraphs, lists, definitions, tables represented as text, examples, steps, formulas, comparisons, dates, names, exceptions, and conclusions.
- Include every substantive section somewhere in the coverage map.
- Keep study points concise but specific enough to write factual questions from them later.
- Do not add outside facts and do not guess missing information.
- Do not repeat the same point under several topics.

SOURCE FILE: ${sourceName}

FULL DOCUMENT:
<<<DOCUMENT START>>>
${text}
<<<DOCUMENT END>>>
`;

  const raw = await askJson(prompt, 7000);
  return normalizeCoverage(raw, sourceName);
}

async function buildCoverageMapFromTopic(topicText) {
  const prompt = `
Create a concise, broadly representative study coverage map for the topic "${topicText}" using standard educational knowledge.

Return ONLY valid JSON:
{
  "title": "short title",
  "summary": "2-4 sentence overview",
  "topics": [
    {
      "id": "T1",
      "name": "major subtopic",
      "importance": "high|medium|low",
      "studyPoints": ["specific fact or concept", "specific fact or concept"]
    }
  ]
}

Use 4-12 major subtopics. Keep study points concise and suitable for objective multiple-choice questions.
`;

  const raw = await askJson(prompt, 4500);
  return normalizeCoverage(raw, topicText);
}

function normalizeQuestion(question, fallbackTopicId) {
  const choices = Array.isArray(question?.choices) ? question.choices.slice(0, 4) : [];
  if (choices.length !== 4) return null;

  const normalizedChoices = choices.map((choice, index) => ({
    id: String(choice.id || ["A", "B", "C", "D"][index]).trim(),
    text: String(choice.text || "").trim()
  }));

  if (normalizedChoices.some((choice) => !choice.text)) return null;
  if (new Set(normalizedChoices.map((choice) => choice.text.toLowerCase())).size !== 4) return null;

  const correctChoiceId = String(question.correctChoiceId || "").trim();
  if (!normalizedChoices.some((choice) => choice.id === correctChoiceId)) return null;

  const stem = String(question.question || "").trim();
  if (!stem) return null;

  return {
    id: crypto.randomUUID(),
    topicId: String(question.topicId || fallbackTopicId || "REVIEW").trim(),
    question: stem,
    choices: normalizedChoices,
    correctChoiceId,
    explanation: String(question.explanation || "").trim(),
    sourceNote: String(question.sourceNote || "").trim()
  };
}

function dedupeQuestions(questions) {
  const seen = new Set();
  return questions.filter((question) => {
    const key = question.question.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function generateQuestionsFromCoverage(coverage, questionCount) {
  const compactCoverage = {
    title: coverage.title,
    summary: coverage.summary,
    topics: coverage.topics
  };

  const prompt = `
Create ${questionCount} high-quality single-answer multiple-choice questions using ONLY the coverage map below.
The coverage map was produced after reading the entire source material.

Return ONLY valid JSON:
{
  "questions": [
    {
      "topicId": "T1",
      "question": "clear, self-contained question",
      "choices": [
        {"id":"A","text":"..."},
        {"id":"B","text":"..."},
        {"id":"C","text":"..."},
        {"id":"D","text":"..."}
      ],
      "correctChoiceId": "A",
      "explanation": "1-2 concise sentences explaining the answer from the study material",
      "sourceNote": "short study point being tested"
    }
  ]
}

Requirements:
- Produce as close to exactly ${questionCount} questions as possible.
- Exactly four distinct choices and exactly one defensible correct answer for every question.
- Use only facts contained in the coverage map; do not import outside facts.
- Cover EVERY major topic at least once before adding extra questions to high-importance or content-rich topics.
- Within each topic, spread questions across different study points so the quiz represents the whole material.
- Mix factual recall, definitions, comparisons, sequences, relationships, and simple application only when the coverage map supports them.
- Avoid duplicates, trick questions, "all of the above," and "none of the above."
- Keep explanations concise to reduce unnecessary output.

COVERAGE MAP:
${JSON.stringify(compactCoverage)}
`;

  const result = await askJson(prompt, 11000);
  const rawQuestions = Array.isArray(result?.questions) ? result.questions : [];
  const normalized = rawQuestions
    .map((question) => normalizeQuestion(question, coverage.topics[0]?.id))
    .filter(Boolean);

  return dedupeQuestions(normalized).slice(0, questionCount);
}

export async function generateQuizFromDocument({ text, wordCount, sourceName }) {
  const coverage = await buildCoverageMapFromDocument({ text, sourceName });
  if (!coverage.topics.length) {
    throw new Error("No usable study topics could be identified in the document.");
  }

  const questionCount = computeQuestionCount(wordCount, coverage.topics);
  const questions = await generateQuestionsFromCoverage(coverage, questionCount);
  if (!questions.length) {
    throw new Error("The quiz could not be generated from this material. Please try again later.");
  }

  return {
    ...coverage,
    questionCount: questions.length,
    questions,
    diagnostics: {
      wordsRead: wordCount,
      passes: 2,
      model: MODEL,
      optimized: true
    }
  };
}

export async function generateQuizFromTopic(topicText) {
  const coverage = await buildCoverageMapFromTopic(topicText);
  if (!coverage.topics.length) {
    throw new Error("No usable study areas could be created for that topic.");
  }

  const estimatedWords = Math.max(1000, coverage.topics.reduce((sum, topic) => sum + topic.studyPoints.length * 90, 0));
  const questionCount = Math.max(10, Math.min(24, computeQuestionCount(estimatedWords, coverage.topics)));
  const questions = await generateQuestionsFromCoverage(coverage, questionCount);
  if (!questions.length) {
    throw new Error("The quiz could not be generated for that topic. Please try again later.");
  }

  return {
    ...coverage,
    questionCount: questions.length,
    questions,
    diagnostics: {
      wordsRead: null,
      passes: 2,
      model: MODEL,
      optimized: true
    }
  };
}
