# PainterDesk

An AI-powered estimating workbench for commercial painting contractors. Upload a blueprint, let the AI detect every paintable surface, fine-tune by hand, then export a professional bid.

## What you need before you start

- Node.js 20 or newer (check with `node --version`)
- An Anthropic API key (get one at https://console.anthropic.com)

## First-time setup

1. Open a terminal in this folder.
2. Install dependencies:
   ```
   npm install
   ```
3. Copy the example environment file:
   ```
   copy .env.example .env.local
   ```
   (On Mac/Linux use `cp` instead of `copy`.)
4. Open `.env.local` in any text editor and replace `your_api_key_here` with your real Anthropic API key.
5. Set up the local database:
   ```
   npm run prisma:push
   ```
6. Start the app:
   ```
   npm run dev
   ```
7. Open http://localhost:3000 in your browser.

> **Important:** Never share your `.env.local` file or commit it to git. It contains your API key.

## Daily AI usage budget

PainterDesk has a built-in safety net. It will not let your AI bill exceed **$20 per day**. You'll see today's usage in the top-right corner of the app. When you get close to the limit, the AI features pause automatically. Manual editing always continues to work.

## First time using PainterDesk?

1. Click **New Project** on the dashboard.
2. Give the project a name (e.g. "Memorial Hospital Wing C").
3. Upload your blueprint PDF.
4. Click **Run AI Takeoff** and wait about 30 seconds.
5. Review the surfaces the AI found in the right sidebar. Accept the ones that look right, reject the wrong ones, draw any it missed.
6. Use the chat panel to make bulk changes ("change all bathroom walls to semi-gloss").
7. Open the estimate worksheet at the bottom to see your numbers update live.
8. When you're happy, click **Generate Bid** to export a professional PDF.

## Troubleshooting

**"Please add your Anthropic API key to .env.local."**
Open `.env.local` in this folder. Make sure the line reads `ANTHROPIC_API_KEY=` followed by your real key from console.anthropic.com.

**"Daily AI usage limit reached."**
You've hit today's $20 spending cap. Wait until tomorrow (midnight local time) or keep editing manually.

**The app won't start.**
Make sure you ran `npm install` and `npm run prisma:push` once before `npm run dev`.

## Running tests

```
npm test
```

This runs the full Playwright end-to-end test suite. Tests use a `TEST_MODE=1`
environment variable that swaps the real Anthropic call for a deterministic
stub — your daily $20 budget is untouched while testing.

## Keyboard shortcuts

| Key                          | What it does                       |
| ---------------------------- | ---------------------------------- |
| `Cmd+K` / `Ctrl+K`           | Open the command palette           |
| `V`                          | Select tool                        |
| `R` / `A`                    | Rectangle (area) tool              |
| `P` / `L` / `C`              | Polygon / linear / count tool      |
| `E`                          | Eraser                             |
| `Cmd+Z` / `Ctrl+Z`           | Undo                               |
| `Cmd+Shift+Z` / `Ctrl+Shift+Z` | Redo                             |
| `Esc`                        | Deselect / return to select tool   |
| `Delete` / `Backspace`       | Remove the selected surface        |

## Where things live

| Folder                           | What's in it                                        |
| -------------------------------- | --------------------------------------------------- |
| `src/app/`                       | Pages and API routes                                |
| `src/components/editor/`         | PDF viewer, surface overlay, drawing tools, history |
| `src/components/chat/`           | Chat sidebar + confirmation modal                   |
| `src/components/worksheet/`      | Live estimate worksheet                             |
| `src/components/command/`        | Cmd+K command palette                               |
| `src/lib/rate-limit.ts`          | Per-page / per-project / global AI rate limits      |
| `src/lib/cache.ts`               | 24-hour AI response cache                           |
| `src/lib/math/`                  | Painting math (production rates, coverage, waste)   |
| `src/lib/ai/`                    | AI prompts and tool definitions                     |
| `prisma/schema.prisma`           | SQLite schema                                       |
| `uploads/`                       | Uploaded PDFs (gitignored)                          |
| `tests/checkpoint-*.spec.ts`     | End-to-end tests                                    |
