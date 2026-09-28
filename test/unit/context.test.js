import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRequest, encodeContext } from "../../src/jev.js";
import { evaluatePolicy, reverseAction } from "../../src/policy.js";
import { T } from "../../src/constants.js";

const snapshot = {
  url: "https://typesafe.ai/jev",
  title: "Jev",
  site: "generic",
  searchBoxId: null,
  elements: [
    { id: "e01", role: "link", text: "Documentation", href: "docs.typesafe.ai" },
    { id: "e02", role: "link", text: "Pricing" },
    { id: "e03", role: "button", text: "Get API key" },
  ],
};

const context = {
  previousPage: { url: "https://duckduckgo.com/?q=typesafe+jev", title: "typesafe jev at DuckDuckGo", site: "duckduckgo" },
  recentActions: [
    { type: "navigate_url", url: "https://duckduckgo.com/?q=typesafe+jev", said: "搜索 typesafe jev", ok: true, outcome: "已打开 duckduckgo.com/?q=typesafe+jev", at: Date.now() - 20_000 },
    { type: "click_element", targetId: "e20", targetLabel: 'link "TypeSafe — Jev"', said: "点击第一个结果", ok: true, outcome: "已打开 typesafe.ai/jev", at: Date.now() - 5_000 },
  ],
};

test("encodeContext:上一页 + 最近动作(最近的在前),保持精简", () => {
  const ctx = encodeContext(context);
  assert.equal(ctx.previous_page.url, "https://duckduckgo.com/?q=typesafe+jev");
  assert.equal(ctx.recent_actions.length, 2);
  assert.equal(ctx.recent_actions[0].action, "click_element");
  assert.equal(ctx.recent_actions[0].target, 'link "TypeSafe — Jev"');
  assert.equal(ctx.recent_actions[0].outcome, "已打开 typesafe.ai/jev");
  assert.ok(ctx.recent_actions[0].seconds_ago >= 4 && ctx.recent_actions[0].seconds_ago <= 6);
  assert.equal(encodeContext(null), null);
  assert.equal(encodeContext({ previousPage: null, recentActions: [] }), null);
});

test("buildRequest:context 进 state;is_correction 只在有历史时才问", () => {
  const withCtx = buildRequest({ transcript: "打开文档", snapshot, context });
  assert.equal(withCtx.state.context.previous_page.title, "typesafe jev at DuckDuckGo");
  assert.ok(withCtx.questions.is_correction, "有最近动作时才问 is_correction");
  const noCtx = buildRequest({ transcript: "打开文档", snapshot });
  assert.equal(noCtx.state.context, undefined);
  assert.equal(noCtx.questions.is_correction, undefined);
});

test("reverseAction:导航/点击 → 返回,输入 → 清空,标签页/滚动 → 反向", () => {
  assert.equal(reverseAction({ type: "click_element", label: "x" }).type, "go_back");
  assert.equal(reverseAction({ type: "navigate_url", url: "https://a" }).type, "go_back");
  assert.deepEqual(reverseAction({ type: "type_into_field", targetId: "e02", label: "box" }).text, "");
  assert.equal(reverseAction({ type: "open_new_tab" }).type, "close_tab");
  assert.equal(reverseAction({ type: "scroll_down", amount: "page" }).type, "scroll_up");
});

const base = {
  site: { choice: "none", confidence: 1, probabilities: { none: 1 } },
  complete: { noul: 0.95 },
  is_command: { noul: 0.95 },
  destructive: { noul: 0.02 },
  scroll_amount: { score: 1, confidence: 1, probabilities: { 0: 0, 1: 1, 2: 0 } },
  tab_direction: { choice: "none", confidence: 1, probabilities: { none: 1 } },
};

test("policy:\"不,不是这个\"且无新目标时,反转上一操作", () => {
  const answers = {
    ...base,
    intent: { choice: "none", confidence: 0.4, probabilities: { none: 0.5, go_back: 0.3, click_element: 0.2 } },
    target: { choice: "none", confidence: 0.9, probabilities: { none: 0.9, e01: 0.05, e02: 0.05 } },
    is_correction: { noul: 0.92 },
  };
  const p = evaluatePolicy({ answers, candidates: { text: [], url: [] }, snapshot, isFinal: true, context });
  assert.equal(p.decision, "act");
  assert.equal(p.action.type, "go_back");
  assert.ok(p.reasons.some((r) => r.name === "is_correction" && r.pass));
});

test("policy:\"不,是另一个\"排除刚点过的元素,取第二名", () => {
  const prev = {
    ...context,
    recentActions: [{ type: "click_element", targetId: "e01", targetLabel: 'link "Documentation"', said: "点击文档", ok: true, outcome: "已完成", at: Date.now() - 3000 }],
  };
  const answers = {
    ...base,
    intent: { choice: "click_element", confidence: 0.8, probabilities: { click_element: 0.85, none: 0.15 } },
    // Jev still leans to the element just clicked; policy must rule it out.
    target: { choice: "e01", confidence: 0.6, probabilities: { e01: 0.55, e02: 0.4, e03: 0.05, none: 0 } },
    is_correction: { noul: 0.9 },
  };
  const p = evaluatePolicy({ answers, candidates: { text: [], url: [] }, snapshot, isFinal: true, context: prev });
  assert.equal(p.decision, "act");
  assert.equal(p.action.targetId, "e02");
  assert.ok(p.reasons.some((r) => r.name === "exclude_target"));
});

test("policy:普通后续命令不算纠正", () => {
  const answers = {
    ...base,
    intent: { choice: "click_element", confidence: 0.9, probabilities: { click_element: 0.92, none: 0.08 } },
    target: { choice: "e01", confidence: 0.9, probabilities: { e01: 0.9, e02: 0.05, e03: 0.05, none: 0 } },
    is_correction: { noul: 0.05 },
  };
  const p = evaluatePolicy({ answers, candidates: { text: [], url: [] }, snapshot, isFinal: true, context });
  assert.equal(p.decision, "act");
  assert.equal(p.action.type, "click_element");
  assert.equal(p.action.targetId, "e01");
  assert.ok(!p.reasons.some((r) => r.name === "is_correction"));
  assert.ok(T.correction > 0.05);
});
