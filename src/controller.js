/**
 * 编排器:转写更新 → (防抖、取消过期请求) → 一次 Jev 请求 →
 * 策略 → Playwright 动作 → 新快照。为 UI / demo / 测试发出事件。
 */
import { EventEmitter } from "node:events";
import { DEBOUNCE_MS, SILENCE_COMPLETE_MS, CANDIDATE_TTL_MS, MAX_INFLIGHT, MAX_CONTEXT_ACTIONS, MODEL, T } from "./constants.js";
import { decide, isAbortError } from "./jev.js";
import { evaluatePolicy, describe } from "./policy.js";
import { execute } from "./executor.js";
import { parseCandidatePick, cleanTranscript, wordCount, smartJoin } from "./spans.js";
import { approxTokens } from "./snapshot.js";

const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

export class Controller extends EventEmitter {
  /**
   * @param {{browser: import('./browser.js').BrowserManager, decideFn?: Function, executeFn?: Function}} opts
   *   decideFn / executeFn are injectable for tests (default: real Jev + Playwright).
   */
  constructor({ browser, decideFn = decide, executeFn = execute }) {
    super();
    this.browser = browser;
    this._decide = decideFn;
    this._execute = executeFn;
    this.snapshot = null;
    this.snapshotAt = 0;
    this.utterance = null; // { id, physicalId, prefix, gen, text, final, startedAt, updatedAt, actedOn, actedText }
    this.consumed = null; // { id: physical utterance id, prefix: executed text (lowercase), gen }
    this.pending = null; // destructive action awaiting "confirm"
    this.candidates = null; // { list: [{n,id,label}], intent: {type,text}, at }
    this.lastDecision = null;
    this.debounceTimer = null;
    this.silenceTimer = null;
    this.inflight = []; // [{ac, text, at}] requests currently awaiting Jev
    this.busy = false;
    this.log = [];
    this.stats = { calls: 0, inputTokens: 0, costUsd: 0, latencies: [], actions: 0, model: MODEL, commandToActionMs: [], decisionMs: [] };
    this.history = [];
    // Conversation context sent to Jev with every request (see jev.encodeContext):
    // the page before the last navigation and the last few executed actions.
    this.context = { previousPage: null, recentActions: [] };
    browser.onChange(() => this.emit("tabs", browser.tabInfo()));
  }

  async start() {
    await this.refreshSnapshot();
    this._log("info", `就绪 — 模型 ${MODEL},${this.snapshot.url} 上有 ${this.snapshot.elements.length} 个元素`);
  }

  _log(level, msg, extra = {}) {
    const entry = { t: Date.now(), level, msg, ...extra };
    this.log.push(entry);
    if (this.log.length > 200) this.log.shift();
    this.emit("log", entry);
  }

  async refreshSnapshot() {
    this.snapshot = await this.browser.snapshot();
    this.snapshotAt = Date.now();
    this.emit("snapshot", this.snapshot);
    return this.snapshot;
  }

  /** 键入命令的兜底:表现得像一条最终语句。 */
  handleCommand(text) {
    return this.handleTranscript({ text, final: true, utteranceId: `typed-${Date.now()}` });
  }

  /**
   * Called on every partial transcript from the mic (or the demo replay).
   * @param {{text: string, final?: boolean, utteranceId: string|number}} msg
   */
  handleTranscript({ text, final = false, utteranceId }) {
    let clean = cleanTranscript(text);
    const now = Date.now();

    // 一息一个动作 —— 但用户在同一口气里继续说("打开维基百科……搜索艾伦图灵")时,
    // 已执行命令之后的字成为新的虚拟语句(id "<物理id>+<n>")。新词不足两个("了"、
    // 语气词)则忽略。词数:拉丁按词计,汉字逐字计(wordCount)。
    const consumed = this.consumed;
    let virtualId = utteranceId;
    if (consumed && consumed.id === utteranceId) {
      if (!clean.toLowerCase().startsWith(consumed.prefix)) return; // 识别器改写了已执行的字;忽略
      clean = clean.slice(consumed.prefix.length).trim();
      if (wordCount(clean) < 2) return;
      virtualId = `${utteranceId}+${consumed.gen}`;
    }

    if (!this.utterance || this.utterance.id !== virtualId) {
      this.utterance = {
        id: virtualId,
        physicalId: utteranceId,
        prefix: consumed && consumed.id === utteranceId ? consumed.prefix : "",
        gen: consumed && consumed.id === utteranceId ? consumed.gen : 0,
        text: clean,
        final,
        startedAt: now,
        updatedAt: now,
        actedOn: false,
        actedText: null,
      };
      if (virtualId !== utteranceId) this._log("debug", `同口气继续说 → 新命令 "${clean}"`);
    } else {
      if (clean === this.utterance.text && final === this.utterance.final) return;
      this.utterance.text = clean;
      this.utterance.final = final || this.utterance.final;
      this.utterance.updatedAt = now;
    }
    this.emit("transcript", { text: clean, final, utteranceId: virtualId, actedOn: this.utterance.actedOn });
    if (!clean || this.utterance.actedOn) return;

    // 确定性捷径:编号候选浮层 + 口说的编号 => 无需询问 Jev。
    if (this.candidates && now - this.candidates.at < CANDIDATE_TTL_MS) {
      const n = parseCandidatePick(clean, this.candidates.list.length);
      if (n) {
        const c = this.candidates.list[n - 1];
        this._consume(this.utterance, clean);
        this._log("info", `按编号选了第 ${n} 个(${c.label})— 无需模型调用`);
        const action = { ...this.candidates.intent, targetId: c.id, label: c.label };
        this.candidates = null;
        this._runAction(action, { via: "candidate-pick" });
        return;
      }
    }

    clearTimeout(this.debounceTimer);
    clearTimeout(this.silenceTimer);
    this.debounceTimer = setTimeout(() => this.decideNow("debounce"), final ? 0 : DEBOUNCE_MS);
  }

  /** 把本语句的 `text` 标记为已执行,同一口气里后面的字从新命令开始。前缀用 smartJoin 拼接(汉字间不加空格)。 */
  _consume(utt, text) {
    utt.actedOn = true;
    utt.actedText = text;
    this.consumed = {
      id: utt.physicalId,
      prefix: smartJoin(utt.prefix, text).toLowerCase(),
      gen: (utt.gen || 0) + 1,
    };
  }

  /** 就当前语句询问 Jev。取消所有在途请求。 */
  async decideNow(trigger = "manual") {
    const utt = this.utterance;
    if (!utt || !utt.text || utt.actedOn) return;
    if (this.busy) {
      // 有动作正在执行;结束后重新评估。
      this.silenceTimer = setTimeout(() => this.decideNow("after-action"), 150);
      return;
    }
    // 允许最多 MAX_INFLIGHT 个重叠请求(上一个 partial 的请求可能仍有用 ——
    // 词语已经确定指向动作时可以直接执行)。更旧的过期,用 AbortSignal 取消。
    while (this.inflight.length >= MAX_INFLIGHT) {
      const old = this.inflight.shift();
      old.ac.abort();
    }
    const ac = new AbortController();
    const req = { ac, text: utt.text, at: Date.now() };
    this.inflight.push(req);

    if (Date.now() - this.snapshotAt > 1500) await this.refreshSnapshot();

    const textAtRequest = utt.text;
    let result;
    try {
      result = await this._decide(
        {
          transcript: textAtRequest,
          snapshot: this.snapshot,
          pendingConfirmation: this.pending ? describe(this.pending) : null,
          tabs: this.browser.tabInfo(),
          context: this.context,
        },
        { signal: ac.signal },
      );
    } catch (err) {
      this.inflight = this.inflight.filter((r) => r !== req);
      if (isAbortError(err) || ac.signal.aborted) {
        this._log("debug", `已取消过期的请求 "${textAtRequest}"`);
        return;
      }
      this._log("error", `Jev 错误:${err.message || err}`);
      this.emit("error", err);
      return;
    }
    this.inflight = this.inflight.filter((r) => r !== req);
    if (ac.signal.aborted || this.utterance !== utt || utt.actedOn) return;

    this.stats.calls += 1;
    this.stats.inputTokens += result.usage?.input_tokens ?? 0;
    this.stats.costUsd += result.costUsd;
    this.stats.latencies.push(result.latencyMs);
    if (this.stats.latencies.length > 200) this.stats.latencies.shift();
    if (result.model && result.model !== this.stats.model) this.stats.model = result.model;

    // 请求在途时又来了新词的话,它的转写只是真实转写的前缀:仍可对闭集意图执行
    // (词语已经确定指向"返回上一页"),但绝不能当作 final/沉默 —— 自由文本载荷会被截断。
    const stale = utt.text !== textAtRequest;
    const silentMs = stale ? 0 : Date.now() - utt.updatedAt;
    const policy = evaluatePolicy({
      answers: result.answers,
      candidates: result.candidates,
      snapshot: this.snapshot,
      silentMs,
      isFinal: utt.final && !stale,
      pending: this.pending,
      context: this.context,
    });

    const decision = {
      transcript: textAtRequest,
      trigger,
      decisionLagMs: Math.max(0, Date.now() - utt.updatedAt), // last spoken word -> decision available
      answers: result.answers,
      candidates: result.candidates,
      latencyMs: result.latencyMs,
      usage: result.usage,
      costUsd: result.costUsd,
      model: result.model,
      requestId: result.requestId,
      questionCount: result.questionCount,
      stateTokens: approxTokens(result.state),
      policy,
      silentMs,
      thresholds: T,
      at: Date.now(),
    };
    this.lastDecision = decision;
    this.emit("decision", decision);
    this._log(
      policy.decision === "act" ? "act" : "info",
      `${result.latencyMs}ms · "${textAtRequest}" → ${policy.decision}:${policy.summary}`,
    );

    switch (policy.decision) {
      case "act":
        this._consume(utt, textAtRequest);
        if (policy.action.confirmed) this.pending = null;
        this.candidates = null;
        await this._runAction(policy.action, { decision, utterance: utt });
        break;
      case "confirm":
        this._consume(utt, textAtRequest);
        this.pending = policy.action;
        await this.browser.overlay("toast", `说"确认"以执行:${describe(policy.action)}`, 6000);
        this.emit("pending", { action: policy.action, summary: policy.summary });
        break;
      case "cancel":
        this._consume(utt, textAtRequest);
        this.pending = null;
        await this.browser.overlay("toast", "已取消");
        this.emit("pending", null);
        break;
      case "disambiguate": {
        const list = policy.candidates.map((c, i) => ({ n: i + 1, id: c.id, label: c.label, p: c.p }));
        this.candidates = { list, intent: policy.pendingIntent, at: Date.now() };
        await this.browser.overlay("candidates", list, CANDIDATE_TTL_MS);
        await this.browser.overlay("toast", "哪一个?说出编号。", 3000);
        this.emit("candidates", list);
        this._scheduleSilenceRetry(utt);
        break;
      }
      case "wait":
        this._scheduleSilenceRetry(utt, policy.retryInMs);
        break;
      default:
        break;
    }
  }

  /** 用户停止说话时,带上 silentMs 重新评估,让 `complete` 门被旁路。 */
  _scheduleSilenceRetry(utt, retryInMs = null) {
    clearTimeout(this.silenceTimer);
    const waitFor = retryInMs ?? Math.max(50, SILENCE_COMPLETE_MS - (Date.now() - utt.updatedAt));
    this.silenceTimer = setTimeout(() => {
      if (this.utterance === utt && !utt.actedOn) this.decideNow("silence");
    }, waitFor);
  }

  async _runAction(action, meta = {}) {
    this.busy = true;
    const t0 = Date.now();
    const utt = meta.utterance || this.utterance;
    const pageBefore = this.snapshot ? { url: this.snapshot.url, title: this.snapshot.title, site: this.snapshot.site } : null;
    try {
      const res = await this._execute(action, this.browser);
      const took = Date.now() - t0;
      const sinceLastWord = utt ? Date.now() - utt.updatedAt : null;
      const sinceUtteranceStart = utt ? Date.now() - utt.startedAt : null;
      this.stats.actions += 1;
      if (sinceLastWord != null) this.stats.commandToActionMs.push(sinceLastWord);
      if (meta.decision?.decisionLagMs != null) this.stats.decisionMs.push(meta.decision.decisionLagMs);
      this.history.push({ action, at: Date.now(), url: res.detail });
      this._recordContext({ action, ok: res.ok, detail: res.detail, said: meta.decision?.transcript || utt?.actedText || "", pageBefore });
      const decisionMs = meta.decision?.decisionLagMs ?? null;
      const entry = {
        action,
        ok: res.ok,
        detail: res.detail,
        executeMs: took,
        decisionMs, // last word -> decision
        sinceLastWordMs: sinceLastWord, // last word -> action finished (includes page load)
        sinceUtteranceStartMs: sinceUtteranceStart,
        via: meta.via || "jev",
      };
      this._log(res.ok ? "act" : "warn", `${res.ok ? "✓" : "✗"} ${describe(action)} — 最后一个词后 ${decisionMs ?? "?"}ms 决策,执行 ${took}ms ${res.detail || ""}`);
      this.emit("action", entry);
    } catch (err) {
      this._log("error", `动作失败:${describe(action)} — ${err.message || err}`);
      this.emit("action", { action, ok: false, detail: String(err.message || err) });
    } finally {
      this.busy = false;
      await this.refreshSnapshot().catch(() => {});
    }
  }

  /**
   * 记住刚做了什么,让下一个 Jev 请求能解析"回到结果页""另一个""不是这个"。
   * 在每个执行过的动作之后调用;调用方紧接着刷新页面快照,`outcome` 取自动作后的 URL。
   */
  _recordContext({ action, ok, detail, said, pageBefore }) {
    const after = this.browser.currentUrl?.() ?? null;
    const navigated = pageBefore && after && after !== pageBefore.url;
    if (navigated) this.context.previousPage = pageBefore;
    let outcome = ok ? "已完成" : "失败";
    if (ok && navigated) outcome = `已打开 ${after.replace(/^https?:\/\/(www\.)?/, "").slice(0, 80)}`;
    else if (ok && typeof detail === "string" && detail && !detail.startsWith("http")) outcome = detail.slice(0, 80);
    this.context.recentActions.push({
      type: action.type,
      targetId: action.targetId ?? null,
      targetLabel: action.label ?? null,
      text: action.text ?? null,
      url: action.url ?? null,
      said,
      ok,
      outcome,
      at: Date.now(),
    });
    if (this.context.recentActions.length > MAX_CONTEXT_ACTIONS) this.context.recentActions.shift();
  }

  /** "撤销" = 在历史里返回上一页。 */
  async undo() {
    await this._runAction({ type: "go_back", label: "撤销(返回上一页)" }, { via: "undo" });
  }

  uiState() {
    const lat = this.stats.latencies;
    const sorted = [...lat].sort((a, b) => a - b);
    const p50 = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
    return {
      model: this.stats.model,
      thresholds: T,
      stats: {
        calls: this.stats.calls,
        actions: this.stats.actions,
        inputTokens: this.stats.inputTokens,
        costUsd: this.stats.costUsd,
        lastLatencyMs: lat[lat.length - 1] ?? null,
        p50LatencyMs: p50,
        avgLatencyMs: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
        avgCommandToActionMs: avg(this.stats.commandToActionMs),
        avgDecisionMs: avg(this.stats.decisionMs),
      },
      snapshot: this.snapshot && {
        url: this.snapshot.url,
        title: this.snapshot.title,
        site: this.snapshot.site,
        searchBoxId: this.snapshot.searchBoxId,
        elements: this.snapshot.elements,
        tabs: this.snapshot.tabs,
      },
      lastDecision: this.lastDecision,
      context: this.context,
      pending: this.pending ? { summary: describe(this.pending) } : null,
      candidates: this.candidates?.list ?? null,
      log: this.log.slice(-60),
    };
  }

  async close() {
    clearTimeout(this.debounceTimer);
    clearTimeout(this.silenceTimer);
    for (const r of this.inflight) r.ac.abort();
    this.inflight = [];
  }
}
