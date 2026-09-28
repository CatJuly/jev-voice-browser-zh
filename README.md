# jev-voice-browser-zh — 说中文，浏览器就动手

一个用**中文语音**操控真实浏览器窗口的 Node 应用。浏览器里的 Web Speech API 把你说的话逐词流式地
发给本地 Node 服务器；服务器每收到一次转写更新，就向 **Jev**（TypeSafe 的 System One 模型，
`jev-1.13.0`）发**一个**请求，里面带着十几道有类型的判断题/选择题——意图、目标元素、站点、
"话说完了吗"、"是在对我说话吗"、"危险吗"——约 250–350ms 拿到带概率的答案，然后由代码决定：
执行、等待、追问，还是忽略。

Jev **从不生成文本**。搜索词、要输入的文字、要打开的网址都由代码用正则从转写里切出来作为候选，
Jev 只负责**选一个**，选中后原样复制，绝不多一个字。

## 项目来源

本项目 **fork 自 [moritzkremb/jev-voice-browser](https://github.com/moritzkremb/jev-voice-browser)**
（MIT License，Copyright © 2026 Moritz Kremb，许可证见 [LICENSE](LICENSE)）。原项目只支持英文语音。

本仓库在其基础上做了**全面中文化改造**，英文不再保留：

- 中文 NLU 提取层（`src/spans.js`）：中文动词（搜索/输入/点击…）、把字句（"把 X 输入到搜索框"）、
  引号内文本、口播域名（"点 com" → ".com"）、"第二个 → 2" 的序号抽取，全部用正则完成，不依赖模型
- 新增中文常用站：**百度、B站、知乎**（原有 Google/维基百科/油管/GitHub 等保留）
- 控制页 UI 全部中文化；语音识别语言改为 `zh-CN`
- 单元测试、集成测试、demo 脚本全部改为中文命令

## 工作原理

```
 麦克风(Chrome Web Speech API, zh-CN)       Node 服务器(持有 API key)             受控窗口
 ─────────────────────────────  ws  ───────────────────────────────────  ─────────────────
 逐词转写 ─────────────────────────────▶ 防抖 200ms                          有头 Chromium
 "打开"  "打开维基"                       抓取页面(≤100 元素, e01..eNN) ◀──  Playwright, 持久化
 "打开维基百科"(说完)                     一次 Jev 请求:9–11 道题              profile, 高亮层
 控制页 ◀───────────────────────────  决策 + 概率条 + 延迟 + 费用          编号候选
```

## 运行

要求：Node ≥ 20、npm、用于收音的 Chrome 或 Edge（Web Speech API 在 Firefox/Safari 里没有）。
真实 API 调用每次约 $0.0002。

```bash
npm install
npx playwright install chromium
copy .env.example .env        # 粘贴你的 TypeSafe API key(在 https://console.typesafe.ai/keys 获取)
npm start                     # 服务器启动在 http://localhost:8787(Windows 下直接可用)
```

> 在 macOS/Linux 上也可以用 `./run.sh`。`npm start` 会由 `src/server.js` 自行读取根目录的
> `.env`，所以 Windows 下无需导出环境变量。

然后在你**自己的 Chrome**里打开 **http://localhost:8787**，点「开始收音」，允许麦克风，开始说。
服务器会另外弹出一个 Chromium 窗口（**受控浏览器**），真正动手的是它。把控制页放到副屏或半边屏，
能实时看到概率条。

> 重要：**不要**把控制页开进受控浏览器窗口里——否则一句"打开维基百科"会把它当成当前页导航走。
> 现已加了保护：即便误开进去，动作也会自动落到别的标签页，控制页的语音不会被切断。

选项：`npm start -- --port 9000`、`--host 0.0.0.0`(局域网，见安全说明)、`--start-url https://…`、
`--headless`(CI)、或附加到你已运行的 Chrome：

```bash
# 先用调试端口启动你的 Chrome,然后:
npm start -- --cdp http://127.0.0.1:9222
```

不想用 `.env` 也可以：`export TYPESAFE_API_KEY=…`（旧名 `JEV_API_KEY` 同样接受）后 `npm start`。
key 只会被 Node 进程读取，控制页永远看不到它。

**安全：** 服务器默认只监听 `127.0.0.1`。任何能访问该端口的人都能操控浏览器并消耗你的 API 额度，
所以只有在可信网络里才用 `--host 0.0.0.0`。受控 Chromium 使用 `.browser-profile/`（已 gitignore）
下的持久化 profile——别在里面登录你不希望被误听的一句"点击下单"碰到的账号；危险点击需要说
「确认」，但请把它当便利，而不是保证。

没有麦克风？在控制页的文本框里输入命令回车即可。

## 能说什么

| 说 | 会发生什么 |
| --- | --- |
| 「打开维基百科」「打开油管」「打开 example 点 com」 | 导航（站点表或口播域名，URL 由代码持有） |
| 「搜索艾伦图灵」 | 用页面自带的搜索框（维基/油管…），没有则用 DuckDuckGo |
| 「在油管里搜索 lofi 音乐」 | 站点专属搜索 URL 模板 |
| 「点击第一个结果」「点击新的链接」「打开评论区」 | 点击 Jev 从快照里选中的元素；模糊时出编号角标，说「二」 |
| 「把你好世界输入到搜索框」 | 原样输入（Jev 选中的片段，代码原样复制） |
| 「往下滚一点」「滚到底」「往上滚一页」 | 滚动，幅度来自三级 Score |
| 「返回上一页」「前进」「刷新」 | 历史 |
| 「新开标签页」「关闭这个标签」「下一个标签」 | 标签页 |
| 「点击下单」 | 危险 → 弹提示要你说「确认」（或「取消」） |
| 「对了我们中午吃什么」 | 忽略（`is_command` ≈ 0.02） |

一口气说两条也行："打开 example 点 com 然后点击 more information 链接"。

## 决策是怎么做出的

每次转写更新恰好产生一次 Jev 请求（`src/jev.js`）。状态：

```json
{ "transcript": "打开文档",
  "page": { "url": "https://typesafe.ai/jev", "title": "Jev", "site": "generic" },
  "elements": ["e03 link \"文档\" → docs.typesafe.ai", "..."],
  "context": {
    "previous_page": { "url": "https://www.baidu.com/s?wd=...", "title": "..." },
    "recent_actions": [ { "said": "点击第一个结果", "action": "click_element", "outcome": "已打开 …", "seconds_ago": 6 } ] } }
```

`context` 就是到目前为止的对话：你来的上一个页面 + 最近三次已执行的动作（说了什么、做了什么、
结果如何）。它让「返回结果页」「不，不是这个」「另一个」「打开它的文档」变得可解——Jev 请求之间
没有记忆，记忆存在状态里。

问题（都在 `src/constants.js`，同时发、并行答）：

| id | 类型 | 答案 |
| --- | --- | --- |
| `intent` | Choice | navigate_url · search_web · click_element · type_into_field · select_option · press_enter · scroll_down/up · go_back/forward · reload · open/close/switch tab · confirm · cancel · none（每个选项都带 `{what, not_for, examples}`） |
| `target` | Choice | 页面元素 id + `none` |
| `site` | Choice | google · baidu · bilibili · zhihu · duckduckgo · youtube · wikipedia · github … |
| `complete` | Noul | 命令说完了吗？（让我们能在话说一半时就动手） |
| `is_command` | Noul | 是在对浏览器说话吗？ |
| `destructive` | Noul | 会不会提交/购买/删除/发送？ |
| `scroll_amount` | Score | 一点 · 一页 · 到底 |
| `text_span` | Choice | 正则切出的原文候选片段(+`none`) |
| `url_span` | Choice | 域名样片段(+`none`) |
| `tab_direction` | Choice | 下一个 · 上一个 · 第一个 · none |
| `is_correction` | Noul | 是不是在否定/纠正最近一次动作？ |

策略（`src/policy.js`，阈值 `T` 在 `constants.js`），在 UI 里以门控表实时显示：

0. 已说完的句子上 `is_correction ≥ 0.6`：没有新的确定命令（"不，不是这个""撤销"）→ 撤销上一动作；
   有新目标（"不，是另一个"）→ 把已点的元素从候选中排除。确定的封闭集命令（滚完说"返回上一页"）
   永不当作纠正。
1. `is_command ≥ 0.5` 否则**忽略**
2. `intent.confidence ≥ 0.55` 且非 none 否则**等待**
3. `complete ≥ 0.6`，或静默 900ms，或识别器给出最终结果——否则**等待**
4. 自由文本意图（搜索/输入）额外再等最终结果或静默 600ms，确保查询词不被截断
   （"搜索艾伦" vs "搜索艾伦图灵"）
5. 由代码组装动作：URL 模板、搜索框兜底、原文片段复制
6. 点击/输入目标需 `target.confidence ≥ 0.45` 且最高概率 ≥ 0.35，否则前 2–3 个候选在页面里出
   编号角标，说编号即可（不再调模型）
7. 点击且 `destructive ≥ 0.5` → **确认**（说「确认」/「取消」）

请求会重叠：最多 2 个在飞，旧的用 `AbortSignal` 取消。部分转写的响应如果已经确定是封闭集动作
（"返回上一页"）仍可能执行，但对自由文本永远不会当最终结果处理。

## 项目结构

```
src/constants.js   模型锁定、阈值、全部问题文案——上镜要 review 的唯一文件
src/jev.js         组状态+问题,调用 @typesafe-ai/sdk,返回答案/延迟/用量/费用
src/spans.js       候选提取(文字载荷、口播网址、数字序号、中文动词/把字句)——代码,不是 Jev
src/snapshot.js    页内元素采集(打 data-vb-id 标签)、压缩+大小守卫、站点识别
src/policy.js      答案 → 执行/等待/忽略/确认/消歧,带原因
src/executor.js    Playwright 动作 + 高亮反馈
src/browser.js     启动有头 Chromium(持久化 profile)或 CDP 附加;标签页
src/overlay.js     注入的高亮/提示条/编号角标
src/controller.js  防抖、在飞管理、一句话一个动作、链式命令、统计
src/server.js      Express + ws,托管 src/public/index.html(控制页)
scripts/demo.js    逐词回放真实站点 = 端到端测试
test/unit/         spans、快照压缩、policy(mock Jev)、controller、context
test/integration/  34 例真实 API 用例(在抓取页面 fixture 上),打印通过率+延迟
```

## 测试与 demo

```bash
npm test                  # 单元测试(无网络)
npm run test:integration  # 真实 Jev 调用(需 key),打印通过率(期望 ≥90%)
npm run demo              # 有头回放 16 条中文命令,断言 URL
npm run demo:ci           # 无头版,失败退出码 1
node scripts/demo.js --headless --only 1,2,3 --word-ms 250
```

最近实测(2026-09)：集成测试 34/34（100%，含 7 例上下文/纠正），Jev 延迟平均约 300ms
（p50 ≈ 294ms，每次请求 3–6k input token；进程首个请求 ~700ms 是 TLS 握手），
词→决策 ≈ 300ms（含 200ms 防抖），整场 demo 约 $0.008。

## 许可证

[MIT](LICENSE) —— 沿用原项目 [moritzkremb/jev-voice-browser](https://github.com/moritzkremb/jev-voice-browser) 的 MIT 许可证。
