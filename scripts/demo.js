#!/usr/bin/env node
/**
 * 无麦克风的演示 / 端到端测试。
 *
 * 把脚本化的命令逐块回放(汉字按 2-3 字一块,拉丁按词,模拟中间转写),
 * 走与线上服务器完全相同的 Controller,对着真实网站执行,并断言结果 URL /
 * 页面状态。打印每步的 Jev 延迟,以及浏览器在第几块就提前执行了。
 *
 *   npm run demo            # 有头(看得见)
 *   npm run demo:ci         # 无头,失败时以非零码退出
 *   node scripts/demo.js --headless --word-ms 250 --only 1,2,3
 */
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserManager } from "../src/browser.js";
import { Controller } from "../src/controller.js";
import { hasApiKey } from "../src/jev.js";
import { MODEL } from "../src/constants.js";
import { splitSay, smartJoin } from "../src/spans.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  if (i < 0) return dflt;
  return args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true;
};
const HEADLESS = args.includes("--headless") || process.env.CI === "1" || process.env.CI === "true";
const WORD_MS = Number(flag("--word-ms", HEADLESS ? 280 : 380));
const ONLY = flag("--only", null) ? String(flag("--only")).split(",").map(Number) : null;

if (!hasApiKey()) {
  console.error("缺少 TYPESAFE_API_KEY(或 JEV_API_KEY)。请通过 ./run.sh 运行,或先导出环境变量。");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 10000, every = 150 } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await fn();
    if (last) return last;
    await sleep(every);
  }
  return last;
}

const url = (b) => b.page?.url() || "";
const decodedUrl = (b) => {
  try {
    return decodeURIComponent(url(b));
  } catch {
    return url(b);
  }
};
const scrollY = (b) => b.page.evaluate(() => Math.round(window.scrollY)).catch(() => 0);

/** 脚本化演示。`expect` 在步骤成功时返回真值。 */
const STEPS = [
  { say: "打开维基百科", expect: (b) => url(b).includes("wikipedia.org") },
  { say: "搜索艾伦图灵", expect: (b) => /Alan_Turing|艾伦/.test(decodedUrl(b)) },
  { say: "往下滚一点", expect: async (b) => (await scrollY(b)) > 50 },
  { say: "滚到页面底部", expect: async (b) => (await scrollY(b)) > 2000 },
  { say: "往上滚一页", expect: async (b) => (await scrollY(b)) < 900_000 }, // 只要执行了就算
  { say: "返回上一页", expect: (b) => url(b).includes("wikipedia.org") && !/艾伦|Alan_Turing/.test(decodedUrl(b)) },
  { say: "打开 example 点 com", expect: (b) => url(b).includes("example.com") },
  { say: "点击 more information 链接", expect: (b) => url(b).includes("iana.org") },
  { say: "打开 hacker news", expect: (b) => url(b).includes("news.ycombinator.com") },
  { say: "点击 new 链接", expect: (b) => url(b).includes("news.ycombinator.com/newest") },
  {
    say: "随便点一个链接",
    // 故意含糊:要么 Jev 有把握直接点,要么显示编号候选,我们用编号回答。
    followUpOnCandidates: "第一个",
    expect: (b) => !/news\.ycombinator\.com\/newest$/.test(url(b)),
  },
  { say: "在 duckduckgo 上搜索 typesafe jev", expect: (b) => /duckduckgo\.com\/\?q=typesafe(%20|\+)jev/.test(url(b)) },
  { say: "打开一个新标签页", expect: (b) => b.pages.length === 2 },
  { say: "关闭这个标签页", expect: (b) => b.pages.length === 1 },
  // 一口气两条命令:第一条一说完就执行,剩余的字成为新命令。
  { say: "打开 example 点 com 然后点击 more information 链接", expect: (b) => url(b).includes("iana.org"), multi: true },
  { say: "对了我们中午吃什么", expectNoAction: true, expect: () => true },
];

async function main() {
  const profileDir = HEADLESS ? fs.mkdtempSync(path.join(os.tmpdir(), "vb-demo-")) : path.join(__dirname, "..", ".browser-profile-demo");
  const browser = new BrowserManager();
  await browser.launch({ headless: HEADLESS, profileDir, startUrl: "about:blank" });
  const controller = new Controller({ browser });
  if (process.env.VB_DEBUG) controller.on("log", (e) => console.error(`    [${e.level}] ${e.msg}`));
  await controller.start();

  console.log(`\njev-voice-browser-zh 演示 · 模型 ${MODEL} · ${HEADLESS ? "无头" : "有头"} · 每块 ${WORD_MS}ms\n`);

  const results = [];
  let stepNo = 0;
  for (const step of STEPS) {
    stepNo += 1;
    if (ONLY && !ONLY.includes(stepNo)) continue;
    const res = await runStep(step, stepNo, controller, browser);
    results.push(res);
    await sleep(500);
  }

  // ---- 汇总
  console.log("\n" + "─".repeat(100));
  console.log("步骤  结果   执行@块   jev(ms)  词→决策(ms)  词→完成(ms)  语句");
  for (const r of results) {
    console.log(
      `${String(r.no).padStart(3)}   ${r.ok ? " PASS " : " FAIL "}  ${String(r.actedAt ?? "-").padStart(9)}  ${String(r.latency ?? "-").padStart(7)}  ${String(r.cmdToDecide ?? "-").padStart(17)}  ${String(r.cmdToAct ?? "-").padStart(13)}  "${r.say}"${r.note ? `  (${r.note})` : ""}`,
    );
  }
  const s = controller.uiState().stats;
  const passed = results.filter((r) => r.ok).length;
  const decided = results.map((r) => r.cmdToDecide).filter((x) => x != null);
  const avgDecide = decided.length ? Math.round(decided.reduce((a, b) => a + b, 0) / decided.length) : "-";
  console.log("─".repeat(100));
  console.log(
    `${passed}/${results.length} 步通过 · ${s.calls} 次 Jev 调用 · Jev 延迟 avg ${s.avgLatencyMs} ms,p50 ${s.p50LatencyMs} ms · 最后一个词→决策 avg ${avgDecide} ms · 最后一个词→动作完成 avg ${s.avgCommandToActionMs} ms(含页面加载) · ${s.inputTokens} 输入 tokens · 共 $${s.costUsd.toFixed(5)}`,
  );
  console.log("(词→决策含 200ms 防抖;执行@块 < 总块数说明浏览器在句子说完之前就动了)");

  if (!HEADLESS) {
    console.log("\n窗口保持打开 8 秒…");
    await sleep(8000);
  }
  await controller.close();
  await browser.close();
  if (HEADLESS) fs.rmSync(profileDir, { recursive: true, force: true });
  process.exit(passed === results.length ? 0 : 1);
}

/**
 * 把一句话按块作为中间转写喂给 controller;在它执行(或显示候选/请求确认)后结束,
 * 再检查期望。
 */
async function runStep(step, no, controller, browser) {
  const chunks = splitSay(step.say);
  const utteranceId = `demo-${no}`;
  let actedAt = null;
  let latency = null;
  let cmdToAct = null;
  let cmdToDecide = null;
  let candidates = null;
  let pending = null;
  let done = false;

  const onAction = (a) => {
    if (done) return;
    done = true;
    cmdToAct = a.sinceLastWordMs;
    cmdToDecide = a.decisionMs;
  };
  const onDecision = (d) => {
    if (d.policy.decision === "act") latency = d.latencyMs;
  };
  const onCandidates = (c) => (candidates = c);
  const onPending = (p) => (pending = p);
  controller.on("action", onAction);
  controller.on("decision", onDecision);
  controller.on("candidates", onCandidates);
  controller.on("pending", onPending);

  process.stdout.write(`${no}. "${step.say}" `);
  let partial = "";
  for (let i = 0; i < chunks.length; i++) {
    partial = smartJoin(partial, chunks[i]);
    if (done && !step.multi) break;
    controller.handleTranscript({ text: partial, final: false, utteranceId });
    process.stdout.write(".");
    await sleep(WORD_MS);
    if (done && actedAt == null) actedAt = `${i + 1}/${chunks.length}`;
  }
  if (!done || step.multi) {
    await sleep(300);
    // final 也发 smartJoin 拼出来的 partial(consumed 前缀就是从这些 partial 建立的,保持一致)
    controller.handleTranscript({ text: partial || step.say, final: true, utteranceId });
  }

  const outcome = await waitFor(() => done || candidates || pending, { timeout: 12000 });
  if (done && actedAt == null) actedAt = `${chunks.length}/${chunks.length}`;

  if (!done && candidates && step.followUpOnCandidates) {
    process.stdout.write(` [${candidates.length} 个候选 → 说"${step.followUpOnCandidates}"]`);
    await sleep(600);
    controller.handleTranscript({ text: step.followUpOnCandidates, final: true, utteranceId: `${utteranceId}-pick` });
    await waitFor(() => done, { timeout: 8000 });
  }

  let ok;
  let note = "";
  if (step.expectNoAction) {
    await sleep(1500);
    ok = !done && !candidates && !pending;
    note = ok ? "正确忽略" : "不该有动作";
  } else {
    ok = Boolean(await waitFor(() => step.expect(browser), { timeout: 8000 }));
    if (!outcome) note = "超时内无动作";
  }
  console.log(` ${ok ? "✓" : "✗"} ${url(browser)}${note ? ` (${note})` : ""}`);

  controller.off("action", onAction);
  controller.off("decision", onDecision);
  controller.off("candidates", onCandidates);
  controller.off("pending", onPending);
  return { no, say: step.say, ok, actedAt, latency, cmdToAct, cmdToDecide, note };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
