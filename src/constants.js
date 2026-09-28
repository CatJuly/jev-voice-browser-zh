/**
 * 唯一需要人工审查的文件:Jev 看到的所有内容 + 策略用的所有阈值。
 *
 * Jev(TypeSafe "System One")不生成文本。每个请求携带当前 `state`(转写 + 页面快照)
 * 和一组类型化问题,问题之间独立并行回答。控制流由代码掌握。
 *
 * 这里应用的规则(来自 docs.typesafe.ai):
 *  - 问题 id 不会发给模型,所以每条 instructions 必须是完整的问题
 *  - 用反引号路径引用 state(`transcript`、`page.site`、`elements`)
 *  - Choice 选项使用统一的对比结构 {what, not_for, examples}
 *  - 永远包含 `none` 选项;从不让 Jev 数数或生成文本
 */

export const MODEL = "jev-1.13.0"; // 锁定版本:别名会随发布变动,下面的阈值是在这个版本上调的

export const PRICE_PER_M_INPUT_TOKENS_USD = 0.042; // 输出 token 免费

// ---------------------------------------------------------------------------
// 感知上限(state 体积伤害准确率 + 延迟;保持精简)
// ---------------------------------------------------------------------------
export const MAX_ELEMENTS = 100; // 发给 Jev 的元素硬上限(Choice 上限 255;token 越多延迟越高)
export const MAX_ELEMENT_TEXT = 60; // 每个元素标签的字符数
export const MAX_STATE_CHARS = 24_000; // ~6k token;远低于 32k token 的 state 上限
export const MAX_TRANSCRIPT_CHARS = 400;
// 随每个请求发送的会话上下文:最近一次导航之前的页面,以及最近几个已执行的操作
// (说了什么、做了什么、结果如何)。让 Jev 能解析"回到结果页""另一个""不,不是这个"
// "打开它的文档"(我刚打开的那个东西的)。刻意保持很小 —— 无关的 state 损害准确率。
export const MAX_CONTEXT_ACTIONS = 3;

// ---------------------------------------------------------------------------
// 时序
// ---------------------------------------------------------------------------
export const DEBOUNCE_MS = 200; // 最后一次转写更新后等多久再问 Jev
export const MAX_INFLIGHT = 2; // 允许的重叠 Jev 请求数;旧的用 AbortSignal 取消
export const SILENCE_COMPLETE_MS = 900; // 这么久没有新词 => 视为命令已说完
// 携带自由文本的意图(查询词或要输入的文字)不能在句中执行 —— "搜索艾伦"听起来
// 是完整命令,但载荷可能还在生长。它们要等识别器的最终结果,或这么久的沉默。
export const PAYLOAD_SILENCE_MS = 600;
export const PAYLOAD_INTENTS = new Set(["search_web", "type_into_field", "select_option"]);
export const HIGHLIGHT_MS = 600; // 受控页面上的元素闪烁时长
export const CANDIDATE_TTL_MS = 8000; // 编号浮层保留这么久

// ---------------------------------------------------------------------------
// 执行策略阈值(UI 里"为什么执行/等待"的那些数字)
// ---------------------------------------------------------------------------
export const T = {
  intentConfidence: 0.55, // 要执行任何动作,`intent` Choice 需要的置信度
  complete: 0.6, // `complete` Noul:用户已说完命令(SILENCE_COMPLETE_MS 之后旁路)
  isCommand: 0.5, // `is_command` Noul:用户是否在对浏览器说话
  destructive: 0.5, // `destructive` Noul 高于此 => 需要口头确认 ...
  destructiveIntentConfidence: 0.9, // ... 除非 intent 置信度有这么高,且用户已说了"确认"
  targetConfidence: 0.45, // `target` Choice 低于此 => 显示编号候选浮层而不是直接点击
  targetTopProb: 0.35, // 且获胜元素至少要有这个概率
  spanConfidence: 0.35, // `text_span` / `url_span` 的选择低于此 => 回退到启发式候选
  candidateCount: 3, // 目标含糊时浮层显示的候选数
  correction: 0.6, // `is_correction` Noul:用户在撤销/改指上一操作("不,不是这个")
};

export const TARGET_INTENTS = new Set(["click_element", "type_into_field", "select_option"]);

// ---------------------------------------------------------------------------
// 站点(URL 由代码掌握;Jev 只挑名字)
// ---------------------------------------------------------------------------
export const SITE_HOME = {
  google: "https://www.google.com/",
  duckduckgo: "https://duckduckgo.com/",
  youtube: "https://www.youtube.com/",
  wikipedia: "https://en.wikipedia.org/wiki/Main_Page",
  github: "https://github.com/",
  amazon: "https://www.amazon.com/",
  reddit: "https://www.reddit.com/",
  twitter_x: "https://x.com/",
  hacker_news: "https://news.ycombinator.com/",
  example_com: "https://example.com/",
  baidu: "https://www.baidu.com/",
  bilibili: "https://www.bilibili.com/",
  zhihu: "https://www.zhihu.com/",
};

// 搜索 URL 模板;`%s` 替换为 URL 编码后的查询词。
export const SITE_SEARCH = {
  google: "https://www.google.com/search?q=%s",
  duckduckgo: "https://duckduckgo.com/?q=%s",
  the_web: "https://duckduckgo.com/?q=%s",
  youtube: "https://www.youtube.com/results?search_query=%s",
  wikipedia: "https://en.wikipedia.org/w/index.php?search=%s",
  github: "https://github.com/search?q=%s&type=repositories",
  amazon: "https://www.amazon.com/s?k=%s",
  reddit: "https://www.reddit.com/search/?q=%s",
  twitter_x: "https://x.com/search?q=%s",
  hacker_news: "https://hn.algolia.com/?q=%s",
  baidu: "https://www.baidu.com/s?wd=%s",
  bilibili: "https://search.bilibili.com/all?keyword=%s",
  zhihu: "https://www.zhihu.com/search?type=content&q=%s",
};

export const DEFAULT_SEARCH_ENGINE = "duckduckgo";

// ---------------------------------------------------------------------------
// 问题。每次转写更新只用一个请求全部问出(投机式并行)。
// ---------------------------------------------------------------------------

export const INTENT_CRITERIA = {
  navigate_url: {
    what: "打开指定的网站或网址(打开/去/访问 <站点>)",
    not_for: "搜索某个主题;打开页面上已有的链接/文档/按钮(那是 click_element)",
    examples: ["打开维基百科", "去B站", "访问 github.com", "打开 example 点 com"],
  },
  search_web: {
    what: "搜索某个主题或词组(搜索/查一下/百度一下 <查询词>),可以在全网或指定网站上",
    not_for: "往指定的输入框里打字而不搜索;打开某网站首页",
    examples: ["搜索艾伦图灵", "查一下 typesafe jev", "谷歌一下便宜的机票", "在维基百科上搜猫"],
  },
  click_element: {
    what: "点击/按下/打开/选择当前页面上的链接、按钮、选项卡、结果或条目(包括\"打开\"页面上已有的东西,如文档、评论区)",
    not_for: "按名字打开网站;输入文字",
    examples: ["点击第一个结果", "点登录", "打开第二条链接", "按下更多信息链接", "打开文档"],
  },
  type_into_field: {
    what: "往页面上的输入框、搜索框或文本框里输入指定文字",
    not_for: "在搜索引擎上执行搜索(那是 search_web);只按回车",
    examples: ["在搜索框里输入你好世界", "输入我的邮箱", "在评论框里写早上好"],
  },
  select_option: {
    what: "从下拉菜单/选择框里选一个选项",
    not_for: "点击链接或按钮",
    examples: ["在语言下拉框里选中文", "选大号"],
  },
  press_enter: {
    what: "按回车键,或提交已输入的内容",
    not_for: "输入文字;点击指名道姓的按钮",
    examples: ["按回车", "回车", "提交"],
  },
  scroll_down: {
    what: "向下滚动/移动页面",
    not_for: "向上滚动;导航",
    examples: ["往下滚", "往下滚一点", "滚到页面底部", "下一屏"],
  },
  scroll_up: {
    what: "向上滚动/移动页面",
    not_for: "向下滚动",
    examples: ["往上滚", "回到页面顶部", "上一屏"],
  },
  go_back: {
    what: "返回历史记录的上一页(返回/后退/上一页/撤销那个)",
    not_for: "向上滚动;关闭标签页",
    examples: ["返回", "返回上一页", "后退", "回到上一页"],
  },
  go_forward: {
    what: "在历史记录里前进到下一页",
    not_for: "向下滚动",
    examples: ["前进", "下一页历史", "往前走一页"],
  },
  reload: {
    what: "刷新/重新加载当前页面",
    not_for: "导航去别处",
    examples: ["刷新", "重新加载页面"],
  },
  open_new_tab: {
    what: "打开一个新的空白标签页",
    not_for: "在当前标签页按名字打开网站",
    examples: ["打开一个新标签页", "新标签页"],
  },
  close_tab: {
    what: "关闭当前标签页",
    not_for: "返回上一页",
    examples: ["关闭这个标签页", "关掉标签页"],
  },
  switch_tab: {
    what: "切换到另一个/下一个/上一个标签页",
    not_for: "打开或关闭标签页",
    examples: ["下一个标签页", "切换标签页", "去另一个标签页"],
  },
  confirm: {
    what: "同意浏览器正在等待确认的操作(确认/是的/执行吧/好的做吧)",
    not_for: "新命令",
    examples: ["确认", "是的执行", "好的做吧"],
  },
  cancel: {
    what: "取消/算了/停止待确认的操作",
    not_for: "在历史里返回上一页",
    examples: ["取消", "算了", "停止"],
  },
  none: {
    what: "不是浏览器命令,或暂时还识别不出(碎片、闲聊、沉默、语气词)",
    not_for: "任何明确匹配其他选项的情况",
    examples: ["嗯", "就是说", "你觉得呢", "今天天气不错"],
  },
};

export const SITE_CRITERIA = {
  google: "谷歌(google、谷歌一下)",
  duckduckgo: "DuckDuckGo",
  the_web: "泛指全网搜索,没有点名具体网站(搜一下、在网上查)",
  youtube: "YouTube / 油管(视频)",
  wikipedia: "维基百科(百科)",
  github: "GitHub(代码、仓库)",
  amazon: "亚马逊(购物)",
  reddit: "Reddit",
  twitter_x: "推特 / X",
  hacker_news: "Hacker News(news.ycombinator.com、HN)",
  example_com: "example.com / example 点 com",
  baidu: "百度(百度一下)",
  bilibili: "B站 / 哔哩哔哩(视频)",
  zhihu: "知乎(问答)",
  other_named_site: "`transcript` 里明确点名的其他网站(上面没列出的域名或品牌名)",
  none: "`transcript` 里没提到任何网站或搜索引擎",
};

export const QUESTIONS = {
  intent: {
    instructions: {
      question: "用户在 `transcript` 里要求执行哪个浏览器操作?",
      focus:
        "只根据已说出的字判断。句子没说完时,选词语已经确定指向的操作;识别不出就选 none。`page` 和 `elements` 描述当前屏幕上的内容。`context.previous_page` 和 `context.recent_actions`(最近的在前)说明用户刚从哪来、刚做了什么:点击搜索结果之后说\"回到结果页\"是 go_back;点击之后说\"另一个\"或\"不是这个\"是对另一个元素的 click_element。",
    },
    criteria: INTENT_CRITERIA,
  },

  target: {
    instructions: {
      question:
        "`elements` 里哪个元素是 `transcript` 所指的(要点击、输入或选择的对象)?`elements` 每行以元素 id 开头(如 e07),后跟角色和可见文字;选项就是这些 id。",
      focus:
        "按元素的可见文字、角色和位置词匹配(第一个/第二个/最上面;行按视觉顺序排列,页面顶部在前)。用 `context.recent_actions` 解析相对指代:\"另一个\"/\"下一个\"/\"不是这个\"指最近一次操作目标之外的其他元素;\"打开它的文档\"指刚打开的页面或条目的文档。命令不涉及页面上的元素、或所指元素不在列表里时选 none。",
    },
    // criteria 每个请求按元素列表 + none 动态构建
  },

  site: {
    instructions: {
      question: "`transcript` 里提到了哪个网站或搜索引擎?",
      focus: "只看明确说出的内容。没点名任何站点就选 none。",
    },
    criteria: SITE_CRITERIA,
  },

  complete: {
    instructions: {
      question:
        "用户是否已把 `transcript` 里的命令说完,可以现在执行而不用再等更多的话?",
      focus:
        "语音逐词到达。动词和必需的宾语都在场时命令才算完整(打开要带站点,搜索要带查询词,点击要带元素,输入要带文字)。",
    },
    criteria: {
      true: {
        what: "完整、可执行的命令",
        examples: ["往下滚", "返回上一页", "打开维基百科", "搜索艾伦图灵", "点击第一个结果"],
      },
      false: {
        what: "在必需宾语之前被截断;显然还有话要说",
        examples: ["打开", "搜索", "点击", "输入", "打开这个", "滚动"],
      },
    },
  },

  is_command: {
    instructions: {
      question:
        "`transcript` 是一条对网页浏览器下达的指令吗(导航、搜索、点击、输入、滚动、标签页、确认/取消)?",
      focus:
        "闲聊、自言自语、在和另一个人说话、或零碎的片段都不是命令。对浏览器刚做的事的反应(`context.recent_actions` 里的\"不,不是这个\"\"撤销那个\"\"点错了\"\"是的确认\")是对浏览器说的。",
    },
    criteria: {
      true: {
        what: "对浏览器下达的命令,或对其上一操作的纠正/确认",
        examples: ["往下滚", "打开哔哩哔哩", "点击登录", "不不是这个", "撤销那个", "确认"],
      },
      false: {
        what: "不是对浏览器说的",
        examples: ["我觉得中午该吃饭了", "嗯就是说", "这是演示", "你刚说什么"],
      },
    },
  },

  destructive: {
    instructions: {
      question:
        "在这个 `page` 上执行 `transcript` 里的操作,会提交表单、下单、付款、删除、发送消息、公开发布、退出登录,或其他难以撤销的事吗?",
      focus: "导航、滚动、阅读、点击链接、在输入框里打字都不算破坏性。",
    },
    criteria: {
      true: {
        what: "不可逆的副作用",
        examples: ["点击立即购买", "删除这个仓库", "发送这条消息", "发布评论", "点击结算"],
      },
      false: {
        what: "可逆 / 只读",
        examples: ["往下滚", "打开维基百科", "点击第一个结果", "在搜索框里输入你好"],
      },
    },
  },

  scroll_amount: {
    instructions: {
      question: "按 `transcript` 的说法,用户想滚动多远?",
      focus: "只在滚动时相关;没说幅度时默认一屏。",
    },
    criteria: [
      { what: "一点点:几行(一点、稍微、一点点)" },
      { what: "一屏/一页,或没说幅度" },
      { what: "一直到底:最顶部或最底部" },
    ],
  },

  text_span: {
    instructions: {
      question:
        "哪个选项恰好是用户想输入或搜索的文字,如 `transcript` 里所说?选项是逐字的候选片段。",
      focus:
        "选只包含载荷文字本身的片段,不含命令词(输入、搜索、到搜索框里)。不该输入任何东西就选 none。",
    },
  },

  url_span: {
    instructions: {
      question: "哪个选项是用户想打开的网址(域名),如 `transcript` 里所说?",
      focus: "没提到任何地址就选 none。",
    },
  },

  // 只在 `context.recent_actions` 非空时询问。
  is_correction: {
    instructions: {
      question:
        "`transcript` 里的用户是在说 `context.recent_actions` 里最近一次操作做错了、应该撤销或改做别的吗?",
      focus:
        "纠正是对刚发生的事的反应(\"不\"\"不是这个\"\"点错了\"\"撤销那个\"\"另一个\"\"我意思是第二个\")。只是跟在上一操作之后的新命令不是纠正。",
    },
    criteria: {
      true: {
        what: "否定或改指上一操作",
        examples: ["不不是这个", "点错了返回", "撤销那个", "我意思是另一条", "不是那个,是第二个"],
      },
      false: {
        what: "新命令或延续,对上一操作满意",
        examples: ["往下滚", "现在点评论", "打开文档", "搜索猫"],
      },
    },
  },

  tab_direction: {
    instructions: {
      question: "切换标签页时,`transcript` 指的是哪个标签页?",
    },
    criteria: {
      next: "下一个标签页 / 另一个标签页 / 没说方向的\"切换标签页\"",
      previous: "上一个标签页 / 前一个标签页",
      first: "第一个标签页",
      none: "不是在说切换标签页",
    },
  },
};
