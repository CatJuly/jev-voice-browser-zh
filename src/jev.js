/**
 * 每次转写更新对应的一个 Jev 请求:构建 state + 投机式问题扇出,
 * 调用 API,返回带延迟 / 用量 / 成本的类型化答案。
 *
 * API key 只留在服务端。读 TYPESAFE_API_KEY,回退到 JEV_API_KEY。
 */
import { TypeSafeClient, choice, noul, score, APIUserAbortError } from "@typesafe-ai/sdk";
import { MODEL, PRICE_PER_M_INPUT_TOKENS_USD, QUESTIONS, MAX_TRANSCRIPT_CHARS, MAX_CONTEXT_ACTIONS } from "./constants.js";
import { extractTextCandidates, extractUrlCandidates } from "./spans.js";

let _client = null;

export function getClient() {
  if (_client) return _client;
  const apiKey = process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY;
  if (!apiKey) {
    throw new Error("缺少 API key:请设置 TYPESAFE_API_KEY(或 JEV_API_KEY)。参见 run.sh / .env.example。");
  }
  _client = new TypeSafeClient({
    apiKey,
    defaultModel: MODEL,
    timeout: 8000,
    retry: { maxRetries: 1, backoffInitialMs: 150, backoffMaxMs: 600 },
    logLevel: "off",
  });
  return _client;
}

export function hasApiKey() {
  return Boolean(process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY);
}

export function costUsd(usage) {
  const tokens = usage?.input_tokens ?? 0;
  return (tokens / 1_000_000) * PRICE_PER_M_INPUT_TOKENS_USD;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** `e09 link "GitHub - typesafe-ai" → github.com` —— 短小、可读、省 token。 */
export function encodeElement(el, pageHost = "") {
  let s = `${el.id} ${el.role}`;
  const text = el.text || "";
  if (text) s += ` "${text}"`;
  if (el.placeholder && el.placeholder !== text) s += ` (placeholder: ${el.placeholder})`;
  if (el.href) {
    const host = el.href.split("/")[0];
    if (host && host !== pageHost) s += ` → ${host}`;
  }
  if (el.below_fold) s += " [below fold]";
  return s;
}

/**
 * 为一次决策构建 state 对象与问题表。
 * 导出以便测试精确检查 Jev 看到的东西。
 */
/**
 * 精简的会话上下文:用户刚从哪来、最近几个已执行的动作(最近的在前)。
 * 什么都没发生过时为 `null`。
 */
export function encodeContext(context) {
  if (!context) return null;
  const out = {};
  if (context.previousPage?.url) {
    out.previous_page = {
      url: String(context.previousPage.url).slice(0, 200),
      title: String(context.previousPage.title || "").slice(0, 120),
    };
  }
  const actions = (context.recentActions || []).slice(-MAX_CONTEXT_ACTIONS).reverse();
  if (actions.length) {
    const now = Date.now();
    out.recent_actions = actions.map((a) => {
      const e = { said: String(a.said || "").slice(0, 120), action: a.type };
      if (a.targetLabel) e.target = String(a.targetLabel).slice(0, 80);
      if (a.text) e.text = String(a.text).slice(0, 80);
      if (a.url) e.url = String(a.url).slice(0, 200);
      e.outcome = a.outcome || (a.ok === false ? "failed" : "done");
      if (a.at) e.seconds_ago = Math.max(0, Math.round((now - a.at) / 1000));
      return e;
    });
  }
  return Object.keys(out).length ? out : null;
}

export function buildRequest({ transcript, snapshot, pendingConfirmation = null, tabs = null, context = null }) {
  const text = String(transcript || "").slice(-MAX_TRANSCRIPT_CHARS);
  const textCandidates = extractTextCandidates(text);
  const urlCandidates = extractUrlCandidates(text);

  const elements = snapshot?.elements || [];
  const pageHost = hostOf(snapshot?.url);
  const state = {
    transcript: text,
    page: {
      url: (snapshot?.url || "about:blank").slice(0, 200),
      title: (snapshot?.title || "").slice(0, 120),
      site: snapshot?.site || "blank",
    },
    // 每个元素一行精简描述,按视觉顺序(视口优先)。`target` 问题的选项就是这些 id;
    // 文字放在这里(语义查找模式),token 用量减半。
    elements: elements.map((el) => encodeElement(el, pageHost)),
  };
  const ctx = encodeContext(context);
  if (ctx) state.context = ctx;
  if (pendingConfirmation) state.pending_confirmation = pendingConfirmation;
  if (tabs && tabs.length > 1) state.open_tabs = tabs.length;

  const targetCriteria = {};
  for (const el of elements) targetCriteria[el.id] = null;
  targetCriteria.none = "No element on this page is referred to";

  const questions = {
    intent: choice(QUESTIONS.intent.instructions, QUESTIONS.intent.criteria),
    target: choice(QUESTIONS.target.instructions, targetCriteria),
    site: choice(QUESTIONS.site.instructions, QUESTIONS.site.criteria),
    complete: noul(QUESTIONS.complete.instructions, QUESTIONS.complete.criteria),
    is_command: noul(QUESTIONS.is_command.instructions, QUESTIONS.is_command.criteria),
    destructive: noul(QUESTIONS.destructive.instructions, QUESTIONS.destructive.criteria),
    scroll_amount: score(QUESTIONS.scroll_amount.instructions, QUESTIONS.scroll_amount.criteria),
    tab_direction: choice(QUESTIONS.tab_direction.instructions, QUESTIONS.tab_direction.criteria),
  };
  if (ctx?.recent_actions?.length) {
    questions.is_correction = noul(QUESTIONS.is_correction.instructions, QUESTIONS.is_correction.criteria);
  }

  if (textCandidates.length) {
    const c = Object.fromEntries(textCandidates.map((s) => [s, null]));
    c.none = "Nothing should be typed or searched";
    questions.text_span = choice(QUESTIONS.text_span.instructions, c);
  }
  if (urlCandidates.length) {
    const c = Object.fromEntries(urlCandidates.map((s) => [s, null]));
    c.none = "No web address is mentioned";
    questions.url_span = choice(QUESTIONS.url_span.instructions, c);
  }

  return { state, questions, candidates: { text: textCandidates, url: urlCandidates } };
}

/**
 * 询问 Jev。resolve 为 { answers, latencyMs, usage, costUsd, model, requestId, candidates, state },
 * `signal` 中止时(来了更新的转写)以 APIUserAbortError reject。
 */
export async function decide(input, { signal } = {}) {
  const client = getClient();
  const { state, questions, candidates } = buildRequest(input);
  const t0 = performance.now();
  const { data, requestId } = await client
    .systemOne({ state, questions, model: MODEL }, { signal })
    .withResponse();
  const latencyMs = Math.round(performance.now() - t0);
  return {
    answers: data.answers,
    latencyMs,
    usage: data.usage,
    costUsd: costUsd(data.usage),
    model: data.model,
    requestId,
    candidates,
    state,
    questionCount: Object.keys(questions).length,
  };
}

export function isAbortError(err) {
  return err instanceof APIUserAbortError || err?.name === "AbortError" || err?.name === "APIUserAbortError";
}
