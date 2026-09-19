import path from "path";
import pdf from "pdf-parse";
import mammoth from "mammoth";
import AdmZip from "adm-zip";
import { XMLParser } from "fast-xml-parser";

const SUPPORTED = new Set([".pdf", ".docx", ".txt", ".md", ".pptx"]);

function normalizeText(text = "") {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function collectTextNodes(value, out = []) {
  if (value == null) return out;
  if (typeof value === "string" || typeof value === "number") {
    out.push(String(value));
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTextNodes(item, out);
    return out;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "a:t" || key.endsWith(":t") || key === "t") {
        collectTextNodes(child, out);
      } else {
        collectTextNodes(child, out);
      }
    }
  }
  return out;
}

async function extractPptx(buffer) {
  const zip = new AdmZip(buffer);
  const parser = new XMLParser({ ignoreAttributes: false, preserveOrder: false });
  const slideEntries = zip
    .getEntries()
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName))
    .sort((a, b) => {
      const na = Number(a.entryName.match(/slide(\d+)\.xml/)?.[1] || 0);
      const nb = Number(b.entryName.match(/slide(\d+)\.xml/)?.[1] || 0);
      return na - nb;
    });

  const slides = [];
  for (const entry of slideEntries) {
    const xml = entry.getData().toString("utf8");
    const obj = parser.parse(xml);
    const texts = collectTextNodes(obj, []);
    const unique = [];
    for (const t of texts) {
      const clean = String(t).trim();
      if (clean && unique[unique.length - 1] !== clean) unique.push(clean);
    }
    if (unique.length) slides.push(unique.join("\n"));
  }
  return slides.join("\n\n--- Slide ---\n\n");
}

export async function extractDocumentText(file) {
  const extension = path.extname(file.originalname || "").toLowerCase();
  if (!SUPPORTED.has(extension)) {
    throw new Error("Unsupported file type. Please upload PDF, DOCX, PPTX, TXT, or MD.");
  }

  let text = "";
  if (extension === ".pdf") {
    const parsed = await pdf(file.buffer);
    text = parsed.text || "";
  } else if (extension === ".docx") {
    const parsed = await mammoth.extractRawText({ buffer: file.buffer });
    text = parsed.value || "";
  } else if (extension === ".pptx") {
    text = await extractPptx(file.buffer);
  } else {
    text = file.buffer.toString("utf8");
  }

  text = normalizeText(text);
  if (text.length < 120) {
    throw new Error(
      "Very little readable text was found. If this is a scanned/image-only PDF, convert it to a searchable PDF or DOCX first."
    );
  }

  return {
    text,
    extension,
    wordCount: text.split(/\s+/).filter(Boolean).length
  };
}

export function chunkText(text, targetChars = 14000) {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let current = "";

  const pushCurrent = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > targetChars) {
      pushCurrent();
      for (let i = 0; i < paragraph.length; i += targetChars) {
        chunks.push(paragraph.slice(i, i + targetChars));
      }
      continue;
    }

    if ((current + "\n\n" + paragraph).length > targetChars) pushCurrent();
    current += (current ? "\n\n" : "") + paragraph;
  }
  pushCurrent();

  return chunks.length ? chunks : [text];
}
