/**
 * Node 服务器:托管控制页,桥接 WebSocket <-> Controller,持有 API key。
 *
 *   node src/server.js [--port 8787] [--host 127.0.0.1] [--headless] [--cdp ws://127.0.0.1:9222/devtools/browser/...] [--start-url https://...]
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";
import { BrowserManager } from "./browser.js";
import { Controller } from "./controller.js";
import { hasApiKey } from "./jev.js";
import { MODEL, QUESTIONS, T } from "./constants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 加载项目根目录的 .env(KEY=VALUE,支持 # 注释),已存在的环境变量优先。
 * run.sh 也会做同样的事;这里让 Windows 下直接 `node src/server.js` / `npm start` 也能用。
 */
function loadDotEnv() {
  const file = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    const value = m[2].replace(/^["']|["']$/g, "");
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

export function parseArgs(argv) {
  const out = {
    port: Number(process.env.PORT) || 8787,
    // Bind to loopback only by default: anyone who can reach this port can drive the browser
    // and spend your API credits. Use --host 0.0.0.0 deliberately if you need LAN access.
    host: process.env.HOST || "127.0.0.1",
    headless: false,
    cdp: null,
    startUrl: "https://example.com/",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--host") out.host = argv[++i];
    else if (a === "--headless") out.headless = true;
    else if (a === "--cdp") out.cdp = argv[++i];
    else if (a === "--start-url") out.startUrl = argv[++i];
  }
  return out;
}

export async function startServer(opts = {}) {
  loadDotEnv();
  if (!hasApiKey()) {
    console.error("缺少 TYPESAFE_API_KEY(或 JEV_API_KEY)。请复制 .env.example 为 .env 并填入 key,或先导出环境变量。");
    process.exit(1);
  }
  const browser = new BrowserManager();
  // controlPort:防止用户把控制页开进受控窗口时,语音动作把控制页本身导航走
  await browser.launch({ headless: opts.headless, cdp: opts.cdp, startUrl: opts.startUrl, controlPort: opts.port });
  const controller = new Controller({ browser });
  await controller.start();

  // 兜底:任何未捕获的异步错误只记日志,不再让整个服务崩溃
  // (例如受控浏览器被手动关闭后的瞬时竞态)。
  process.on("unhandledRejection", (err) => {
    console.error(`未处理的异步错误:${err?.message || err}`);
    try {
      controller._log("error", `未处理的异步错误:${err?.message || err}`);
    } catch {}
  });

  const app = express();
  app.use(express.static(path.join(__dirname, "public")));
  app.get("/api/state", (_req, res) => res.json(controller.uiState()));
  app.get("/api/questions", (_req, res) => res.json({ model: MODEL, thresholds: T, questions: QUESTIONS }));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  const broadcast = (type, payload) => {
    const msg = JSON.stringify({ type, payload });
    for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
  };

  controller.on("transcript", (p) => broadcast("transcript", p));
  controller.on("decision", (p) => broadcast("decision", p));
  controller.on("action", (p) => broadcast("action", { ...p, ui: controller.uiState() }));
  controller.on("snapshot", () => broadcast("snapshot", controller.uiState().snapshot));
  controller.on("log", (p) => broadcast("log", p));
  controller.on("candidates", (p) => broadcast("candidates", p));
  controller.on("pending", (p) => broadcast("pending", p));
  controller.on("tabs", (p) => broadcast("tabs", p));

  wss.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "hello", payload: controller.uiState() }));
    ws.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      switch (msg.type) {
        case "transcript":
          controller.handleTranscript({ text: msg.text, final: Boolean(msg.final), utteranceId: msg.utteranceId });
          break;
        case "command":
          controller.handleCommand(msg.text);
          break;
        case "undo":
          controller.undo();
          break;
        case "snapshot":
          controller.refreshSnapshot().catch((err) => {
            console.error(`快照失败:${err?.message || err}`);
            controller._log("error", `快照失败:${err?.message || err}`);
          });
          break;
        case "state":
          ws.send(JSON.stringify({ type: "hello", payload: controller.uiState() }));
          break;
        default:
          break;
      }
    });
  });

  const host = opts.host || "127.0.0.1";
  await new Promise((resolve) => server.listen(opts.port, host, resolve));
  const url = `http://localhost:${opts.port}`;
  if (host !== "127.0.0.1" && host !== "localhost") {
    console.warn(`警告:正监听 ${host} —— 任何能访问这个端口的人都可以控制浏览器并消耗 API 额度。`);
  }
  console.log(`\njev-voice-browser-zh 就绪 → 在 Chrome 里打开 ${url}(麦克风需要 Chrome/Edge)`);
  console.log(`模型 ${MODEL} · 受控窗口:${opts.cdp ? "通过 CDP 附加" : opts.headless ? "无头模式" : "有头 Chromium"}\n`);

  const shutdown = async () => {
    await controller.close();
    await browser.close();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return { app, server, controller, browser, url };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer(parseArgs(process.argv.slice(2))).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
