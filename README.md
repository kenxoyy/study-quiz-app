# StudyQuiz — optimized version

A minimalist Quipper-inspired study website that turns an uploaded study file into a multiple-choice quiz, grades the learner, shows a review, and supports shuffled retakes.

## What changed in this optimized version

This version is designed to use substantially fewer API tokens and reduce accidental rate-limit/cost spikes.

- The accepted document is read in full in one coverage pass instead of sending many overlapping chunks to the API.
- A compact whole-document coverage map is created first.
- The quiz is then generated from that compact map in one second API call.
- Maximum quiz size is 30 questions by default.
- Files are limited to 10 MB and 12,000 extracted words by default. Files beyond the text limit are rejected instead of being silently truncated, so an accepted file is still processed thoroughly.
- Identical documents/topics are cached in server memory for 12 hours by default, so regenerating the same material can avoid another API generation.
- Retakes never call the AI; they only reshuffle the already-generated questions and answer choices.
- Only one new quiz generation runs at a time by default.
- A short global cooldown between uncached generations reduces token-per-minute spikes.
- Basic per-IP generation limits protect a public deployment from repeated API usage.
- OpenAI 429/rate-limit and credential errors are converted to clearer user-facing messages.

## Core study features

- Upload PDF, DOCX, PPTX, TXT, or Markdown files.
- Create a coverage map across the accepted document.
- Generate an adaptive number of four-choice MCQs.
- Require every question to be answered before submission.
- Grade answers on the server.
- Reveal the score, correct/incorrect answers, explanations, and study points after submission.
- Filter review to All / Incorrect / Correct.
- Retake with shuffled question order and shuffled choice order.
- Keep correct answers on the server until submission.

## Requirements

- Node.js 20+
- An OpenAI API key
- VS Code or another code editor

## Local setup

1. Open the project folder in VS Code.
2. Install dependencies:

   ```bash
   npm install
   ```

3. Copy `.env.example` to a new file named `.env`.
4. Add your API key:

   ```env
   OPENAI_API_KEY=your_real_key_here
   OPENAI_MODEL=gpt-5.6-luna
   PORT=3000
   ```

5. Start the app:

   ```bash
   npm run dev
   ```

6. Open `http://localhost:3000`.

## Render settings

Use:

```text
Build Command: npm install
Start Command: npm start
```

In Render Environment Variables, set at minimum:

```text
OPENAI_API_KEY = your secret key
OPENAI_MODEL = gpt-5.6-luna
```

Do not put the API key in GitHub or any file inside `public/`.

## Optional controls

These values can be changed in `.env` locally or in Render's Environment settings:

```env
MAX_FILE_MB=10
MAX_DOCUMENT_WORDS=12000
MAX_DOCUMENT_CHARS=90000
MAX_QUESTIONS=30
MAX_CONCURRENT_GENERATIONS=1
GENERATION_LIMIT=4
GENERATION_WINDOW_MINUTES=60
GLOBAL_GENERATION_COOLDOWN_SECONDS=45
QUIZ_CACHE_HOURS=12
```

### Why there is a document limit

The goal is to guarantee that accepted material is actually read rather than quietly discarding later pages. If extracted text exceeds the configured word/character limit, the site asks the learner to split the material into smaller study files.

### Cache behavior

The cache is held in server memory. On Render, it can disappear whenever the service restarts or sleeps. A database/Redis cache would be the next step for a larger public site.

### Scanned PDFs

`pdf-parse` can extract text from searchable/text PDFs. Image-only scanned PDFs need OCR before this starter can read them.

## Quiz integrity and cooldown behavior

- If a learner switches away from or hides the browser tab while a quiz attempt is active, the current attempt is automatically submitted. Any unanswered questions are counted as incorrect.
- Manual submission still requires every question to be answered.
- When the API returns a retry time for a generation-rate limit, the site stores the cooldown in the browser, displays the local retry time with a live countdown, and disables new quiz generation until the cooldown expires. Existing quiz retakes continue to work without new AI generation.
