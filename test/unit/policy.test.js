import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluatePolicy, topChoices } from "../../src/policy.js";
import { T, SILENCE_COMPLETE_MS, PAYLOAD_SILENCE_MS } from "../../src/constants.js";

/** Build a mocked Jev answer set. */
function answers(over = {}) {
  const choice = (c, conf = 0.95, extra = {}) => ({ type: "choice", choice: c, confidence: conf, probabilities: { [c]: conf, none: 1 - conf, ...extra } });
  const base = {
    intent: choice("scroll_down"),
    target: choice("none"),
    site: choice("none"),
    complete: { type: "noul", noul: 0.9 },
    is_command: { type: "noul", noul: 0.95 },
    destructive: { type: "noul", noul: 0.05 },
    scroll_amount: { type: "score", score: 1, confidence: 0.9, probabilities: { 0: 0.05, 1: 0.9, 2: 0.05 } },
    tab_direction: choice("none"),
  };
  return { ...base, ...over };
}
const snapshot = {
  url: "https://en.wikipedia.org/wiki/Main_Page",
  title: "Wikipedia",
  site: "wikipedia",
  searchBoxId: "e02",
  elements: [
    { id: "e01", role: "link", text: "Main page" },
    { id: "e02", role: "searchbox", text: "", placeholder: "Search Wikipedia" },
    { id: "e03", role: "link", text: "Alan Turing" },
    { id: "e04", role: "button", text: "Log in" },
  ],
};
const candidates = { text: [], url: [] };
const ch = (c, conf, extra) => ({ type: "choice", choice: c, confidence: conf, probabilities: { [c]: conf, ...extra } });

test("acts on a confident, complete, non-destructive command", () => {
  const r = evaluatePolicy({ answers: answers(), candidates, snapshot });
  assert.equal(r.decision, "act");
  assert.equal(r.action.type, "scroll_down");
  assert.equal(r.action.amount, "page");
  assert.ok(r.reasons.every((x) => x.pass));
});

test("ignores when is_command is below threshold", () => {
  const r = evaluatePolicy({ answers: answers({ is_command: { noul: T.isCommand - 0.1 } }), candidates, snapshot });
  assert.equal(r.decision, "ignore");
  assert.equal(r.reasons.find((x) => x.name === "is_command").pass, false);
});

test("waits when intent confidence is low or intent is none", () => {
  assert.equal(evaluatePolicy({ answers: answers({ intent: ch("scroll_down", T.intentConfidence - 0.05) }), candidates, snapshot }).decision, "wait");
  assert.equal(evaluatePolicy({ answers: answers({ intent: ch("none", 0.99) }), candidates, snapshot }).decision, "wait");
});

test("waits for completeness on partial speech, but silence or a final result bypasses it", () => {
  const a = answers({ intent: ch("navigate_url", 0.9), complete: { noul: 0.2 }, site: ch("wikipedia", 0.9) });
  assert.equal(evaluatePolicy({ answers: a, candidates, snapshot }).decision, "wait");
  assert.equal(evaluatePolicy({ answers: a, candidates, snapshot, silentMs: SILENCE_COMPLETE_MS }).decision, "act");
  assert.equal(evaluatePolicy({ answers: a, candidates, snapshot, isFinal: true }).decision, "act");
});

test("the same completeness threshold applies to every intent (no early scroll on 'scroll to the')", () => {
  const a = answers({ intent: ch("scroll_down", 0.95), complete: { noul: T.complete - 0.05 } });
  assert.equal(evaluatePolicy({ answers: a, candidates, snapshot }).decision, "wait");
  const b = answers({ intent: ch("scroll_down", 0.95), complete: { noul: T.complete + 0.05 } });
  assert.equal(evaluatePolicy({ answers: b, candidates, snapshot }).decision, "act");
});

test("navigate: spoken domain beats site list; known site (incl. Chinese) maps to its home URL; unknown waits", () => {
  const a = answers({ intent: ch("navigate_url", 0.95), url_span: ch("example.com", 0.9) });
  const r = evaluatePolicy({ answers: a, candidates: { text: [], url: ["example.com"] }, snapshot });
  assert.equal(r.action.url, "https://example.com");

  const b = answers({ intent: ch("navigate_url", 0.95), site: ch("youtube", 0.9) });
  assert.equal(evaluatePolicy({ answers: b, candidates, snapshot }).action.url, "https://www.youtube.com/");

  const bd = answers({ intent: ch("navigate_url", 0.95), site: ch("baidu", 0.9) });
  assert.equal(evaluatePolicy({ answers: bd, candidates, snapshot }).action.url, "https://www.baidu.com/");

  const c = answers({ intent: ch("navigate_url", 0.95), site: ch("none", 0.9) });
  assert.equal(evaluatePolicy({ answers: c, candidates, snapshot }).decision, "wait");
});

test("search: named site template, else on-page search box, else default engine; query copied verbatim", () => {
  const cands = { text: ["艾伦图灵", "搜索艾伦图灵"], url: [] };
  const a = answers({ intent: ch("search_web", 0.95), site: ch("youtube", 0.9), text_span: ch("艾伦图灵", 0.9) });
  assert.equal(evaluatePolicy({ answers: a, candidates: cands, snapshot, isFinal: true }).action.url, "https://www.youtube.com/results?search_query=" + encodeURIComponent("艾伦图灵"));

  const b = answers({ intent: ch("search_web", 0.95), text_span: ch("艾伦图灵", 0.9) });
  const rb = evaluatePolicy({ answers: b, candidates: cands, snapshot, isFinal: true });
  assert.equal(rb.action.type, "type_into_field");
  assert.equal(rb.action.targetId, "e02");
  assert.equal(rb.action.text, "艾伦图灵");
  assert.equal(rb.action.submit, true);

  const rc = evaluatePolicy({ answers: b, candidates: cands, snapshot: { ...snapshot, searchBoxId: null, site: "generic" }, isFinal: true });
  assert.equal(rc.action.url, "https://duckduckgo.com/?q=" + encodeURIComponent("艾伦图灵"));

  const d = answers({ intent: ch("search_web", 0.95), text_span: ch("none", 0.9) });
  assert.equal(evaluatePolicy({ answers: d, candidates: cands, snapshot, isFinal: true }).decision, "wait");
});

test("low-confidence text_span falls back to the heuristic top candidate (never invents text)", () => {
  const a = answers({ intent: ch("search_web", 0.95), text_span: ch("搜索艾伦图灵", 0.2, { "艾伦图灵": 0.3 }) });
  const r = evaluatePolicy({ answers: a, candidates: { text: ["艾伦图灵", "搜索艾伦图灵"], url: [] }, snapshot, isFinal: true });
  assert.equal(r.action.text, "艾伦图灵");
});

test("click: confident target acts; ambiguous target disambiguates with top candidates", () => {
  const a = answers({ intent: ch("click_element", 0.95), target: ch("e03", 0.9, { e01: 0.05 }) });
  const r = evaluatePolicy({ answers: a, candidates, snapshot });
  assert.equal(r.decision, "act");
  assert.equal(r.action.targetId, "e03");

  const b = answers({ intent: ch("click_element", 0.95), target: ch("e03", 0.2, { e01: 0.3, e04: 0.25, none: 0.1 }) });
  const rb = evaluatePolicy({ answers: b, candidates, snapshot });
  assert.equal(rb.decision, "disambiguate");
  assert.deepEqual(
    rb.candidates.map((c) => c.id),
    ["e03", "e01", "e04"].sort((x, y) => b.target.probabilities[y] - b.target.probabilities[x]),
  );
  assert.equal(rb.pendingIntent.type, "click_element");
});

test("click with no plausible element waits", () => {
  const a = answers({ intent: ch("click_element", 0.95), target: ch("none", 0.99, { e01: 0.005 }) });
  assert.equal(evaluatePolicy({ answers: a, candidates, snapshot }).decision, "wait");
});

test("type: confident target or search-box fallback", () => {
  const cands = { text: ["你好世界"], url: [] };
  const a = answers({ intent: ch("type_into_field", 0.95), target: ch("none", 0.9), text_span: ch("你好世界", 0.9) });
  const r = evaluatePolicy({ answers: a, candidates: cands, snapshot, isFinal: true });
  assert.equal(r.decision, "act");
  assert.equal(r.action.targetId, "e02");
  assert.equal(r.action.text, "你好世界");
});

test("destructive element actions require confirmation; confirm/cancel resolve the pending action", () => {
  const a = answers({ intent: ch("click_element", 0.95), target: ch("e04", 0.95), destructive: { noul: 0.9 } });
  const r = evaluatePolicy({ answers: a, candidates, snapshot });
  assert.equal(r.decision, "confirm");
  assert.equal(r.action.targetId, "e04");

  const yes = evaluatePolicy({ answers: answers({ intent: ch("confirm", 0.9) }), candidates, snapshot, pending: r.action });
  assert.equal(yes.decision, "act");
  assert.equal(yes.action.confirmed, true);
  const no = evaluatePolicy({ answers: answers({ intent: ch("cancel", 0.9) }), candidates, snapshot, pending: r.action });
  assert.equal(no.decision, "cancel");
});

test("destructive flag does not block navigation or scrolling", () => {
  const a = answers({ intent: ch("navigate_url", 0.95), site: ch("github", 0.9), destructive: { noul: 0.9 } });
  assert.equal(evaluatePolicy({ answers: a, candidates, snapshot }).decision, "act");
});

test("scroll amount maps score levels to little / page / end", () => {
  const mk = (score) => answers({ scroll_amount: { score, confidence: 0.9, probabilities: {} } });
  assert.equal(evaluatePolicy({ answers: mk(0.2), candidates, snapshot }).action.amount, "little");
  assert.equal(evaluatePolicy({ answers: mk(1.1), candidates, snapshot }).action.amount, "page");
  assert.equal(evaluatePolicy({ answers: mk(1.8), candidates, snapshot }).action.amount, "end");
});

test("topChoices excludes none and sorts by probability", () => {
  assert.deepEqual(topChoices({ probabilities: { a: 0.2, none: 0.5, b: 0.3 } }, 2), [
    { id: "b", p: 0.3 },
    { id: "a", p: 0.2 },
  ]);
});

test("free-text intents wait for a final result or silence, even when `complete` is high", () => {
  const cands = { text: ["艾伦"], url: [] };
  const a = answers({ intent: ch("search_web", 0.99), complete: { noul: 0.95 }, text_span: ch("艾伦", 0.9) });
  const partial = evaluatePolicy({ answers: a, candidates: cands, snapshot, silentMs: 100 });
  assert.equal(partial.decision, "wait");
  assert.ok(partial.retryInMs > 0);
  assert.equal(partial.reasons.find((x) => x.name === "payload_final").pass, false);
  assert.equal(evaluatePolicy({ answers: a, candidates: cands, snapshot, silentMs: PAYLOAD_SILENCE_MS }).decision, "act");
  assert.equal(evaluatePolicy({ answers: a, candidates: cands, snapshot, isFinal: true }).decision, "act");
  // closed-set intents (navigation / click / scroll) do NOT have this gate
  const b = answers({ intent: ch("navigate_url", 0.99), complete: { noul: 0.95 }, site: ch("wikipedia", 0.9) });
  assert.equal(evaluatePolicy({ answers: b, candidates, snapshot, silentMs: 0 }).decision, "act");
});
