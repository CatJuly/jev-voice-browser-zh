import { test } from "node:test";
import assert from "node:assert/strict";
import { compactElements, detectSite, findSearchBox, approxTokens } from "../../src/snapshot.js";
import { buildRequest, encodeElement } from "../../src/jev.js";
import { MAX_ELEMENTS, MAX_STATE_CHARS } from "../../src/constants.js";

const raw = (i, over = {}) => ({
  id: `e${String(i).padStart(2, "0")}`,
  tag: "a",
  role: "link",
  text: `Link number ${i}`,
  placeholder: "",
  href: `example.com/${i}`,
  type: "",
  inputName: "",
  inViewport: i % 2 === 0,
  top: i * 20,
  left: 0,
  ...over,
});

test("compactElements: viewport-visible first, then by position", () => {
  const els = [raw(1, { inViewport: false, top: 10 }), raw(2, { inViewport: true, top: 500 }), raw(3, { inViewport: true, top: 100 })];
  const out = compactElements(els);
  assert.deepEqual(
    out.map((e) => e.id),
    ["e03", "e02", "e01"],
  );
  assert.equal(out[2].below_fold, true);
  assert.equal(out[0].below_fold, undefined);
});

test("compactElements: dedupes identical (role, text, href) and drops nameless non-inputs", () => {
  const els = [raw(1), raw(2, { text: "Link number 1", href: "example.com/1" }), raw(3, { text: "", href: "" }), raw(4, { role: "textbox", tag: "input", text: "", placeholder: "" })];
  const out = compactElements(els);
  assert.deepEqual(
    out.map((e) => e.id),
    ["e02", "e04"], // in-viewport (even ids) first, by position; e01 duplicates e02 (seen first); e03 nameless link removed
  );
});

test("compactElements: truncates long text and caps count", () => {
  const els = Array.from({ length: 400 }, (_, i) => raw(i + 1, { text: "x".repeat(300) + i }));
  const out = compactElements(els);
  assert.ok(out.length <= MAX_ELEMENTS);
  assert.ok(out.every((e) => e.text.length <= 60));
});

test("compactElements: state size guard keeps the serialized list under budget", () => {
  const els = Array.from({ length: 250 }, (_, i) => raw(i + 1, { text: `Unique headline ${i} ` + "lorem ipsum dolor ".repeat(3), href: `site${i}.example.com/path/${i}` }));
  const out = compactElements(els, { maxChars: 3000 });
  assert.ok(JSON.stringify(out).length <= 3000, "shrunk to fit");
  assert.ok(out.length >= 5);
});

test("buildRequest: full state stays far below the 32k-token limit even with the max element list", () => {
  const els = Array.from({ length: 400 }, (_, i) => raw(i + 1, { text: `Some fairly long link label number ${i} about a topic`, href: `news.example.com/story/${i}` }));
  const snapshot = { url: "https://news.example.com/", title: "News", site: "generic", elements: compactElements(els) };
  const { state, questions } = buildRequest({ transcript: "点击第一条新闻", snapshot });
  assert.ok(JSON.stringify(state).length <= MAX_STATE_CHARS);
  assert.ok(approxTokens(state) < 8000, `state ~${approxTokens(state)} tokens`);
  assert.ok(Object.keys(questions.target.criteria).length <= MAX_ELEMENTS + 1);
  assert.equal(questions.target.criteria.none !== undefined, true);
  assert.equal(state.elements.length, snapshot.elements.length);
  assert.ok(state.elements[0].startsWith("e02 link"), state.elements[0]);
});

test("buildRequest: text_span / url_span only present when there are candidates; options are verbatim", () => {
  const snapshot = { url: "about:blank", title: "", site: "blank", elements: [] };
  const a = buildRequest({ transcript: "往下滚", snapshot });
  assert.equal(a.questions.url_span, undefined);
  const b = buildRequest({ transcript: "在搜索框里输入你好世界", snapshot });
  assert.ok("你好世界" in b.questions.text_span.criteria);
  assert.ok("none" in b.questions.text_span.criteria);
  const c = buildRequest({ transcript: "打开 example 点 com", snapshot });
  assert.ok("example.com" in c.questions.url_span.criteria);
});

test("encodeElement: compact line with host only when it differs from the page", () => {
  assert.equal(encodeElement({ id: "e09", role: "link", text: "GitHub 文档", href: "github.com/x" }, "duckduckgo.com"), 'e09 link "GitHub 文档" → github.com');
  assert.equal(encodeElement({ id: "e03", role: "link", text: "new", href: "news.ycombinator.com/newest" }, "news.ycombinator.com"), 'e03 link "new"');
  assert.equal(encodeElement({ id: "e02", role: "textbox", text: "", placeholder: "搜索维基百科" }), "e02 textbox (placeholder: 搜索维基百科)");
});

test("detectSite", () => {
  assert.equal(detectSite("https://en.wikipedia.org/wiki/Main_Page"), "wikipedia");
  assert.equal(detectSite("https://news.ycombinator.com/newest"), "hacker_news");
  assert.equal(detectSite("https://www.google.com/search?q=x"), "google");
  assert.equal(detectSite("https://example.com/"), "example_com");
  assert.equal(detectSite("https://foo.bar.baz/"), "generic");
  assert.equal(detectSite("about:blank"), "blank");
  assert.equal(detectSite("https://www.baidu.com/s?wd=x"), "baidu");
  assert.equal(detectSite("https://search.bilibili.com/all?keyword=x"), "bilibili");
  assert.equal(detectSite("https://www.zhihu.com/search?type=content&q=x"), "zhihu");
});

test("findSearchBox prefers role=searchbox / search-ish names / Chinese placeholders", () => {
  const els = [
    raw(1, { role: "textbox", tag: "input", inputName: "username", text: "", placeholder: "用户名" }),
    raw(2, { role: "textbox", tag: "input", inputName: "search", text: "", placeholder: "搜索维基百科" }),
    raw(3, { role: "link" }),
  ];
  assert.equal(findSearchBox(els), "e02");
  // 百度风格:name=wd + 中文占位符
  const baidu = [
    raw(1, { role: "textbox", tag: "input", inputName: "wd", text: "", placeholder: "搜索" }),
  ];
  assert.equal(findSearchBox(baidu), "e01");
  assert.equal(findSearchBox([raw(3)]), null);
});
