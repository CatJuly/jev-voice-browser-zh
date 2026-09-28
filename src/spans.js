/**
 * 候选提取(纯代码,不经 Jev)。Jev 从不生成文本:这里从转写文本中过度生成候选片段,
 * Jev 只负责挑选,被选中的内容逐字复制进浏览器。
 *
 * 中文要点(JS 的 \b 只认 ASCII 词字符,对汉字无效):
 *  - 所有模式用字符类与显式锚点,不用 \b
 *  - cleanTranscript 删除汉字之间的空格(识别器空格风格不稳定,统一掉)
 *  - 词数统计按"汉字逐字计、拉丁按空格词计"(wordCount)
 *  - 名词用法(搜索框/输入框)与单音节动词的合成词(打算/写作/查看)用负向先行排除
 */

// CJK 汉字区(扩展A + 基本区 + 兼容区)
const HAN = "\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff";
const HAN_CHAR_RE = new RegExp(`[${HAN}]`);
// 与汉字邻接时视为中文语境的字符(CJK 标点、全角、弯引号、直角引号)
const CJK_ADJ = `${HAN}\\u3000-\\u303f\\uff00-\\uffef\\u201c\\u201d\\u2018\\u2019`;

const TLDS = "com|cn|org|net|io|ai|dev|co|edu|gov|de|uk|us|app|xyz|info|me|tv|ch|at|fr|nl|es|it";

// 填充词:只在候选片段两端剥(迭代到不动点),不做全局替换 —— 否则会啃坏载荷("写好评"的"好")。
const LEADING_FILLER_RE =
  /^(?:麻烦你|麻烦|帮我|请|那个|然后|接着|好的|现在|就是|我想|我要|给我|来个|嗯嗯|嗯|呃|哎|诶|啊)+/;
const TRAILING_PARTICLE_RE = /(?:一下|吧|呗|嘛|哦|呀|啦|哈|呢)+$/;
const TRAILING_PUNCT_RE = /[。!?,、.!?,;:~～…—]+$/;

// 载荷动词。alternation 长词在前(中文没有 \b,靠顺序防"搜索"被"搜"抢先);
// (?:一下|下|个)? 吸收轻量后缀,"搜一下天气"的载荷是"天气"。
const TEXT_VERB_RE = new RegExp(
  "(?:搜索(?![框栏页果擎史录])|搜(?!索)|查找|查(?![看询处证收])|寻找|找(?![到出齐])|百度一下|谷歌一下" +
    "|输入(?![框栏法])|打字|打(?![算开断印扫扮击造包扰量卡拼败消发听赏架折底磨])" +
    "|填写|填|写(?![作法实意真着道完满字]))(?:一下|下|个)?",
  "gu",
);

// 把字句:载荷在动词之前("把你好世界输入到搜索框")。只用复合动词,避免"把声音打开"误命中。
const BA_RE = new RegExp(
  `把(.{1,60}?)(?:输入|打进|打上|打入|写入|写进|写到|写上|填写|填入|填进|填上|填到|粘贴进|粘贴到|粘贴)`,
  "gu",
);

// 尾部目的地名词(不含裸"框|栏",防止"输入相框"被剥空)。
const DEST_NOUNS =
  "搜索框|输入框|文本框|地址栏|对话框|编辑框|输入栏|搜索栏|回复框|评论框|评论区|评论|留言框|留言板|备注框|表单|搜索|输入";

// 剥掉载荷末尾的"…(输入/打/写)到搜索框里"尾巴。必须锚定串尾且有介词/动词作锚,
// 否则"艾伦图灵到搜索框"会从载荷中间开始吃字。
const TRAILING_DEST_RE = new RegExp(
  [
    "(?:输入|打|写|填|粘贴|发送|提交)?(?:到|进|在|入|至)[一-龥的]{0,6}?(?:" + DEST_NOUNS + ")(?:里|中|内|上面|上|面|头|当中|里面)?$",
    "(?:输入|写入|打进|打上|填入|填进|填上|粘贴进|粘贴到)(?:" + DEST_NOUNS + ")(?:里|中|内|上)?$",
  ].join("|"),
  "u",
);

// 引号片段(最强信号;语音转写很少输出引号,主要服务键入路径)。书名号《》/【】有意排除。
const QUOTE_RE = /["“”‘’「」『』]([^"“”‘’「」『』]{1,120})["“”‘’「」『』]/g;

// 动词后载荷开头的站点名:"搜索维基百科上的猫" -> "猫"(站点本身由 site 问题负责)。
const LEADING_SITE_RE =
  /^(?:百度|必应|谷歌|google|duckduckgo|youtube|油管|维基百科|维基|wikipedia|github|亚马逊|amazon|reddit|推特|twitter|网上|互联网)(?:上面|上|里|中)?的?/;

// 汉字之间的空格(识别器风格不稳定)
const CJK_BOUNDARY_SPACE_RE = new RegExp(`(?<=[${CJK_ADJ}]) +(?=[${CJK_ADJ}])`, "g");

export function cleanTranscript(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(CJK_BOUNDARY_SPACE_RE, "") // "打开 维基 百科" -> "打开维基百科"
    .trim();
}

function stripFiller(s) {
  let prev;
  do {
    prev = s;
    s = s.replace(LEADING_FILLER_RE, "").replace(TRAILING_PARTICLE_RE, "").replace(TRAILING_PUNCT_RE, "");
  } while (s !== prev);
  return s.replace(/\s+/g, " ").trim();
}

function pushUnique(list, value) {
  const v = stripFiller(value);
  if (!v) return;
  if (v.length > 120) return;
  if (list.some((x) => x.toLowerCase() === v.toLowerCase())) return;
  list.push(v);
}

/**
 * 输入/搜索类意图的载荷文本候选。空转写返回 []。顺序:最可能在前
 * (引号 → 把字句 → 动词后 → 整句兜底)。
 */
export function extractTextCandidates(transcript) {
  const t = cleanTranscript(transcript);
  if (!t) return [];
  const out = [];

  // 1. 引号片段
  for (const m of t.matchAll(QUOTE_RE)) pushUnique(out, m[1]);

  // 2. 把字句:载荷在动词之前
  for (const m of t.matchAll(BA_RE)) {
    const x = m[1].replace(/^["“”‘’「」『』]+|["“”‘’「」『』]+$/g, "");
    pushUnique(out, x);
  }

  // 3. 动词之后的载荷(matchAll 按出现位置排序 = 最早的动词优先)
  for (const m of t.matchAll(TEXT_VERB_RE)) {
    const tail = t.slice(m.index + m[0].length);
    if (!tail || /^[到进在入至里上]/.test(tail)) continue; // 介词开头 = 载荷在动词前(把字句残影),跳过
    const noSite = tail.replace(LEADING_SITE_RE, "");
    const stripped = noSite.replace(TRAILING_DEST_RE, "");
    pushUnique(out, stripped);
    if (stripped !== noSite) pushUnique(out, noSite);
  }

  // 4. 整句兜底
  pushUnique(out, t);

  return out.slice(0, 8);
}

/** "example 点 com" -> "example.com";仅在 ASCII 字母数字邻接时替换(防"九点开会")。 */
export function normalizeSpokenUrl(text) {
  return String(text || "")
    .toLowerCase()
    // 口播协议头:"h t t p s 冒号 斜杠 斜杠"(或 ASCII "h t t p : / /")
    .replace(/\bh\s*t\s*t\s*p\s*s?(?:\s*:\s*\/\s*\/|\s*冒号\s*斜杠\s*斜杠\s*)(?=[a-z0-9])/g,
      (m) => (m.includes("s") ? "https://" : "http://"))
    // "点":前是 ASCII 字母数字、后必须是 ASCII 字母(排除"九点开会"与"3点15")
    .replace(/([a-z0-9])\s*点\s*(?=[a-z])/g, "$1.")
    // "斜杠":两侧均为 ASCII 字母数字
    .replace(/([a-z0-9])\s*斜杠\s*(?=[a-z0-9])/g, "$1/")
    .replace(/\s*\.\s*/g, ".")
    .replace(/\bwww\s+/g, "www.")
    .replace(/\s+\/\s*/g, "/");
}

/** 转写文本里像域名的片段(口播 URL 规范化之后)。 */
export function extractUrlCandidates(transcript) {
  const t = normalizeSpokenUrl(cleanTranscript(transcript));
  if (!t) return [];
  // 注意:动态正则用字符串拼接(模板字面量会吃掉 \. \s 的反斜杠)
  const re = new RegExp("(?:https?://)?(?:[a-z0-9-]+\\.)+(?:" + TLDS + ")(?:/[^\\s]*)?", "gi");
  const out = [];
  for (const m of t.matchAll(re)) {
    const v = m[0].replace(/[.,!?;:、。!?,;:~～…]+$/, "");
    if (!out.includes(v)) out.push(v);
  }
  return out.slice(0, 6);
}

export function toHttpUrl(domainish) {
  const v = String(domainish).trim();
  if (/^https?:\/\//i.test(v)) return v;
  return `https://${v}`;
}

const CN_NUM = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function hanToNum(s) {
  if (/^十/.test(s)) return 10 + (CN_NUM[s[1]] ?? 0);
  if (/十$/.test(s)) return CN_NUM[s[0]] * 10;
  if (s.includes("十")) {
    const [a, b] = s.split("十");
    return CN_NUM[a] * 10 + (CN_NUM[b] ?? 0);
  }
  return CN_NUM[s];
}

// 编号选取的停用字:剥掉后,剩下的必须恰好是一个纯数字表达
const PICK_STRIP_RE = /[选点点击选择挑第个号条行项就还要来吧呢啊嘛哦呀那个此数字编号链接结果打开搜索帮我请麻烦一下]/g;

/**
 * 页面上有编号候选浮层时,一个裸数字表达("二"/"第二个"/"数字三")就是确定的选择,
 * 无需询问 Jev。返回 1 起始的序号;不是纯数字表达则返回 null。
 */
export function parseCandidatePick(transcript, max = 5) {
  const t = cleanTranscript(transcript).toLowerCase().replace(/[.,!?~…、,。!?;:;:]/g, "");
  if (!t || t.length > 12) return null; // 长句保险丝;主闸门是下面的"纯度"检查
  const s = t.replace(PICK_STRIP_RE, "");
  if (!s) return null;
  let n = null;
  if (/^\d+$/.test(s)) n = Number(s);
  else if (/^[零一二两三四五六七八九十]{1,3}$/.test(s)) n = hanToNum(s);
  if (n == null || !Number.isInteger(n) || n < 1 || n > max) return null;
  return n;
}

/** 词数估计:拉丁按空格词计,汉字逐字计。"搜索艾伦图灵"=6,"嗯"=1,"go back"=2。 */
export function wordCount(text) {
  let n = 0;
  for (const tok of String(text || "").split(/\s+/)) {
    if (!tok) continue;
    let run = 0; // 当前连续非汉字段长度
    for (const ch of tok) {
      if (HAN_CHAR_RE.test(ch)) {
        if (run) n += 1; // 收口前一个拉丁/数字段
        run = 0;
        n += 1; // 每个汉字记 1
      } else {
        run += 1;
      }
    }
    if (run) n += 1; // 段尾收口
  }
  return n;
}

const ASCII_WORD_CHAR = /[A-Za-z0-9]/;

/** 拼接已执行前缀与新文本:两侧都是 ASCII 词字符才补空格,汉字间直接相连。 */
export function smartJoin(a, b) {
  if (!a) return String(b || "");
  if (!b) return String(a || "");
  return ASCII_WORD_CHAR.test(a[a.length - 1]) && ASCII_WORD_CHAR.test(b[0]) ? `${a} ${b}` : a + b;
}

const SPLIT_TOKEN_RE = new RegExp("[" + HAN + "]+|[A-Za-z0-9][A-Za-z0-9'’._\\-]*", "g");

/** 把一句话切成回放块:连续拉丁/数字按词,连续汉字按 2-3 字一组(剩 4 字时 2+2)。 */
export function splitSay(text) {
  const chunks = [];
  for (const m of String(text || "").matchAll(SPLIT_TOKEN_RE)) {
    const tok = m[0];
    if (!HAN_CHAR_RE.test(tok[0])) {
      chunks.push(tok);
      continue;
    }
    let i = 0;
    while (i < tok.length) {
      const rem = tok.length - i;
      const size = rem === 4 ? 2 : Math.min(3, rem);
      chunks.push(tok.slice(i, i + size));
      i += size;
    }
  }
  return chunks;
}
