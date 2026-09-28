# DEMO.md — "I speak, and the browser acts before I finish the sentence"

Target length 3–5 minutes. Two windows on screen: **left** the controlled Chromium window (opened
by the server), **right** the control page `http://localhost:8787` in your own Chrome (mic lives
here). Speak in short, natural commands; pause ~1 s between commands.

## Before recording

```bash
cd jev-voice-browser-zh
./run.sh                       # server + controlled window (starts on example.com)
```

1. Open `http://localhost:8787` in Chrome, click **Start mic**, allow the microphone. The red dot
   pulses.
2. Say "scroll down" once to warm up the API connection (first call is ~700 ms, later ones ~300 ms).
3. Optional dry run without talking: `npm run demo` replays the whole script below headed.

If the room is noisy, keep the mic close; the `is_command` gate ignores side talk anyway — that is
a demo point, not a problem.

---

## 0:00 — Hook (15 s)

Camera on both windows. Say:

> **"Go to wikipedia."**

Point at the controlled window: it navigates as the word "wikipedia" lands. Point at the header
pills on the control page: **last ~300 ms**, **cost $0.000xxx**.

Line: *"That wasn't an LLM writing a plan. A model answered eleven yes/no and multiple-choice
questions in three hundred milliseconds, and code did the rest."*

## 0:20 — What Jev is (30 s)

Point at the **JEV DECISION** panel and the intent bars.

- Jev is TypeSafe's *System One* model: it does not generate text. You send a state and a set of
  typed questions, you get one typed answer per question — probabilities, not prose.
- All questions are answered **in parallel**, so we ask everything speculatively in one request:
  intent, which element, which site, "is the sentence finished?", "is this even for me?", "is it
  destructive?", scroll amount, and which verbatim span is the search text.
- Pricing: $0.042 per million input tokens, output free. Point at the cost pill: a whole demo is
  about a cent.

## 0:50 — Acting on partial speech (45 s)

Say slowly, with a small pause after "for":

> **"Search for … Alan Turing."**

Point at the gate table while you pause: `complete 0.03 ✗` — it *waits*. Then it types into
Wikipedia's own search box and hits Enter (highlight + toast in the controlled window).

Line: *"The `complete` question is why it can act early without acting wrong: 'search for' alone
scores 0.03, 'search for Alan Turing' scores 0.97. And the text it typed was never generated — my
code cut candidate spans out of the transcript, Jev only picked one. Look at the text_span bars."*

> **"Scroll down a bit."**

> **"Scroll to the bottom."**

Point at **SCROLL AMOUNT**: a 3-level Score — a little / one page / to the end.

> **"Go back."**

## 1:35 — Clicking things: the element snapshot (45 s)

> **"Go to hacker news."**

Point at the **ELEMENTS SENT TO JEV** list: ~100 interactive elements with short ids, viewport
first, 60 chars each. That is the whole state — a few thousand tokens.

> **"Click the new link."**

The target bar shows `e03 new 0.97`. The element flashes orange before the click.

Now the ambiguous one:

> **"Click on a link."**

Target confidence drops below 0.45 → numbered blue badges appear on the top candidates in the page
and the toast says *"Which one? Say the number."* Say:

> **"Two."**

Line: *"No model call for the number — that's a regex. Jev answers judgment, code answers
arithmetic."*

## 2:20 — Safety gates (40 s)

> **"Go to example dot com."**

Point at **url_span**: the domain was regex-extracted from "example dot com" and Jev picked it.

> **"Click the more information link."**

Then side-talk to someone off camera in a normal voice:

> **"…so anyway I think we should get lunch after this."**

Point at the verdict: `IGNORE — not a browser command`, `is_command 0.02`. Nothing moved.

Destructive gate (optional, needs a page with a buy/submit/delete button — GitHub's "delete
repository", any checkout page, or the `FORM_PAGE` fixture in the integration test): say
"click place order" → verdict `CONFIRM`, toast *Say "confirm"…* → say "cancel".

## 3:00 — Two commands in one breath (20 s)

> **"Open a new tab and go to wikipedia."**

The tab opens as soon as "open a new tab" is complete; the remaining words become a second command.

> **"Close this tab."**

## 3:20 — Show the code (40 s)

Open `src/constants.js` on screen.

- `MODEL = "jev-1.13.0"` — pinned, because aliases move and thresholds are tuned per version.
- Scroll through `INTENT_CRITERIA`: every option is `{what, not_for, examples}` — contrastive
  descriptions are what make a Choice sharp.
- `T` — the thresholds you just saw in the gate table. *"This is the entire policy. Change a
  number, not a prompt."*
- `PAYLOAD_INTENTS` / `PAYLOAD_SILENCE_MS` — why searches wait for the end of the phrase but
  "go back" doesn't.

Open `src/policy.js` briefly: it's `if` statements over probabilities.

## 4:00 — Numbers and close (20 s)

Run in a terminal (or show a pre-recorded run):

```bash
npm run test:integration    # 27/27 real-API cases, latency avg ≈ 330 ms
npm run demo:ci             # 16 spoken commands, headless, asserts URLs
```

Read the summary line: *acted@word < total* means the browser acted before the sentence ended.

Close: *"Fast because it's not thinking out loud. Reliable because code owns the control flow and
the model only answers the questions a person could answer in a second."*

---

## Phrases that work well (backup list)

- "go to youtube" · "open github" · "go to news dot ycombinator dot com"
- "search wikipedia for alan turing" · "search youtube for lofi beats" · "look up the weather in berlin"
- "click the first result" · "click sign in" · "open the comments tab"
- "type hello world into the search box" · "press enter"
- "scroll down a page" · "scroll up" · "back to the top" (may map to scroll_up or go_back — watch the bars)
- "reload" · "go forward" · "next tab"

## If something goes wrong on camera

- Mic stops after silence: Chrome ends continuous sessions after ~60 s of silence; the page
  restarts it automatically (the dot keeps pulsing). If it says *error: not-allowed*, allow the mic
  in the site settings.
- Nothing happens: read the gate table — it tells you which threshold failed. Say the command again
  a bit more explicitly ("click the link that says new").
- Wrong element: say "go back" (or click **Undo / back**).
- Page has no snapshot yet after a navigation: click **Re-scan page**.
