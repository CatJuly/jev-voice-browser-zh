import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractTextCandidates,
  extractUrlCandidates,
  normalizeSpokenUrl,
  parseCandidatePick,
  toHttpUrl,
  cleanTranscript,
  wordCount,
  smartJoin,
  splitSay,
} from "../../src/spans.js";

test("文本候选:动词之后的载荷排最前,整句兜底", () => {
  const c = extractTextCandidates("在搜索框里输入你好世界");
  assert.equal(c[0], "你好世界");
  assert.ok(c.includes("在搜索框里输入你好世界"), "整句始终是兜底候选");
});

test("文本候选:尾部目的地被剥离,剥离前的原串保留", () => {
  const c = extractTextCandidates("输入你好世界到搜索框");
  assert.equal(c[0], "你好世界");
  assert.ok(c.includes("你好世界到搜索框"));
});

test("文本候选:把字句的载荷在动词之前", () => {
  const c = extractTextCandidates("把你好世界输入到搜索框");
  assert.equal(c[0], "你好世界");
  assert.ok(c.includes("把你好世界输入到搜索框"));
});

test("文本候选:引号片段优先于把字句", () => {
  assert.equal(extractTextCandidates('把"早上好"填进评论框')[0], "早上好");
});

test("文本候选:动词轻量后缀、填充词前缀、站点名前缀", () => {
  assert.equal(extractTextCandidates("帮我搜一下艾伦图灵")[0], "艾伦图灵");
  assert.equal(extractTextCandidates("查一下天气")[0], "天气");
  assert.equal(extractTextCandidates("搜索维基百科上的猫")[0], "猫");
});

test("文本候选:无动词时只有整句兜底;空串为空", () => {
  assert.deepEqual(extractTextCandidates("往下滚"), ["往下滚"]);
  assert.deepEqual(extractTextCandidates(""), []);
});

test("文本候选:去重且上限 8 个", () => {
  const c = extractTextCandidates("搜索搜索搜索甲乙丙丁戊己庚辛壬");
  assert.equal(new Set(c.map((s) => s.toLowerCase())).size, c.length);
  assert.ok(c.length <= 8);
});

test("cleanTranscript 删除汉字邻接空格,保留拉丁词间空格", () => {
  assert.equal(cleanTranscript("打开 维基 百科"), "打开维基百科");
  assert.equal(cleanTranscript("搜索 alan turing"), "搜索 alan turing");
});

test("口播域名:'点'仅在 ASCII 邻接时转为点号", () => {
  assert.equal(normalizeSpokenUrl("打开 example 点 com"), "打开 example.com");
  assert.deepEqual(extractUrlCandidates("打开 news 点 ycombinator 点 com"), ["news.ycombinator.com"]);
  assert.deepEqual(extractUrlCandidates("访问 https://docs.typesafe.ai/models"), ["https://docs.typesafe.ai/models"]);
  assert.deepEqual(extractUrlCandidates("明天九点开会"), [], "汉字'点'不误转");
  assert.deepEqual(extractUrlCandidates("下午三点开会"), []);
});

test("toHttpUrl 补 https 前缀", () => {
  assert.equal(toHttpUrl("example.com"), "https://example.com");
  assert.equal(toHttpUrl("http://a.b"), "http://a.b");
});

test("编号候选选取:纯数字表达", () => {
  assert.equal(parseCandidatePick("二"), 2);
  assert.equal(parseCandidatePick("两"), 2);
  assert.equal(parseCandidatePick("第二个"), 2);
  assert.equal(parseCandidatePick("第2个"), 2);
  assert.equal(parseCandidatePick("数字三"), 3);
  assert.equal(parseCandidatePick("选第二个"), 2);
  assert.equal(parseCandidatePick("2"), 2);
  assert.equal(parseCandidatePick("那个第三个"), 3);
});

test("编号候选选取:非纯数字表达拒绝", () => {
  assert.equal(parseCandidatePick("四", 3), null, "超出候选数");
  assert.equal(parseCandidatePick("点到搜索框"), null);
  assert.equal(parseCandidatePick("打开维基百科"), null);
  assert.equal(parseCandidatePick("随便点一个链接"), null);
  assert.equal(parseCandidatePick(""), null);
});

test("wordCount:汉字逐字计,拉丁按词计", () => {
  assert.equal(wordCount("搜索艾伦图灵"), 6);
  assert.equal(wordCount("嗯"), 1);
  assert.equal(wordCount("go back"), 2);
  assert.equal(wordCount("打开 hacker news"), 4);
  assert.equal(wordCount(""), 0);
});

test("smartJoin:仅 ASCII 词字符邻接时补空格", () => {
  assert.equal(smartJoin("搜索", "艾伦图灵"), "搜索艾伦图灵");
  assert.equal(smartJoin("go", "back"), "go back");
  assert.equal(smartJoin("", "x"), "x");
});

test("splitSay:汉字按 2-3 字切块,拉丁按词", () => {
  assert.deepEqual(splitSay("打开维基百科"), ["打开维", "基百科"]);
  assert.deepEqual(splitSay("搜索 alan turing"), ["搜索", "alan", "turing"]);
  assert.deepEqual(splitSay("往下滚"), ["往下滚"]);
});
