/**
 * 执行策略:把 Jev 的答案变成 执行/等待/忽略/确认/消歧 的纯代码。
 * 每道门都是 constants.js 里的一个数字,UI 可以展示"为什么"。
 */
import {
  T,
  TARGET_INTENTS,
  SITE_HOME,
  SITE_SEARCH,
  DEFAULT_SEARCH_ENGINE,
  SILENCE_COMPLETE_MS,
  PAYLOAD_SILENCE_MS,
  PAYLOAD_INTENTS,
} from "./constants.js";
import { toHttpUrl } from "./spans.js";

const r2 = (x) => Math.round(x * 100) / 100;

// 动作标签与滚动量的展示文案(amount 代码保持英文,executor 依赖它)
const AMOUNT_LABELS = { little: "一点", page: "一页", end: "到底" };
const SIMPLE_LABELS = {
  go_back: "返回上一页",
  go_forward: "前进一页",
  reload: "刷新页面",
  open_new_tab: "新标签页",
  close_tab: "关闭标签页",
  press_enter: "按回车",
};
const TAB_DIR_LABELS = { next: "下一个", previous: "上一个", first: "第一个" };

function check(reasons, name, value, threshold, pass, note) {
  reasons.push({ name, value: typeof value === "number" ? r2(value) : value, threshold, pass, note });
  return pass;
}

/** 按概率取前 N 个选项,排除 `none`。 */
export function topChoices(choiceAnswer, n = 3) {
  if (!choiceAnswer?.probabilities) return [];
  return Object.entries(choiceAnswer.probabilities)
    .filter(([k]) => k !== "none")
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([id, p]) => ({ id, p: r2(p) }));
}

function pickSpan(answer, minConfidence, fallback) {
  if (!answer) return fallback ?? null;
  if (answer.choice === "none") return null;
  if (answer.confidence < minConfidence) return fallback ?? answer.choice;
  return answer.choice;
}

function fillTemplate(tpl, q) {
  return tpl.replace("%s", encodeURIComponent(q));
}

/**
 * @param {object} p
 * @param {object} p.answers   Jev answers (intent, target, site, complete, is_command, destructive, scroll_amount, text_span?, url_span?, tab_direction)
 * @param {object} p.candidates {text: string[], url: string[]}
 * @param {object} p.snapshot  当前页面快照 (elements, searchBoxId, site, url)
 * @param {number} p.silentMs  距转写最后一次变化过了多少毫秒
 * @param {boolean} p.isFinal  识别器已把这句话标记为最终结果
 * @param {object|null} p.pending  等待"确认"的待定破坏性操作
 * @param {boolean} p.confirmed  用户已对该操作说过确认
 * @returns {{decision: string, action?: object, candidates?: Array, reasons: Array, summary: string}}
 */
export function evaluatePolicy({ answers, candidates, snapshot, silentMs = 0, isFinal = false, pending = null, context = null }) {
  const reasons = [];
  const intent = answers.intent;
  const intentName = intent?.choice ?? "none";
  const lastAction = context?.recentActions?.length ? context.recentActions[context.recentActions.length - 1] : null;
  const correction = answers.is_correction?.noul ?? 0;
  // 纠正只在语句说完(或用户已沉默)时才算数:滚动之后的一个字的 partial "不"
  // 不能被读成"撤销刚才的滚动"。
  const finishedPhrase = (answers.complete?.noul ?? 0) >= T.complete || silentMs >= SILENCE_COMPLETE_MS || isFinal;
  const isCorrection = Boolean(lastAction) && correction >= T.correction && finishedPhrase;

  // 0. 待定破坏性操作的 确认/取消 处理。
  if (pending) {
    if (intentName === "confirm" && intent.confidence >= T.intentConfidence) {
      check(reasons, "intent", `confirm (${r2(intent.confidence)})`, T.intentConfidence, true, "待确认操作已确认");
      return { decision: "act", action: { ...pending, confirmed: true }, reasons, summary: `已确认:${describe(pending)}` };
    }
    if (intentName === "cancel" && intent.confidence >= T.intentConfidence) {
      check(reasons, "intent", `cancel (${r2(intent.confidence)})`, T.intentConfidence, true, "待确认操作已取消");
      return { decision: "cancel", reasons, summary: "已取消待确认的操作" };
    }
  }

  // 1. 纠正上一操作("不,不是这个""点错了,撤销")。一个光秃秃的"不"是对浏览器的反应,
  // 不是新命令,所以它跑在 is_command 门之前。用户否定刚发生的事且没有指名新目标时,
  // 直接反转;指名了新目标("不,是另一个")则往下走,下面会排除上一目标。
  if (isCorrection) {
    check(reasons, "is_correction", correction, T.correction, true, `否定上一操作:${describe(lastAction)}`);
    const confidentIntent = intentName !== "none" && (intent?.confidence ?? 0) >= T.intentConfidence;
    // "另一个"指名了新元素;"不是这个"没有(target 回来是 `none` 或刚操作过的元素)
    // —— 后者是纯反转。
    const namesNewTarget =
      TARGET_INTENTS.has(intentName) && topChoices(answers.target, 2).some((c) => c.id !== lastAction.targetId && c.p >= T.targetTopProb);
    // 滚动或点击之后说的自信闭集命令("返回上一页""往下滚""打开哔哩哔哩")就是它字面的
    // 意思,不是要反转上一操作:落入正常处理。只有不自信/无目标的纠正才当作"撤销"。
    const reverse = lastAction.type !== "go_back" && (!confidentIntent || (TARGET_INTENTS.has(intentName) && !namesNewTarget));
    if (reverse) {
      const reversal = reverseAction(lastAction);
      return { decision: "act", action: reversal, reasons, summary: `纠正 → ${describe(reversal)}` };
    }
  }

  // 1b. 用户到底是不是在对浏览器说话?
  const isCmd = answers.is_command?.noul ?? 0;
  if (!check(reasons, "is_command", isCmd, T.isCommand, isCmd >= T.isCommand, "用户在对浏览器说话")) {
    return { decision: "ignore", reasons, summary: "不是浏览器命令" };
  }

  // 2. 有没有足够置信的意图?
  const conf = intent?.confidence ?? 0;
  const intentOk = intentName !== "none" && conf >= T.intentConfidence;
  check(reasons, "intent", `${intentName} (${r2(conf)})`, T.intentConfidence, intentOk, "意图明确且置信");
  if (!intentOk) return { decision: "wait", reasons, summary: intentName === "none" ? "还没有可识别的命令" : "意图置信度不足" };

  // 3. 命令说完了吗?(沉默或最终结果也算)
  const complete = answers.complete?.noul ?? 0;
  const silent = silentMs >= SILENCE_COMPLETE_MS || isFinal;
  const completeOk = complete >= T.complete || silent;
  check(
    reasons,
    "complete",
    complete,
    T.complete,
    completeOk,
    silent ? (isFinal ? "识别器已标记语句结束" : `沉默 ${silentMs}ms`) : "动词和宾语齐全",
  );
  if (!completeOk) return { decision: "wait", reasons, summary: "等待命令的剩余部分" };

  // 3b. 自由文本载荷必须说完才能逐字复制。
  if (PAYLOAD_INTENTS.has(intentName)) {
    const payloadOk = isFinal || silentMs >= PAYLOAD_SILENCE_MS;
    check(
      reasons,
      "payload_final",
      isFinal ? "final" : `${silentMs}ms 沉默`,
      `final 或 ${PAYLOAD_SILENCE_MS}ms`,
      payloadOk,
      "自由文本(查询词/要输入的文字)必须说完才能逐字复制",
    );
    if (!payloadOk) {
      return { decision: "wait", reasons, summary: "等待语句结束(自由文本)", retryInMs: Math.max(50, PAYLOAD_SILENCE_MS - silentMs) };
    }
  }

  // 4. 组装具体动作(URL/模板/文字都由代码掌握;Jev 只挑过选项)。
  // 指名了新目标的纠正里,上一目标不再作为选项("另一个")。
  const excludeTargetId = isCorrection && TARGET_INTENTS.has(intentName) ? lastAction.targetId ?? null : null;
  const built = buildAction({ intentName, answers, candidates, snapshot, reasons, excludeTargetId });
  if (built.decision !== "act") return { ...built, reasons };
  const action = built.action;

  // 5. 危险吗?只有带副作用的元素操作才可能危险。
  const destructive = answers.destructive?.noul ?? 0;
  const canBeDestructive = ["click_element", "press_enter", "select_option"].includes(action.type);
  if (canBeDestructive) {
    const safe = destructive < T.destructive;
    check(reasons, "destructive", destructive, T.destructive, safe, safe ? "可逆操作" : "需要口头确认");
    if (!safe) {
      return { decision: "confirm", action, reasons, summary: `说"确认"以执行:${describe(action)}` };
    }
  }

  return { decision: "act", action, reasons, summary: describe(action) };
}

/** 在浏览器能力范围内撤销 `action`:导航/点击 → 返回;输入 → 清空;标签页 → 关闭/切回。 */
export function reverseAction(action) {
  switch (action?.type) {
    case "type_into_field":
      return { type: "type_into_field", targetId: action.targetId, text: "", submit: false, label: `清空 ${action.label || action.targetId}` };
    case "open_new_tab":
      return { type: "close_tab", label: "关闭新标签页" };
    case "close_tab":
      return { type: "go_back", label: "返回上一页(标签页已关闭)" };
    case "switch_tab":
      return { type: "switch_tab", direction: action.direction === "previous" ? "next" : "previous", label: "切回原来的标签页" };
    case "scroll_down":
      return { type: "scroll_up", amount: action.amount || "page", label: "反向滚动(向上)" };
    case "scroll_up":
      return { type: "scroll_down", amount: action.amount || "page", label: "反向滚动(向下)" };
    default:
      return { type: "go_back", label: `撤销:${describe(action)}` };
  }
}

function buildAction({ intentName, answers, candidates, snapshot, reasons, excludeTargetId = null }) {
  const site = answers.site?.choice ?? "none";
  const elements = snapshot?.elements ?? [];

  switch (intentName) {
    case "navigate_url": {
      const urlPick = pickSpan(answers.url_span, T.spanConfidence, candidates.url?.[0]);
      if (urlPick) {
        check(reasons, "url_span", urlPick, T.spanConfidence, true, "口播域名逐字复制");
        return { decision: "act", action: { type: "navigate_url", url: toHttpUrl(urlPick), label: urlPick } };
      }
      if (SITE_HOME[site]) {
        check(reasons, "site", `${site} (${r2(answers.site.confidence)})`, "-", true, "已知站点");
        return { decision: "act", action: { type: "navigate_url", url: SITE_HOME[site], label: site } };
      }
      check(reasons, "site", site, "已知站点或口播域名", false, "还没有目的地");
      return { decision: "wait", summary: "去哪?(没识别到站点或域名)" };
    }

    case "search_web": {
      const query = pickSpan(answers.text_span, T.spanConfidence, candidates.text?.[0]);
      if (!query) {
        check(reasons, "text_span", "none", T.spanConfidence, false, "还没有查询词");
        return { decision: "wait", summary: "搜索什么?" };
      }
      check(reasons, "text_span", query, T.spanConfidence, true, "查询词逐字复制");
      if (SITE_SEARCH[site]) {
        return { decision: "act", action: { type: "navigate_url", url: fillTemplate(SITE_SEARCH[site], query), label: `搜索 ${site}:${query}`, query } };
      }
      if (snapshot?.searchBoxId && snapshot.site !== "blank") {
        return { decision: "act", action: { type: "type_into_field", targetId: snapshot.searchBoxId, text: query, submit: true, label: `站内搜索:${query}` } };
      }
      return { decision: "act", action: { type: "navigate_url", url: fillTemplate(SITE_SEARCH[DEFAULT_SEARCH_ENGINE], query), label: `搜索:${query}`, query } };
    }

    case "click_element":
    case "select_option":
    case "type_into_field": {
      const target = answers.target;
      let top = topChoices(target, T.candidateCount + 1);
      let chosen = target?.choice;
      let chosenP = target?.probabilities?.[chosen] ?? 0;
      if (excludeTargetId && chosen === excludeTargetId) {
        // "不,是另一个":刚操作过的元素被排除,取第二名。
        top = top.filter((c) => c.id !== excludeTargetId);
        chosen = top[0]?.id ?? "none";
        chosenP = top[0]?.p ?? 0;
        check(reasons, "exclude_target", excludeTargetId, "-", true, `已排除上一目标 → ${chosen}`);
      }
      top = top.slice(0, T.candidateCount);
      const targetOk =
        chosen && chosen !== "none" && target.confidence >= T.targetConfidence && chosenP >= T.targetTopProb;
      const text = intentName === "click_element" ? null : pickSpan(answers.text_span, T.spanConfidence, candidates.text?.[0]);

      if (intentName !== "click_element" && !text) {
        check(reasons, "text_span", "none", T.spanConfidence, false, "还没有要输入的文字");
        return { decision: "wait", summary: "输入什么?" };
      }

      if (targetOk) {
        check(reasons, "target", `${chosen} (${r2(target.confidence)})`, T.targetConfidence, true, elementLabel(elements, chosen));
        return { decision: "act", action: { type: intentName, targetId: chosen, text, label: elementLabel(elements, chosen) } };
      }

      // 输入没有明确目标:回退到页面的搜索框。
      if (intentName === "type_into_field" && snapshot?.searchBoxId) {
        check(reasons, "target", `${chosen} (${r2(target?.confidence ?? 0)})`, T.targetConfidence, false, "回退到搜索框");
        return { decision: "act", action: { type: intentName, targetId: snapshot.searchBoxId, text, label: "搜索框" } };
      }

      check(reasons, "target", `${chosen ?? "none"} (${r2(target?.confidence ?? 0)})`, T.targetConfidence, false, "目标含糊");
      // 展示合理的候选(只要有任何合理的,至少给两个)。
      let viable = top.filter((c) => c.p >= 0.08);
      if (viable.length === 1) viable = top.filter((c) => c.p >= 0.02).slice(0, 2);
      if (viable.length === 0) return { decision: "wait", summary: "页面上没有匹配的元素" };
      return {
        decision: "disambiguate",
        candidates: viable.map((c) => ({ ...c, label: elementLabel(elements, c.id) })),
        pendingIntent: { type: intentName, text },
        summary: `哪一个?${viable.map((c, i) => `${i + 1}: ${elementLabel(elements, c.id)}`).join(" | ")}`,
      };
    }

    case "scroll_down":
    case "scroll_up": {
      const lvl = Math.round(answers.scroll_amount?.score ?? 1);
      const amount = ["little", "page", "end"][Math.min(2, Math.max(0, lvl))];
      check(reasons, "scroll_amount", answers.scroll_amount?.score ?? 1, "round", true, AMOUNT_LABELS[amount]);
      return { decision: "act", action: { type: intentName, amount, label: `${intentName === "scroll_down" ? "往下滚" : "往上滚"}(${AMOUNT_LABELS[amount]})` } };
    }

    case "switch_tab": {
      const dir = answers.tab_direction?.choice && answers.tab_direction.choice !== "none" ? answers.tab_direction.choice : "next";
      return { decision: "act", action: { type: "switch_tab", direction: dir, label: `切换标签页(${TAB_DIR_LABELS[dir] || dir})` } };
    }

    case "confirm":
    case "cancel":
      return { decision: "wait", summary: `没有待${intentName === "confirm" ? "确认" : "取消"}的操作` };

    default:
      return { decision: "act", action: { type: intentName, label: SIMPLE_LABELS[intentName] ?? intentName } };
  }
}

export function elementLabel(elements, id) {
  const el = elements.find((e) => e.id === id);
  return el ? `${el.role} "${el.text || el.placeholder || ""}"` : id;
}

export function describe(action) {
  if (!action) return "";
  switch (action.type) {
    case "navigate_url":
      return `打开 ${action.label || action.url}`;
    case "type_into_field":
      return `在${action.label || action.targetId}里输入"${action.text}"${action.submit ? " 并回车" : ""}`;
    case "click_element":
      return `点击 ${action.label || action.targetId}`;
    case "select_option":
      return `在${action.label || action.targetId}里选"${action.text}"`;
    default:
      return action.label || SIMPLE_LABELS[action.type] || action.type.replace(/_/g, " ");
  }
}

export { TARGET_INTENTS };
