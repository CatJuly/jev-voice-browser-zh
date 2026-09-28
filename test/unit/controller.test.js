/**
 * Controller 流程测试(mock Jev + 假浏览器):防抖、一息一个动作、
 * 过期请求取消、按编号选候选、一口气连发多条命令。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Controller } from "../../src/controller.js";
import { DEBOUNCE_MS } from "../../src/constants.js";
import { wordCount } from "../../src/spans.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeBrowser() {
  return {
    url: "https://example.com/",
    onChange() {
      return () => {};
    },
    tabInfo() {
      return [{ index: 0, url: this.url, active: true }];
    },
    async snapshot() {
      return {
        url: this.url,
        title: "Example",
        site: "example_com",
        searchBoxId: null,
        elements: [
          { id: "e01", role: "link", text: "More information" },
          { id: "e02", role: "link", text: "Other link" },
        ],
        tabs: this.tabInfo(),
      };
    },
    overlayCalls: [],
    async overlay(fn, ...args) {
      this.overlayCalls.push([fn, ...args]);
    },
  };
}

/** Mock Jev:关键词路由的答案,延迟可配。complete 判定用 wordCount(汉字逐字计)。 */
function mockDecide({ latency = 20, complete = (t) => (wordCount(t) >= 2 ? 0.9 : 0.1) } = {}) {
  const calls = [];
  const fn = async ({ transcript }, { signal } = {}) => {
    calls.push(transcript);
    await sleep(latency);
    if (signal?.aborted) {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }
    const t = transcript.toLowerCase();
    const ch = (c, conf = 0.95, extra = {}) => ({ type: "choice", choice: c, confidence: conf, probabilities: { [c]: conf, ...extra } });
    let intent = ch("none", 0.9);
    let target = ch("none", 0.9);
    if (t.startsWith("返")) intent = ch("go_back");
    else if (t.startsWith("往")) intent = ch("scroll_down");
    else if (t.startsWith("点击模糊")) {
      intent = ch("click_element");
      target = ch("e01", 0.2, { e02: 0.4, none: 0.2 });
    } else if (t.startsWith("点击")) {
      intent = ch("click_element");
      target = ch("e01", 0.95);
    }
    return {
      answers: {
        intent,
        target,
        site: ch("none"),
        complete: { noul: complete(t) },
        is_command: { noul: intent.choice === "none" ? 0.1 : 0.95 },
        destructive: { noul: 0.02 },
        scroll_amount: { score: 1, confidence: 0.9, probabilities: {} },
        tab_direction: ch("none"),
      },
      latencyMs: latency,
      usage: { input_tokens: 1000, output_tokens: 10 },
      costUsd: 0.000042,
      model: "jev-1.13.0",
      requestId: "req",
      candidates: { text: [], url: [] },
      state: {},
      questionCount: 8,
    };
  };
  fn.calls = calls;
  return fn;
}

function setup(opts = {}) {
  const browser = fakeBrowser();
  const executed = [];
  const decideFn = mockDecide(opts);
  const executeFn = async (action) => {
    executed.push(action);
    await sleep(opts.execMs ?? 10);
    return { ok: true, detail: "ok" };
  };
  const c = new Controller({ browser, decideFn, executeFn });
  return { c, browser, executed, decideFn };
}

test("防抖:partial 合并为一次请求,一息一个动作", async () => {
  const { c, executed, decideFn } = setup();
  await c.start();
  c.handleTranscript({ text: "返", final: false, utteranceId: "u1" });
  await sleep(50);
  c.handleTranscript({ text: "返回上一页", final: false, utteranceId: "u1" });
  await sleep(DEBOUNCE_MS + 150);
  assert.equal(executed.length, 1);
  assert.equal(executed[0].type, "go_back");
  assert.equal(decideFn.calls.length, 1, "第一个 partial 被防抖合并掉");
  // 同一语句的剩余部分被忽略
  c.handleTranscript({ text: "返回上一页了", final: true, utteranceId: "u1" });
  await sleep(DEBOUNCE_MS + 100);
  assert.equal(executed.length, 1);
  assert.equal(c.uiState().stats.calls, 1);
  assert.ok(c.uiState().stats.costUsd > 0);
  await c.close();
});

test("不完整的 partial 等待;识别器标记 final 后执行", async () => {
  const { c, executed } = setup();
  await c.start();
  c.handleTranscript({ text: "往", final: false, utteranceId: "u2" });
  await sleep(DEBOUNCE_MS + 100);
  assert.equal(executed.length, 0);
  assert.equal(c.lastDecision.policy.decision, "wait");
  c.handleTranscript({ text: "往下滚", final: true, utteranceId: "u2" });
  await sleep(150);
  assert.equal(executed.length, 1);
  assert.equal(executed[0].type, "scroll_down");
  await c.close();
});

test("取消超过 MAX_INFLIGHT 的过期在途请求", async () => {
  const { c, executed, decideFn } = setup({ latency: 400 });
  await c.start();
  c.handleTranscript({ text: "返", final: false, utteranceId: "u3" });
  await sleep(DEBOUNCE_MS + 20);
  c.handleTranscript({ text: "返回", final: false, utteranceId: "u3" });
  await sleep(DEBOUNCE_MS + 20);
  c.handleTranscript({ text: "返回上一页", final: false, utteranceId: "u3" });
  await sleep(DEBOUNCE_MS + 20);
  assert.equal(c.inflight.length, 2, "最旧的请求已中止,两个在途");
  await sleep(600);
  assert.equal(executed.length, 1);
  assert.equal(decideFn.calls.length, 3);
  await c.close();
});

test("目标含糊时显示编号候选;口说编号直接选取,不调模型", async () => {
  const { c, executed, browser, decideFn } = setup();
  await c.start();
  c.handleTranscript({ text: "点击模糊的东西", final: true, utteranceId: "u4" });
  await sleep(150);
  assert.equal(executed.length, 0);
  assert.ok(c.candidates, "候选待定");
  assert.deepEqual(
    c.candidates.list.map((x) => x.id),
    ["e02", "e01"],
  );
  assert.ok(browser.overlayCalls.some(([fn]) => fn === "candidates"));
  const callsBefore = decideFn.calls.length;
  c.handleTranscript({ text: "第二个", final: true, utteranceId: "u5" });
  await sleep(100);
  assert.equal(executed.length, 1);
  assert.equal(executed[0].targetId, "e01");
  assert.equal(decideFn.calls.length, callsBefore, "编号选取不调 Jev");
  await c.close();
});

test("一口气连发:已执行命令之后的字成为新命令;单个尾字被忽略", async () => {
  const { c, executed } = setup();
  await c.start();
  c.handleTranscript({ text: "返回上一页", final: false, utteranceId: "u6" });
  await sleep(DEBOUNCE_MS + 150);
  assert.equal(executed.length, 1);
  c.handleTranscript({ text: "返回上一页往下滚", final: false, utteranceId: "u6" });
  await sleep(DEBOUNCE_MS + 150);
  assert.equal(executed.length, 2);
  assert.equal(executed[1].type, "scroll_down");
  // 残留"了"(wordCount=1)被忽略
  c.handleTranscript({ text: "返回上一页往下滚了", final: true, utteranceId: "u6" });
  await sleep(DEBOUNCE_MS + 150);
  assert.equal(executed.length, 2);
  await c.close();
});

test("键入命令按最终语句处理", async () => {
  const { c, executed } = setup();
  await c.start();
  c.handleCommand("返回上一页");
  await sleep(150);
  assert.equal(executed.length, 1);
  await c.close();
});
