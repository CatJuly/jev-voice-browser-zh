/**
 * 浏览器管理:用持久化配置启动有头 Playwright Chromium(让它像"你的浏览器"),
 * 或通过 --cdp ws://... 附加到已运行的 Chrome。跟踪标签页,暴露活跃页。
 *
 * 两个防御:
 *  - 控制页(localhost:<port>)绝不能成为动作目标 —— 用户把控制页开在受控窗口里时,
 *    动作/快照自动落到别的标签页(没有就新开一个),否则一句"打开维基百科"会把
 *    控制页连同它的 WebSocket 和麦克风一起导航走。
 *  - 受控窗口被用户手动关闭后,下一次 ensurePage 用原参数自动重启(仅持久化模式)。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { installOverlay } from "./overlay.js";
import { collectElementsInPage, buildSnapshot } from "./snapshot.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PROFILE_DIR = path.join(__dirname, "..", ".browser-profile");

export class BrowserManager {
  constructor() {
    this.context = null;
    this.browser = null;
    this.active = null;
    this.pages = [];
    this.listeners = new Set();
    this.controlPort = null; // 服务器控制页端口;null = 守卫关闭(demo / 测试)
    this._launchOpts = null;
    this._contextClosed = false;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  _emit() {
    for (const fn of this.listeners) fn(this);
  }

  async launch({ headless = false, cdp = null, profileDir = DEFAULT_PROFILE_DIR, startUrl = "about:blank", controlPort = null } = {}) {
    this._launchOpts = { headless, cdp, profileDir, startUrl, controlPort };
    this.controlPort = controlPort;
    this._contextClosed = false;
    if (cdp) {
      this.browser = await chromium.connectOverCDP(cdp);
      this.context = this.browser.contexts()[0] || (await this.browser.newContext());
    } else {
      this.context = await chromium.launchPersistentContext(profileDir, {
        headless,
        viewport: headless ? { width: 1280, height: 900 } : null,
        args: headless ? [] : ["--window-size=1280,900", "--window-position=40,40"],
        ignoreDefaultArgs: ["--enable-automation"],
      });
    }
    this.context.on("close", () => {
      this._contextClosed = true;
    });
    await this.context.addInitScript(installOverlay);

    this.context.on("page", (page) => this._track(page));
    for (const p of this.context.pages()) this._track(p);
    if (this.pages.length === 0) await this.context.newPage();
    if (!this.page) this.active = this.pages[this.pages.length - 1];
    if (startUrl && startUrl !== "about:blank" && this.page) {
      await this.page.goto(startUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
    }
    this._emit();
    return this;
  }

  /** 用户把控制页开在受控窗口里时不破坏它,动作落到别的页。 */
  _isControlPage(p) {
    if (!this.controlPort || !p || p.isClosed()) return false;
    const u = p.url();
    return u.startsWith(`http://localhost:${this.controlPort}`) || u.startsWith(`http://127.0.0.1:${this.controlPort}`);
  }

  /** 受控窗口被关掉后,用原参数重启(仅持久化模式;CDP 附加的浏览器无法替用户重启)。 */
  async _relaunchIfDead() {
    if (!this._contextClosed || !this._launchOpts || this._launchOpts.cdp) return;
    this._contextClosed = false;
    this.pages = [];
    this.active = null;
    await this.launch(this._launchOpts);
  }

  _track(page) {
    if (this.pages.includes(page)) return;
    this.pages.push(page);
    if (!this._isControlPage(page)) this.active = page; // 控制页永远不自动成为活跃页
    page.on("close", () => {
      this.pages = this.pages.filter((p) => p !== page);
      if (this.active === page) this.active = this.pages[this.pages.length - 1] || null;
      this._emit();
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) this._emit();
    });
    this._emit();
  }

  get page() {
    if (!this.active || this.active.isClosed() || this._isControlPage(this.active)) {
      this.active =
        this.pages.find((p) => !p.isClosed() && !this._isControlPage(p)) ||
        this.pages.find((p) => !p.isClosed()) ||
        null;
    }
    return this.active;
  }

  async ensurePage() {
    await this._relaunchIfDead();
    const p = this.page;
    if (!p || this._isControlPage(p)) {
      await this.context.newPage(); // _track 会把新页设为 active(它不是控制页)
    }
    return this.page;
  }

  async setActive(page) {
    this.active = page;
    await page.bringToFront().catch(() => {});
    this._emit();
  }

  tabInfo() {
    return this.pages.map((p, i) => ({ index: i, url: p.url(), active: p === this.active }));
  }

  /** URL of the active page, or null (sync; used to record what an action led to). */
  currentUrl() {
    try {
      return this.active && !this.active.isClosed() ? this.active.url() : null;
    } catch {
      return null;
    }
  }

  /** Snapshot the active page (URL, title, compact element list, search box, site). */
  async snapshot() {
    const page = await this.ensurePage();
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 1500 }).catch(() => {});
      const data = await page.evaluate(collectElementsInPage);
      return buildSnapshot(data, { tabs: this.tabInfo() });
    } catch (err) {
      // e.g. navigation in progress; return a minimal snapshot
      return buildSnapshot({ url: page.url(), title: "", scrollY: 0, scrollHeight: 0, viewportHeight: 0, elements: [] }, { tabs: this.tabInfo(), error: String(err.message || err) });
    }
  }

  /** Call window.__vb.<fn>(...args) in the active page, swallowing errors. */
  async overlay(fn, ...args) {
    const page = this.page;
    if (!page) return;
    await page.evaluate(installOverlay).catch(() => {}); // no-op if already installed by the init script
    await page
      .evaluate(
        ([fn, args]) => {
          if (!window.__vb) return false;
          return window.__vb[fn](...args);
        },
        [fn, args],
      )
      .catch(() => {});
  }

  async close() {
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
  }
}
