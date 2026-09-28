/**
 * 对真实 Jev API 的集成测试:给定页面快照 fixture 和一句(中文)转写,
 * (Jev 答案 → 策略) 流水线是否产出预期的意图 / 目标 / 决策?
 *
 * 打印通过率报告和每次调用的延迟。需要 TYPESAFE_API_KEY(或 JEV_API_KEY),
 * 否则整体跳过。跑完一轮的成本:远低于 1 美分。
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decide, hasApiKey } from "../../src/jev.js";
import { evaluatePolicy } from "../../src/policy.js";
import { MODEL } from "../../src/constants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "fixtures", `${name}.json`), "utf8"));

// 一个真实的搜索结果页(DuckDuckGo 外壳现场捕获;结果链接是手写的,
// 因为结果由客户端渲染,headless 捕获不到)。
const SEARCH_RESULTS = {
  url: "https://duckduckgo.com/?q=jev+typesafe",
  title: "jev typesafe at DuckDuckGo",
  site: "duckduckgo",
  searchBoxId: "e02",
  elements: [
    { id: "e01", role: "link", text: "DuckDuckGo home", href: "duckduckgo.com" },
    { id: "e02", role: "combobox", text: "jev typesafe", placeholder: "Search privately" },
    { id: "e03", role: "button", text: "Search" },
    { id: "e05", role: "link", text: "All", href: "duckduckgo.com" },
    { id: "e06", role: "link", text: "Images", href: "duckduckgo.com" },
    { id: "e07", role: "link", text: "Videos", href: "duckduckgo.com" },
    { id: "e08", role: "link", text: "News", href: "duckduckgo.com" },
    { id: "e12", role: "button", text: "Search Settings" },
    { id: "e20", role: "link", text: "TypeSafe — Jev, the System One model", href: "typesafe.ai" },
    { id: "e21", role: "link", text: "typesafe.ai", href: "typesafe.ai" },
    { id: "e22", role: "link", text: "Jev 1.13 | TypeSafe Documentation", href: "docs.typesafe.ai/models/jev" },
    { id: "e23", role: "link", text: "docs.typesafe.ai", href: "docs.typesafe.ai" },
    { id: "e24", role: "link", text: "GitHub - typesafe-ai/typesafe-sdk-js: TypeScript SDK", href: "github.com/typesafe-ai/typesafe-sdk-js" },
    { id: "e25", role: "link", text: "github.com", href: "github.com" },
    { id: "e26", role: "link", text: "TypeSafe (@typesafe_ai) / X", href: "x.com/typesafe_ai" },
    { id: "e27", role: "button", text: "More results" },
    { id: "e28", role: "link", text: "Settings", href: "duckduckgo.com/settings", below_fold: true },
    { id: "e29", role: "link", text: "Privacy Policy", href: "duckduckgo.com/privacy", below_fold: true },
  ],
};

const FORM_PAGE = {
  url: "https://shop.example.com/checkout",
  title: "Checkout — Example Shop",
  site: "generic",
  searchBoxId: null,
  elements: [
    { id: "e01", role: "link", text: "Example Shop" },
    { id: "e02", role: "textbox", text: "", placeholder: "Email address" },
    { id: "e03", role: "textbox", text: "", placeholder: "Card number" },
    { id: "e04", role: "select", text: "Country" },
    { id: "e05", role: "button", text: "Place order" },
    { id: "e06", role: "link", text: "Back to cart" },
    { id: "e07", role: "button", text: "Delete account" },
  ],
};

/**
 * 每个用例:转写 + 快照 + 对 Jev 原始答案和/或策略结果的期望。
 *   intent:   期望的 `intent.choice`
 *   target:   期望的 `target.choice`(可选)
 *   decision: 期望的策略决策(可选)
 *   text:     期望的逐字 text_span(可选)
 *   final:    按最终语句处理(默认 true,这样 `complete` 不设门)
 */
const CASES = [
  { name: "滚动一点", transcript: "往下滚一点", snapshot: "wikipedia-article", intent: "scroll_down", decision: "act", amount: "little" },
  { name: "滚到底部", transcript: "滚到页面最底部", snapshot: "wikipedia-article", intent: "scroll_down", decision: "act", amount: "end" },
  { name: "向上滚动", transcript: "往上滚", snapshot: "hn", intent: "scroll_up", decision: "act" },
  { name: "打开维基百科", transcript: "打开维基百科", snapshot: "example", intent: "navigate_url", decision: "act", url: "wikipedia.org" },
  { name: "打开B站", transcript: "打开哔哩哔哩", snapshot: "hn", intent: "navigate_url", decision: "act", url: "bilibili.com" },
  { name: "口播域名", transcript: "打开 example 点 com", snapshot: "hn", intent: "navigate_url", decision: "act", url: "example.com" },
  { name: "全网搜索", transcript: "搜索 jev typesafe", snapshot: "example", intent: "search_web", decision: "act", text: "jev typesafe", url: "duckduckgo.com" },
  { name: "站内搜索框", transcript: "搜索艾伦图灵", snapshot: "wikipedia-main", intent: "search_web", decision: "act", text: "艾伦图灵", target: "e02" },
  { name: "指定站点搜索", transcript: "在B站搜索 lofi beats", snapshot: "hn", intent: "search_web", decision: "act", text: "lofi beats", url: "bilibili.com" },
  { name: "查一下", transcript: "查一下柏林的天气", snapshot: "example", intent: "search_web", decision: "act", text: "柏林的天气" },
  { name: "点击第一个结果", transcript: "点击第一个结果", snapshot: SEARCH_RESULTS, intent: "click_element", target: "e20", decision: "act" },
  { name: "点击 github 链接", transcript: "点击 github 链接", snapshot: SEARCH_RESULTS, intent: "click_element", target: "e24", decision: "act" },
  { name: "按文字点击", transcript: "点击了解更多链接", snapshot: "example", intent: "click_element", target: "e01", decision: "act" },
  { name: "点击 hn new", transcript: "点击 new 链接", snapshot: "hn", intent: "click_element", target: "e03", decision: "act" },
  { name: "打开评论区", transcript: "打开评论区", snapshot: "hn", intent: "click_element", target: "e05", decision: "act" },
  { name: "返回上一页", transcript: "返回上一页", snapshot: "wikipedia-article", intent: "go_back", decision: "act" },
  { name: "往搜索框输入", transcript: "在搜索框里输入你好世界", snapshot: "wikipedia-main", intent: "type_into_field", target: "e02", text: "你好世界", decision: "act" },
  { name: "刷新页面", transcript: "刷新页面", snapshot: "hn", intent: "reload", decision: "act" },
  { name: "新标签页", transcript: "打开一个新标签页", snapshot: "hn", intent: "open_new_tab", decision: "act" },
  { name: "闲聊被忽略", transcript: "对了我们中午吃什么", snapshot: "hn", decision: "ignore" },
  { name: "语气词被忽略", transcript: "嗯就是说", snapshot: "hn", decisionIn: ["ignore", "wait"] },
  { name: "半句打开等待", transcript: "打开", snapshot: "hn", final: false, decision: "wait" },
  { name: "半句搜索等待", transcript: "搜索", snapshot: "hn", final: false, decision: "wait" },
  { name: "危险操作要确认", transcript: "点击 place order 按钮", snapshot: FORM_PAGE, intent: "click_element", target: "e05", decision: "confirm" },
  { name: "危险删除要确认", transcript: "点击 delete account", snapshot: FORM_PAGE, intent: "click_element", target: "e07", decision: "confirm" },
  { name: "输入邮箱", transcript: "在邮箱输入框里输入 bob at example dot com", snapshot: FORM_PAGE, intent: "type_into_field", target: "e02", decision: "act" },
  { name: "元素缺失等待", transcript: "点击登录", snapshot: "example", intent: "click_element", decisionIn: ["wait", "disambiguate"] },
];

// --- 带上下文的用例:用户刚在 DuckDuckGo 搜索并点了第一个结果。 ---
const PRODUCT_PAGE = {
  url: "https://typesafe.ai/jev",
  title: "Jev — the System One model | TypeSafe",
  site: "generic",
  searchBoxId: null,
  elements: [
    { id: "e01", role: "link", text: "TypeSafe", href: "typesafe.ai" },
    { id: "e02", role: "link", text: "Product" },
    { id: "e03", role: "link", text: "Documentation", href: "docs.typesafe.ai" },
    { id: "e04", role: "link", text: "Pricing" },
    { id: "e05", role: "link", text: "Blog" },
    { id: "e06", role: "button", text: "Get an API key" },
    { id: "e07", role: "link", text: "Read the docs", href: "docs.typesafe.ai/introduction" },
    { id: "e08", role: "link", text: "Join Discord", href: "discord.com" },
  ],
};
const AFTER_CLICK_CONTEXT = {
  previousPage: { url: "https://duckduckgo.com/?q=jev+typesafe", title: "jev typesafe at DuckDuckGo", site: "duckduckgo" },
  recentActions: [
    { type: "navigate_url", url: "https://duckduckgo.com/?q=jev+typesafe", said: "搜索 jev typesafe", ok: true, outcome: "已打开 duckduckgo.com/?q=jev+typesafe", at: Date.now() - 25_000 },
    { type: "click_element", targetId: "e20", targetLabel: 'link "TypeSafe — Jev, the System One model"', said: "点击第一个结果", ok: true, outcome: "已打开 typesafe.ai/jev", at: Date.now() - 6_000 },
  ],
};
const ON_RESULTS_AFTER_CLICK = {
  previousPage: { url: "https://duckduckgo.com/?q=jev+typesafe", title: "jev typesafe at DuckDuckGo", site: "duckduckgo" },
  recentActions: [
    { type: "click_element", targetId: "e20", targetLabel: 'link "TypeSafe — Jev, the System One model"', said: "点击第一个结果", ok: true, outcome: "已打开 typesafe.ai/jev", at: Date.now() - 8_000 },
    { type: "go_back", said: "返回上一页", ok: true, outcome: "已打开 duckduckgo.com/?q=jev+typesafe", at: Date.now() - 3_000 },
  ],
};

CASES.push(
  { name: "上下文:打开文档", transcript: "打开文档", snapshot: PRODUCT_PAGE, context: AFTER_CLICK_CONTEXT, intent: "click_element", targetIn: ["e03", "e07"], decision: "act" },
  { name: "上下文:回到结果页", transcript: "回到搜索结果页", snapshot: PRODUCT_PAGE, context: AFTER_CLICK_CONTEXT, intent: "go_back", decision: "act" },
  { name: "上下文:纠正反转", transcript: "不,不是这个", snapshot: PRODUCT_PAGE, context: AFTER_CLICK_CONTEXT, correction: true, actionType: "go_back", decision: "act" },
  { name: "上下文:点错了撤销", transcript: "点错了,撤销", snapshot: PRODUCT_PAGE, context: AFTER_CLICK_CONTEXT, correction: true, actionType: "go_back", decision: "act" },
  { name: "上下文:换一个", transcript: "不,是另一个", snapshot: SEARCH_RESULTS, context: ON_RESULTS_AFTER_CLICK, correction: true, intent: "click_element", targetNot: "e20", decisionIn: ["act", "disambiguate"] },
  { name: "上下文:后续命令不算纠正", transcript: "往下滚一点", snapshot: PRODUCT_PAGE, context: AFTER_CLICK_CONTEXT, correction: false, intent: "scroll_down", decision: "act" },
  // fixture 里每个结果的 URL 行是紧跟标题的独立链接(e20 标题、e21 url、e22 第二个标题),
  // 所以"第二个结果"在元素层面真有歧义;两个都接受。
  { name: "上下文:返回后的第二个结果", transcript: "点击第二个结果", snapshot: SEARCH_RESULTS, context: ON_RESULTS_AFTER_CLICK, intent: "click_element", targetIn: ["e21", "e22"], decision: "act" },
);

const results = [];

before(() => {
  if (!hasApiKey()) console.log("跳过:未设置 TYPESAFE_API_KEY / JEV_API_KEY");
});

for (const c of CASES) {
  test(`jev: ${c.name} — "${c.transcript}"`, { skip: !hasApiKey() }, async () => {
    const snapshot = typeof c.snapshot === "string" ? fixture(c.snapshot) : c.snapshot;
    const r = await decide({ transcript: c.transcript, snapshot, context: c.context ?? null });
    const policy = evaluatePolicy({ answers: r.answers, candidates: r.candidates, snapshot, isFinal: c.final !== false, context: c.context ?? null });
    const a = r.answers;
    const failures = [];
    if (c.intent && a.intent.choice !== c.intent) failures.push(`intent ${a.intent.choice} != ${c.intent} (conf ${a.intent.confidence.toFixed(2)})`);
    if (c.target && a.target.choice !== c.target) failures.push(`target ${a.target.choice} != ${c.target} (conf ${a.target.confidence.toFixed(2)})`);
    if (c.targetIn && !c.targetIn.includes(policy.action?.targetId ?? a.target.choice)) failures.push(`target ${policy.action?.targetId ?? a.target.choice} not in ${c.targetIn}`);
    if (c.targetNot && policy.action?.targetId === c.targetNot) failures.push(`target ${policy.action.targetId} should not be ${c.targetNot}`);
    if (c.correction === true && (a.is_correction?.noul ?? 0) < 0.6) failures.push(`is_correction ${(a.is_correction?.noul ?? 0).toFixed(2)} < 0.6`);
    if (c.correction === false && (a.is_correction?.noul ?? 0) >= 0.6) failures.push(`is_correction ${(a.is_correction?.noul ?? 0).toFixed(2)} >= 0.6`);
    if (c.actionType && policy.action?.type !== c.actionType) failures.push(`action ${policy.action?.type} != ${c.actionType}`);
    if (c.decision && policy.decision !== c.decision) failures.push(`decision ${policy.decision} != ${c.decision} (${policy.summary})`);
    if (c.decisionIn && !c.decisionIn.includes(policy.decision)) failures.push(`decision ${policy.decision} not in ${c.decisionIn} (${policy.summary})`);
    if (c.text && policy.action?.text !== c.text && policy.action?.query !== c.text) failures.push(`text ${JSON.stringify(policy.action?.text ?? policy.action?.query)} != ${JSON.stringify(c.text)}`);
    if (c.url && !(policy.action?.url || "").includes(c.url)) failures.push(`url ${policy.action?.url} !~ ${c.url}`);
    if (c.amount && policy.action?.amount !== c.amount) failures.push(`amount ${policy.action?.amount} != ${c.amount}`);

    results.push({ name: c.name, ok: failures.length === 0, latency: r.latencyMs, tokens: r.usage.input_tokens, failures });
    console.log(
      `  ${failures.length ? "✗" : "✓"} ${c.name.padEnd(26)} ${String(r.latencyMs).padStart(4)}ms ${String(r.usage.input_tokens).padStart(5)}tok  intent=${a.intent.choice}(${a.intent.confidence.toFixed(2)}) target=${a.target.choice}(${a.target.confidence.toFixed(2)}) complete=${a.complete.noul.toFixed(2)} cmd=${a.is_command.noul.toFixed(2)} destr=${a.destructive.noul.toFixed(2)} → ${policy.decision}${failures.length ? "\n      " + failures.join("; ") : ""}`,
    );
    assert.deepEqual(failures, [], failures.join("; "));
  });
}

test("integration pass-rate report", { skip: !hasApiKey() }, () => {
  const passed = results.filter((r) => r.ok).length;
  const lat = results.map((r) => r.latency).sort((a, b) => a - b);
  const p50 = lat[Math.floor(lat.length / 2)];
  const avg = Math.round(lat.reduce((a, b) => a + b, 0) / lat.length);
  const tokens = results.reduce((a, r) => a + r.tokens, 0);
  const rate = passed / results.length;
  console.log(`\n  ${MODEL}: ${passed}/${results.length} 个用例通过(${(rate * 100).toFixed(1)}%) · 延迟 avg ${avg} ms,p50 ${p50} ms,max ${lat[lat.length - 1]} ms · 共 ${tokens} 输入 tokens($${((tokens / 1e6) * 0.042).toFixed(5)})\n`);
  assert.ok(rate >= 0.9, `通过率 ${(rate * 100).toFixed(1)}% 低于 90%`);
});
