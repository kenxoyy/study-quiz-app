# StudyQuiz

A minimalist Quipper-inspired study website that turns an uploaded study file into a multiple-choice quiz.

## What it does

- Upload **PDF, DOCX, PPTX, TXT, or Markdown** files.
- Extracts the complete readable text from the file.
- Splits long material into sections and analyzes every section.
- Builds a full-document topic coverage map.
- Chooses an adaptive number of questions (10–60 for uploaded files).
- Generates 4-choice MCQs across the identified topics.
- Requires the learner to answer every question before submission.
- Grades answers on the server, then reveals score, correct answers, and explanations.
- Lets the learner filter review to all/correct/incorrect questions.
- Retakes shuffle **both question order and choice order**.
- Correct answers are not sent to the browser before submission.

## Requirements

- Node.js 20+ recommended
- An OpenAI API key
- VS Code (or any code editor)

## Setup in VS Code

1. Open this folder in VS Code.
2. Open the integrated terminal.
3. Install packages:

   ```bash
   npm install
   ```

4. Copy `.env.example` to a new file named `.env`.
5. Put your API key in `.env`:

   ```env
   OPENAI_API_KEY=your_real_key_here
   OPENAI_MODEL=gpt-5.6-luna
   PORT=3000
   ```

6. Start the website:

   ```bash
   npm run dev
   ```

7. Open:

   ```text
   http://localhost:3000
   ```

## Important notes

### Scanned PDFs
`pdf-parse` reads text-based/searchable PDFs. If a PDF is only scanned images, this starter returns a message asking for a searchable PDF or DOCX. OCR can be added later if needed.

### API key security
Never put the API key in `public/app.js` or `index.html`. Keep it only in `.env`. The browser talks to your Node.js backend, and only the backend calls the AI API.

### Quiz sessions
Quiz sessions are stored in server memory and expire after two hours. Restarting the Node server clears them. For deployment with many users, replace the in-memory `Map` with Redis or a database.

### Adaptive question count
For uploaded files, the server estimates a reasonable count from both document length and topic count, with a minimum of 10 and maximum of 60 questions. You can change this in `computeQuestionCount()` inside `services/quizGenerator.js`.

## Project structure

```text
study-quiz-app/
├─ public/
│  ├─ index.html
│  ├─ style.css
│  └─ app.js
├─ services/
│  ├─ documentParser.js
│  └─ quizGenerator.js
├─ .env.example
├─ .gitignore
├─ package.json
├─ README.md
└─ server.js
```

## Deployment

Any Node.js host that supports environment variables can run this app. Set `OPENAI_API_KEY`, optionally set `OPENAI_MODEL`, then run `npm start`.
