/**
 * 在受控浏览器上用 Playwright 执行策略动作。
 * 在页面上显示覆盖层反馈(高亮 + toast)。
 */
import { HIGHLIGHT_MS } from "./constants.js";
import { describe } from "./policy.js";

const NAV_TIMEOUT = 15000;

function locatorFor(page, id) {
  return page.locator(`[data-vb-id="${id}"]`).first();
}

async function settle(page, ms = 2500) {
  await Promise.race([page.waitForLoadState("domcontentloaded").catch(() => {}), new Promise((r) => setTimeout(r, ms))]);
  await page.waitForTimeout(120);
}

/** 等待点击(target=_blank)可能打开的新标签页。 */
async function maybeNewTab(browser, before) {
  await new Promise((r) => setTimeout(r, 400));
  const fresh = browser.pages.find((p) => !before.includes(p));
  if (fresh) await browser.setActive(fresh);
}

/**
 * @param {object} action  from policy.evaluatePolicy
 * @param {import('./browser.js').BrowserManager} browser
 * @returns {Promise<{ok: boolean, detail?: string}>}
 */
export async function execute(action, browser) {
  const page = await browser.ensurePage();
  const label = describe(action);

  switch (action.type) {
    case "navigate_url": {
      await browser.overlay("toast", `→ ${label}`);
      const host = new URL(action.url).hostname.replace(/^www\./, "");
      try {
        await page.goto(action.url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
      } catch (e) {
        // 瞬时网络错误或从不触发 load 的站点:重试一次,URL 至少到了正确的
        // 域名就算成功。
        await new Promise((r) => setTimeout(r, 500));
        await page.goto(action.url, { waitUntil: "commit", timeout: NAV_TIMEOUT }).catch(() => {});
        if (!page.url().includes(host)) throw e;
      }
      await settle(page, 800);
      return { ok: true, detail: page.url() };
    }

    case "click_element": {
      const before = [...browser.pages];
      await browser.overlay("clearCandidates");
      await browser.overlay("highlight", action.targetId, HIGHLIGHT_MS);
      await browser.overlay("toast", label);
      const loc = locatorFor(page, action.targetId);
      await new Promise((r) => setTimeout(r, 180)); // let the human see the highlight
      try {
        await loc.click({ timeout: 4000 });
      } catch {
        await loc.evaluate((el) => el.click());
      }
      await settle(page);
      await maybeNewTab(browser, before);
      return { ok: true, detail: browser.page.url() };
    }

    case "type_into_field": {
      await browser.overlay("clearCandidates");
      await browser.overlay("highlight", action.targetId, HIGHLIGHT_MS + 400);
      await browser.overlay("toast", label);
      const loc = locatorFor(page, action.targetId);
      await loc.click({ timeout: 4000 }).catch(() => loc.focus());
      await loc.fill("").catch(() => {});
      await loc.pressSequentially(action.text, { delay: 18 }).catch(async () => loc.fill(action.text));
      if (action.submit) {
        await page.keyboard.press("Enter");
        await settle(page);
      }
      return { ok: true, detail: page.url() };
    }

    case "select_option": {
      await browser.overlay("highlight", action.targetId, HIGHLIGHT_MS);
      await browser.overlay("toast", label);
      const loc = locatorFor(page, action.targetId);
      // 由代码按选项标签匹配(忽略大小写、子串)。
      const picked = await loc.evaluate((sel, wanted) => {
        const w = wanted.toLowerCase();
        const opts = Array.from(sel.options || []);
        const hit = opts.find((o) => o.label.toLowerCase() === w) || opts.find((o) => o.label.toLowerCase().includes(w));
        if (!hit) return null;
        sel.value = hit.value;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        return hit.label;
      }, action.text);
      return { ok: Boolean(picked), detail: picked || "没有匹配的选项" };
    }

    case "press_enter":
      await browser.overlay("toast", "⏎ 回车");
      await page.keyboard.press("Enter");
      await settle(page);
      return { ok: true, detail: page.url() };

    case "scroll_down":
    case "scroll_up": {
      const dir = action.type === "scroll_down" ? 1 : -1;
      await browser.overlay("toast", label);
      await page.evaluate(
        ([dir, amount]) => {
          const vh = window.innerHeight;
          if (amount === "end") {
            window.scrollTo({ top: dir > 0 ? document.documentElement.scrollHeight : 0, behavior: "smooth" });
          } else {
            const px = amount === "little" ? vh * 0.35 : vh * 0.85;
            window.scrollBy({ top: dir * px, behavior: "smooth" });
          }
        },
        [dir, action.amount || "page"],
      );
      await page.waitForTimeout(350);
      return { ok: true, detail: `scrollY=${await page.evaluate(() => Math.round(window.scrollY))}` };
    }

    case "go_back":
      await browser.overlay("toast", "← 返回");
      await page.goBack({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT }).catch(() => {});
      await settle(page, 800);
      return { ok: true, detail: page.url() };

    case "go_forward":
      await browser.overlay("toast", "→ 前进");
      await page.goForward({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT }).catch(() => {});
      await settle(page, 800);
      return { ok: true, detail: page.url() };

    case "reload":
      await browser.overlay("toast", "↻ 刷新");
      await page.reload({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT }).catch(() => {});
      return { ok: true, detail: page.url() };

    case "open_new_tab": {
      const p = await browser.context.newPage();
      await browser.setActive(p);
      await browser.overlay("toast", "新标签页");
      return { ok: true, detail: `tabs=${browser.pages.length}` };
    }

    case "close_tab": {
      await page.close();
      if (browser.pages.length === 0) await browser.context.newPage();
      await browser.setActive(browser.page);
      return { ok: true, detail: `tabs=${browser.pages.length}` };
    }

    case "switch_tab": {
      const pages = browser.pages;
      if (pages.length < 2) return { ok: false, detail: "只有一个标签页" };
      const i = pages.indexOf(browser.page);
      let next;
      if (action.direction === "previous") next = pages[(i - 1 + pages.length) % pages.length];
      else if (action.direction === "first") next = pages[0];
      else next = pages[(i + 1) % pages.length];
      await browser.setActive(next);
      await browser.overlay("toast", "已切换标签页");
      return { ok: true, detail: next.url() };
    }

    default:
      return { ok: false, detail: `未知动作 ${action.type}` };
  }
}
