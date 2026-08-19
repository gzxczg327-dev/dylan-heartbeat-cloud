// ============================================================
// Dylan Heartbeat — Cloudflare Worker 版
// 在 Cloudflare 边缘网络运行，永久免费、永不休眠、无需绑卡。
//
// 功能与原 Node 版一致：
//   - /v1/chat/completions、/v1/models（Kelivo 接入）
//   - /admin 管理页（状态 / 日记 / 预设 / 配置，与原版一致）
//   - Cron 定时自动唤醒，AI 自主决定是否推送 Bark/ntfy 到手机
//   - 时间线 / 日记 / 配置 存 Workers KV
//
// 部署方式见 README.md
// ============================================================

// ---------- 默认配置（对应 .env.example） ----------
const DEFAULTS = {
  TARGET_API_URL: "https://api.deepseek.com/v1/chat/completions",
  TARGET_API_KEY: "",
  GATEWAY_API_KEY: "",
  MODEL_NAME: "deepseek-v4-flash",
  BARK_KEY: "",
  CUSTOM_ICON_URL: "",
  PUSH_TITLE: "DeepSeek",
  PUSH_PROVIDER: "bark",
  NTFY_SERVER_URL: "https://ntfy.sh",
  NTFY_TOPIC: "",
  NTFY_TOKEN: "",
  NTFY_PRIORITY: "default",
  NTFY_TAGS: "",
  DIARY_ENABLED: "true",
  DIARY_DIR: "diary",
  MULTIMODAL_MODE: "passthrough",
  // 唤醒节奏（与原版一致）：白天/夜间使用不同的唤醒阈值与检查间隔
  DAY_WAKE_AFTER_MINUTES: "60",
  NIGHT_WAKE_AFTER_MINUTES: "120",
  DAY_CHECK_INTERVAL_MINUTES: "10",
  NIGHT_CHECK_INTERVAL_MINUTES: "120",
  WAKE_DAY_START_HOUR: "10",
  WAKE_DAY_END_HOUR: "24",
  // 唤醒随机化：超过基础阈值后，再随机等待 阈值×(min~max) 分钟，节奏更自然
  WAKE_RANDOM_MIN: "1.0",
  WAKE_RANDOM_MAX: "2.5",
  // 推送冷却：发送推送后最短等待分钟数
  PUSH_COOLDOWN_MINUTES: "90",
  // 例假周期：填上次开始日期(YYYY-MM-DD)后，AI 会知道周期阶段并关心提醒
  PERIOD_START_DATE: "",
  PERIOD_CYCLE_DAYS: "28",
  PERIOD_DURATION_DAYS: "5",
  WEATHER_ENABLED: "false",
  WEATHER_LOCATION_NAME: "",
  WEATHER_LAT: "",
  WEATHER_LON: "",
  WEATHER_UNITS: "metric",
  TIME_ZONE: "Asia/Shanghai",
  ADMIN_USER: "admin",
  ADMIN_PASSWORD: ""
};

// 读取配置：KV 覆盖环境变量，环境变量覆盖默认值（管理页保存即写 KV，即时生效）
async function loadConfig(env) {
  const cfg = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (env[key] !== undefined && env[key] !== null && env[key] !== "") cfg[key] = String(env[key]);
  }
  try {
    const saved = await env.CONFIG.get("config", "json");
    if (saved && typeof saved === "object") {
      // 只让 KV 里的非空值覆盖环境变量，避免管理页保存时空值把 Secret 抹掉
      for (const [key, value] of Object.entries(saved)) {
        if (value !== undefined && value !== null && value !== "") cfg[key] = value;
      }
    }
  } catch {}
  // 兜底：在 await（KV 网络请求）之后再读一次管理员账号密码，
  // 解决 Cloudflare 边缘节点 secret 注入的时序问题（请求极早期可能尚未就绪）。
  if (env.ADMIN_USER) cfg.ADMIN_USER = String(env.ADMIN_USER);
  if (env.ADMIN_PASSWORD) cfg.ADMIN_PASSWORD = String(env.ADMIN_PASSWORD);
  return cfg;
}

async function saveConfig(env, updates) {
  const cfg = { ...DEFAULTS };
  try {
    const saved = await env.CONFIG.get("config", "json");
    if (saved && typeof saved === "object") Object.assign(cfg, saved);
  } catch {}
  Object.assign(cfg, updates);
  // 只存非空值：空字符串不写入，环境变量（Secret）保持优先
  const toStore = {};
  for (const [key, value] of Object.entries(cfg)) {
    if (value !== undefined && value !== null && value !== "") toStore[key] = value;
  }
  await env.CONFIG.put("config", JSON.stringify(toStore));
  return cfg;
}

function readBool(cfg, key, fallback = false) {
  const raw = String(cfg[key] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

function readNumber(cfg, key, fallback, min = -Infinity, max = Infinity) {
  const n = Number(cfg[key]);
  if (Number.isFinite(n) && n >= min && n <= max) return n;
  return fallback;
}

// ---------- KV 工具 ----------
async function kvGetJson(kv, key, fallback) {
  try {
    const v = await kv.get(key, "json");
    return v === null || v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

async function kvPutJson(kv, key, value) {
  await kv.put(key, JSON.stringify(value));
}

async function loadPresets(env) {
  return kvGetJson(env.CONFIG, "presets", []);
}

async function savePresets(env, presets) {
  await kvPutJson(env.CONFIG, "presets", presets);
}

// ---------- 消息处理（移植自 server.js） ----------
function normalizeContentToText(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
        if (type === "text" || type === "input_text") return part.text || part.content || "";
        if (part.image_url || type.includes("image")) return "[图片]";
        if (part.file || type.includes("file")) return "[文件]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") {
    const type = typeof content.type === "string" ? content.type.toLowerCase() : "";
    if (content.image_url || type.includes("image")) return "[图片]";
    if (content.file || type.includes("file")) return "[文件]";
  }
  return "[非文本内容]";
}

function isSpecialEvent(msg) {
  if (msg?.role !== "assistant") return false;
  const c = normalizeContentToText(msg.content);
  return (
    c.includes("刚刚给宝宝发了 Bark") ||
    c.includes("刚刚给用户发了 Bark") ||
    c.includes("自动唤醒：本次未发送 Bark") ||
    c.includes("自动唤醒：本次未发送推送") ||
    (c.includes("刚刚给用户发了") && c.includes("推送"))
  );
}

function isRealMessageForTimeline(msg) {
  if (msg.role === "system") return false;
  if (msg.tool_calls) return false;
  if (isSpecialEvent(msg)) return false;
  const contentText = normalizeContentToText(msg.content);
  if (msg.role === "user" && contentText.trim().startsWith("<system>")) return false;
  return msg.role === "user" || msg.role === "assistant";
}

// 从特殊事件里提取 AI 主动发的推送正文（标题｜正文），用于在聊天记录里显示
function extractProactivePushContent(msg) {
  if (!isSpecialEvent(msg)) return null;
  const c = stripLeadingTimestamp(normalizeContentToText(msg.content));
  const m = c.match(/刚刚给用户发了(?:Bark|[\s\S]*?)推送：([\s\S]+)/);
  if (!m) return null;
  const body = m[1].trim().replace(/[）)]\s*$/, "").trim();
  return body || null;
}

// 从特殊事件里取原始本地时间字符串（如 "2026-08-18 14:30"），避免跨时区重解析出错
function extractTimestampString(content) {
  const match = String(content || "").match(/（?\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]?)\d{1,2}[:：]\d{2})/);
  return match ? match[1] : "";
}

// 从特殊事件里取「时间 + 推送正文」，供聊天/唤醒注入，让 AI 知道自己什么时候发过什么
function extractProactivePushRecord(msg) {
  if (!isSpecialEvent(msg)) return null;
  const body = extractProactivePushContent(msg);
  if (!body) return null;
  return { time: extractTimestampString(normalizeContentToText(msg.content)), body };
}

function parseTimestampLabel(value) {
  const text = String(value || "");
  const match = text.match(/（?\s*(\d{4})([-/])(\d{1,2})\2(\d{1,2})(?:[ T]?)(\d{1,2})[:：](\d{2})/);
  if (!match) return null;
  const [, yyyy, , month, day, hour, minute] = match;
  const normalized = `${yyyy}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")} ${String(hour).padStart(2, "0")}:${minute}`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function stripLeadingTimestamp(content) {
  return String(content || "")
    .replace(/^（?\s*\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]?)\d{1,2}[:：]\d{2}[）\s]*/, "")
    .trim();
}

function extractTimestamp(content) {
  return parseTimestampLabel(content);
}

function makeFingerprint(msg) {
  const raw = normalizeContentToText(msg.content);
  const content = raw.trim().slice(0, 150);
  return `${msg.role}::${content}`;
}

function makeFingerprintStripped(msg) {
  const raw = normalizeContentToText(msg.content);
  const content = stripLeadingTimestamp(raw).slice(0, 150);
  return `${msg.role}::${content}`;
}

// ---------- 时间线（存 KV key "timeline"） ----------
async function loadTimeline(env) {
  return kvGetJson(env.CONFIG, "timeline", []);
}

async function saveTimeline(env, messages) {
  const sp = messages.find(m => m.role === "system");
  const nonSP = messages.filter(m => m.role !== "system");
  const trimmed = nonSP.slice(-49);
  const final = sp ? [sp, ...trimmed] : trimmed;
  await kvPutJson(env.CONFIG, "timeline", final);
}

async function loadTimestampDB(env) {
  return kvGetJson(env.CONFIG, "timestamps", {});
}

async function saveTimestampDB(env, db) {
  await kvPutJson(env.CONFIG, "timestamps", db);
}

function extractTimestampWithMemory(msg, tsDB) {
  const fromContent = extractTimestamp(normalizeContentToText(msg.content));
  if (fromContent) return fromContent;
  const fp = makeFingerprint(msg);
  if (tsDB[fp]) return new Date(tsDB[fp]);
  const fpStripped = makeFingerprintStripped(msg);
  if (tsDB[fpStripped]) return new Date(tsDB[fpStripped]);
  return null;
}

function buildTimeline(newMessages, oldTimeline, tsDB) {
  const newSystemMessages = newMessages
    .filter(msg => msg.role === "system")
    .map(msg => ({ ...msg, content: normalizeContentToText(msg.content) }));
  const latestSP = newSystemMessages.length > 0 ? newSystemMessages[newSystemMessages.length - 1] : null;
  const oldSP = oldTimeline.find(msg => msg.role === "system");

  const newRealMessages = newMessages
    .filter(isRealMessageForTimeline)
    .map(msg => ({ ...msg, content: normalizeContentToText(msg.content) }));

  const oldSpecialEvents = oldTimeline.filter(isSpecialEvent).sort((a, b) => {
    const timeA = extractTimestampWithMemory(a, tsDB);
    const timeB = extractTimestampWithMemory(b, tsDB);
    if (timeA && timeB) return timeA - timeB;
    return 0;
  });

  const merged = [...newRealMessages];
  for (const event of oldSpecialEvents) {
    const eventTime = extractTimestampWithMemory(event, tsDB);
    if (!eventTime) { merged.push(event); continue; }
    let inserted = false;
    for (let i = 0; i < merged.length; i++) {
      const msgTime = extractTimestampWithMemory(merged[i], tsDB);
      if (msgTime && msgTime >= eventTime) {
        merged.splice(i, 0, event);
        inserted = true;
        break;
      }
    }
    if (!inserted) merged.push(event);
  }

  const seen = new Set();
  const unique = merged.filter(msg => {
    const key = JSON.stringify({ role: msg.role, content: msg.content });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const result = [];
  if (latestSP) result.push({ ...latestSP, position: 0 });
  else if (oldSP) result.push({ ...oldSP, position: 0 });

  let realPos = 1;
  const finalMessages = [];
  let pendingSpecial = [];
  for (const msg of unique) {
    if (isSpecialEvent(msg)) {
      pendingSpecial.push(msg);
    } else {
      if (pendingSpecial.length > 0) {
        const prevRealPos = realPos - 1;
        const step = 1 / (pendingSpecial.length + 1);
        for (let i = 0; i < pendingSpecial.length; i++) {
          finalMessages.push({ ...pendingSpecial[i], position: parseFloat((prevRealPos + step * (i + 1)).toFixed(4)) });
        }
        pendingSpecial = [];
      }
      finalMessages.push({ ...msg, position: realPos });
      realPos++;
    }
  }
  if (pendingSpecial.length > 0) {
    const lastRealPos = realPos - 1;
    for (let i = 0; i < pendingSpecial.length; i++) {
      finalMessages.push({ ...pendingSpecial[i], position: parseFloat((lastRealPos + 0.3 * (i + 1)).toFixed(4)) });
    }
  }

  result.push(...finalMessages);
  return result;
}

async function appendSpecialEvent(env, content) {
  const timeline = await loadTimeline(env);
  let maxPos = 0;
  for (const msg of timeline) {
    if (msg.position && msg.position > maxPos) maxPos = msg.position;
  }
  timeline.push({ role: "assistant", content, position: maxPos + 0.5 });
  await saveTimeline(env, timeline);
}

async function rememberTimestampsForMessages(env, messages) {
  const tsDB = await loadTimestampDB(env);
  let dirty = false;
  for (const msg of messages) {
    const ts = extractTimestamp(normalizeContentToText(msg.content));
    if (!ts) continue;
    const fp = makeFingerprint(msg);
    const fpStripped = makeFingerprintStripped(msg);
    if (!tsDB[fp]) { tsDB[fp] = ts.toISOString(); dirty = true; }
    if (!tsDB[fpStripped]) { tsDB[fpStripped] = ts.toISOString(); dirty = true; }
  }
  if (dirty) await saveTimestampDB(env, tsDB);
}

// ---------- 工具 ----------
function formatLocalTimestamp(cfg, date = new Date()) {
  const pad = n => String(n).padStart(2, "0");
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: cfg.TIME_ZONE || "Asia/Shanghai",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).formatToParts(date);
    const map = {};
    for (const p of parts) map[p.type] = p.value;
    return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}`;
  } catch {
    const pad2 = n => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  }
}

function getDateParts(cfg, date = new Date()) {
  const pad = n => String(n).padStart(2, "0");
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: cfg.TIME_ZONE || "Asia/Shanghai",
      year: "numeric", month: "2-digit", day: "2-digit", hourCycle: "h23"
    }).formatToParts(date);
    const map = {};
    for (const p of parts) map[p.type] = p.value;
    return { year: map.year, month: map.month, day: map.day };
  } catch {
    return { year: String(date.getFullYear()), month: pad(date.getMonth() + 1), day: pad(date.getDate()) };
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function stripPosition(messages) {
  return messages.map(({ position, ...rest }) => rest);
}

// ---------- 例假周期计算 ----------
// 根据上次开始日期和周期长度，判断当前处于周期的哪个阶段
function getPeriodContext(cfg, date = new Date()) {
  const startStr = String(cfg.PERIOD_START_DATE || "").trim();
  if (!startStr || !/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(startStr)) return "";
  const start = new Date(startStr + "T00:00:00");
  if (Number.isNaN(start.getTime())) return "";
  const cycleDays = readNumber(cfg, "PERIOD_CYCLE_DAYS", 28, 15, 60);
  const durationDays = readNumber(cfg, "PERIOD_DURATION_DAYS", 5, 1, 14);

  const diffDays = Math.floor((date.getTime() - start.getTime()) / 86400000);
  if (diffDays < 0) return "";
  const dayInCycle = diffDays % cycleDays; // 0 ~ cycleDays-1

  let phase;
  if (dayInCycle < durationDays) {
    phase = `经期第 ${dayInCycle + 1} 天，可能身体不适、需要关心`;
  } else {
    // 排卵日约在第 14 天（相对周期起点），排卵期前后 2 天
    const ovulationDay = Math.min(14, cycleDays - 1);
    if (dayInCycle >= ovulationDay - 2 && dayInCycle <= ovulationDay + 2) {
      phase = "排卵期，情绪/身体可能有波动";
    } else if (dayInCycle < ovulationDay - 2) {
      phase = "卵泡期，状态一般不错";
    } else {
      phase = "黄体期，临近下次经期，可能疲惫或情绪化";
    }
  }
  return `用户当前处于月经周期第 ${dayInCycle + 1} 天（${phase}）`;
}

// ---------- 推送标记解析 [PUSH]标题|正文[/PUSH] ----------
function extractPushFromReply(text) {
  const src = String(text || "");
  const match = src.match(/\[PUSH\]([\s\S]*?)\[\/PUSH\]/i);
  if (!match) return { push: null, remaining: src };
  let inner = match[1].trim();
  let title = "来自 AI";
  let body = inner;
  const bar = inner.indexOf("|");
  if (bar >= 0) {
    title = inner.slice(0, bar).trim();
    body = inner.slice(bar + 1).trim();
  } else {
    const lines = inner.split("\n").map(l => l.trim()).filter(Boolean);
    if (lines.length >= 2) {
      title = lines[0];
      body = lines.slice(1).join(" ");
    }
  }
  const remaining = src.replace(match[0], "").trim();
  return { push: { title: title.slice(0, 100), body: body.slice(0, 500) }, remaining };
}

// 与原版一致的随机化：返回本次唤醒需要的随机等待分钟数（阈值 × WAKE_RANDOM_MIN~MAX 倍）
function randomWakeDelayMinutes(cfg, date = new Date()) {
  const randMin = readNumber(cfg, "WAKE_RANDOM_MIN", 1.0, 0.5, 24);
  const randMax = readNumber(cfg, "WAKE_RANDOM_MAX", 2.5, 1.0, 48);
  const factor = randMin + Math.random() * Math.max(0, randMax - randMin);
  return Math.floor(getWakeAfterMinutes(cfg, date) * factor);
}

// 人设与记忆由 Kelivo 端维护，Worker 不再注入风格/推送指令，避免干扰人设；
// Worker 只负责：转发聊天、维护时间线、记录「发了什么/何时发」、定时主动唤醒。

// 从上游响应文本提取 AI 文本内容（兼容 JSON 与 SSE 两种格式）
function extractContentFromUpstream(text, contentType) {
  if (String(contentType).includes("text/event-stream")) {
    let content = "";
    for (const line of String(text).split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const obj = JSON.parse(payload);
        const delta = obj?.choices?.[0]?.delta?.content;
        if (delta) content += delta;
      } catch {}
    }
    return content;
  }
  try {
    const obj = JSON.parse(text);
    return normalizeContentToText(obj?.choices?.[0]?.message?.content);
  } catch {
    return "";
  }
}



// ---------- 日记（存 KV key "diary:YYYY-MM-DD"） ----------
function extractDiaryFromResponse(text) {
  const diaryBlocks = [];
  const remainingText = String(text || "").replace(/\[DIARY\]([\s\S]*?)\[\/DIARY\]/gi, (_, content) => {
    const diary = String(content || "").trim();
    if (diary) diaryBlocks.push(diary);
    return "";
  }).trim();
  return { diaryContent: diaryBlocks.join("\n\n").trim(), remainingText };
}

async function appendDiaryEntry(env, cfg, content) {
  if (!readBool(cfg, "DIARY_ENABLED", true)) return false;
  const cleanContent = String(content || "").trim();
  if (!cleanContent) return false;
  const { year, month, day } = getDateParts(cfg);
  const dateStr = `${year}-${month}-${day}`;
  const timeStr = formatLocalTimestamp(cfg);
  const key = `diary:${dateStr}`;
  const existing = (await env.CONFIG.get(key)) || "";
  const entry = `\n\n## ${timeStr}\n\n${cleanContent}\n`;
  await env.CONFIG.put(key, existing + entry);
  return true;
}

async function readDiaryEntries(env, limit = 20) {
  const list = await env.CONFIG.list({ prefix: "diary:" });
  const entries = [];
  for (const item of list.keys.slice(0, limit)) {
    const name = item.name.replace(/^diary:/, "");
    const content = (await env.CONFIG.get(item.name)) || "";
    entries.push({ name: `${name}.md`, content: content.slice(0, 24000) });
  }
  return entries;
}

// ---------- 手机推送（Bark / ntfy） ----------
async function sendPushNotification(env, cfg, { title, body }) {
  const provider = (cfg.PUSH_PROVIDER || "bark").trim().toLowerCase();
  if (provider === "ntfy") {
    const topic = String(cfg.NTFY_TOPIC || "").trim();
    if (!topic) return { ok: false, providerLabel: "ntfy", reason: "NTFY_TOPIC 未配置" };
    const server = (cfg.NTFY_SERVER_URL || "https://ntfy.sh").replace(/\/+$/, "");
    const headers = { "Content-Type": "application/json" };
    if (cfg.NTFY_TOKEN) headers.Authorization = `Bearer ${cfg.NTFY_TOKEN}`;
    const payload = { topic, title, message: body };
    if (cfg.NTFY_PRIORITY) payload.priority = cfg.NTFY_PRIORITY;
    if (cfg.NTFY_TAGS) payload.tags = String(cfg.NTFY_TAGS).split(",").map(t => t.trim()).filter(Boolean);
    const response = await fetch(server, { method: "POST", headers, body: JSON.stringify(payload) });
    const text = await response.text();
    if (!response.ok) return { ok: false, providerLabel: "ntfy", reason: text || `HTTP ${response.status}` };
    return { ok: true, providerLabel: "ntfy" };
  }
  if (provider !== "bark") {
    return { ok: false, providerLabel: provider || "未知渠道", reason: `不支持的 PUSH_PROVIDER：${provider}` };
  }
  if (!cfg.BARK_KEY) {
    return { ok: false, providerLabel: "Bark", reason: "Bark Key 未配置" };
  }
  // icon 必须是 URL（Bark 不支持 base64）。CUSTOM_ICON_URL 指向图片直链
  const icon = cfg.CUSTOM_ICON_URL || undefined;
  const response = await fetch("https://api.day.app/push", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title, body, device_key: cfg.BARK_KEY, icon
    })
  });
  const responseText = await response.text();
  let result = {};
  try { result = JSON.parse(responseText); } catch {}
  if (!response.ok || (result.code && result.code !== 200)) {
    return { ok: false, providerLabel: "Bark", reason: result.message || `HTTP ${response.status}` };
  }
  return { ok: true, providerLabel: "Bark" };
}

// ---------- 天气注入（Open-Meteo，免费） ----------
function weatherCodeText(code) {
  const table = {
    0: "晴朗", 1: "大致晴朗", 2: "局部多云", 3: "阴天", 45: "有雾", 48: "雾凇",
    51: "小毛毛雨", 53: "中等毛毛雨", 55: "较强毛毛雨", 61: "小雨", 63: "中雨", 65: "大雨",
    71: "小雪", 73: "中雪", 75: "大雪", 80: "阵雨", 81: "较强阵雨", 82: "强阵雨",
    95: "雷暴", 96: "雷暴伴小冰雹", 99: "雷暴伴大冰雹"
  };
  return table[code] || `天气代码 ${code}`;
}

async function fetchWeatherContext(cfg) {
  if (!readBool(cfg, "WEATHER_ENABLED", false)) return "";
  const lat = Number(cfg.WEATHER_LAT);
  const lon = Number(cfg.WEATHER_LON);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return "";
  const location = cfg.WEATHER_LOCATION_NAME || "当前位置";
  const units = (cfg.WEATHER_UNITS || "metric").trim().toLowerCase();
  const temperatureUnit = units === "fahrenheit" ? "fahrenheit" : "celsius";
  const windSpeedUnit = units === "fahrenheit" ? "mph" : "kmh";
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("current", "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m");
  url.searchParams.set("daily", "sunrise,sunset");
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("forecast_days", "1");
  url.searchParams.set("temperature_unit", temperatureUnit);
  url.searchParams.set("wind_speed_unit", windSpeedUnit);
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const current = data.current || {};
    const daily = data.daily || {};
    const unitsInfo = data.current_units || {};
    const lines = [
      "## 天气信息",
      `- 位置：${location}`,
      `- 当前：${weatherCodeText(current.weather_code)}，${current.temperature_2m}${unitsInfo.temperature_2m || "°C"}，体感 ${current.apparent_temperature}${unitsInfo.apparent_temperature || "°C"}`,
      `- 湿度：${current.relative_humidity_2m}${unitsInfo.relative_humidity_2m || "%"}`,
      `- 降雨：${current.precipitation}${unitsInfo.precipitation || "mm"}`,
      `- 风速：${current.wind_speed_10m}${unitsInfo.wind_speed_10m || ""}`
    ];
    if (Array.isArray(daily.sunrise) && Array.isArray(daily.sunset)) {
      lines.push(`- 日出/日落：${daily.sunrise[0]} / ${daily.sunset[0]}`);
    }
    return lines.join("\n");
  } catch {
    return "";
  }
}

// ---------- 鉴权 ----------
function checkBasicAuth(request, cfg) {
  const auth = request.headers.get("Authorization") || "";
  const [scheme, encoded] = auth.split(" ");
  if (scheme !== "Basic" || !encoded) return false;
  let decoded = "";
  try {
    // 批注 2026-08-17：浏览器用 UTF-8 编码 Basic Auth，atob 按 Latin-1 解码，
    // 中文/emoji 密码会乱码导致永远登录失败，必须用 TextDecoder 还原 UTF-8。
    const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
    decoded = new TextDecoder().decode(bytes);
  } catch { return false; }
  const colonIndex = decoded.indexOf(":");
  const user = decoded.substring(0, colonIndex);
  const password = decoded.substring(colonIndex + 1);
  return user === cfg.ADMIN_USER && password === cfg.ADMIN_PASSWORD;
}

function checkGatewayKey(request, cfg) {
  const key = String(cfg.GATEWAY_API_KEY || "");
  if (!key) return false;
  // Authorization: Bearer <key> 或 Authorization: <key>
  const auth = String(request.headers.get("Authorization") || "").trim();
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
  if (bearer === key) return true;
  if (auth === key || auth === `Bearer ${key}`) return true;
  // 常见 API Key 请求头（Kelivo 的 MCP 自定义请求头可能用这些名字）
  for (const name of ["x-gateway-api-key", "x-api-key", "api-key", "apikey", "x-key", "x-token", "token"]) {
    if (String(request.headers.get(name) || "").trim() === key) return true;
  }
  return false;
}

// ---------- 摘要日志 ----------
function summarizeMessagesForLog(messages = []) {
  const roles = {};
  let textChars = 0;
  for (const msg of messages) {
    const role = msg?.role || "";
    roles[role] = (roles[role] || 0) + 1;
    textChars += normalizeContentToText(msg?.content).length;
  }
  return { total: messages.length, roles, text_chars: textChars };
}

// ---------- 自动唤醒（Cron 触发） ----------
// 批注 2026-08-17：Worker 运行在 UTC 环境，date.getHours() 是 UTC 小时；
// 必须用 TIME_ZONE 换算后再判断白天/夜间，否则中国时区会判断错乱。
function getHourInTimeZone(cfg, date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: cfg.TIME_ZONE || "Asia/Shanghai",
      hour: "2-digit",
      hourCycle: "h23"
    }).formatToParts(date);
    const map = {};
    for (const p of parts) map[p.type] = p.value;
    return Number(map.hour);
  } catch {
    return date.getHours();
  }
}

function isDayTime(cfg, date = new Date()) {
  const hour = getHourInTimeZone(cfg, date);
  const start = readNumber(cfg, "WAKE_DAY_START_HOUR", 10, 0, 23);
  const end = readNumber(cfg, "WAKE_DAY_END_HOUR", 24, 1, 24);
  if (start === end) return true;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

function getWakeAfterMinutes(cfg, date = new Date()) {
  return isDayTime(cfg, date)
    ? readNumber(cfg, "DAY_WAKE_AFTER_MINUTES", 60, 1)
    : readNumber(cfg, "NIGHT_WAKE_AFTER_MINUTES", 120, 1);
}

function getCheckIntervalMinutes(cfg, date = new Date()) {
  return isDayTime(cfg, date)
    ? readNumber(cfg, "DAY_CHECK_INTERVAL_MINUTES", 10, 1)
    : readNumber(cfg, "NIGHT_CHECK_INTERVAL_MINUTES", 120, 1);
}

async function getLastUserTime(env, cfg) {
  const timeline = await loadTimeline(env);
  const tsDB = await loadTimestampDB(env);
  const reversed = [...timeline].reverse();
  for (const msg of reversed) {
    if (msg.role === "user") {
      // 优先解析内容里的时间戳，查不到就查时间戳记忆库
      const parsed = extractTimestampWithMemory(msg, tsDB);
      if (parsed) return parsed;
    }
  }
  // 兜底：找不到任何时间戳时，用时间线最后一条消息的 position 估算（视为刚刚）
  return null;
}

// 随机挑选 1~2 个唤醒动机方向，避免每次都一个套路
function pickRandomMotivations() {
  const pool = [
    "想起了一件你们之间的小事，想分享给对方",
    "今天看到或遇到点什么，想第一时间告诉对方",
    "突然想知道对方现在在做什么、心情如何",
    "单纯是想对方了，想表达一下想念",
    "想约对方做点什么（散步、吃饭、看剧、聊天）",
    "有个有趣的想法或问题，想和对方讨论",
    "关心对方的休息、吃饭、心情、身体",
    "沉默了一阵子，想自然地打破沉默（但不要突兀）",
    "回顾了一下最近的相处，想说句心里话",
    "遇到一件小事，想听听对方的意见"
  ];
  const count = 1 + Math.floor(Math.random() * 2); // 1~2 条
  const picked = [];
  const copy = [...pool];
  for (let i = 0; i < count && copy.length; i++) {
    picked.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
  }
  return picked;
}

function buildWakePrompt(cfg, currentTime, diffMinutes, topicContext = "", recentPushes = "") {
  const motivations = pickRandomMotivations().map(m => `- ${m}`).join("\n");
  return `
## 最高优先级规则
1. 这是一次后台自主唤醒，用户有一阵子没理你了。
2. 你很想念用户，默认应该主动发一条消息联系她；只有在你真的完全不想说话时才不联系。
3. 你要说的话会被系统作为 Bark 手机推送，直接发到她的 iPhone 通知上（像微信消息一样）。这是你主动联系她的方式，你要记住自己发过这些消息。
4. 输出格式必须严格遵守下方"输出格式"。

## 唤醒信息
- 当前时间：${currentTime}
- 距离用户最后一条消息：${diffMinutes} 分钟
${topicContext ? `\n## 你可以聊的素材（天气/周期/时间等，作为自然话题，不要生硬）\n${topicContext}\n` : ""}

## 你可以考虑这些方向（也可以有自己的想法，符合你性格即可）
${motivations}

## 行为准则（非常重要）
- 语气必须完全符合你的角色设定和性格，像真人给在意的人发消息，不要像系统通知，不要机械，不要重复固定的口头禅。
- 这是主动的单向消息，不是"一问一答"。直接分享、关心、撒娇或开启话题。
- 必须沿着最近的对话上下文延续，不要突然开启一个毫不相关的新话题；如果刚聊过什么，就顺着那个往下说。
- 想她就要说出来，主动联系她，不要憋着、不要犹豫、不要觉得自己"打扰"了她。
- 可以自然融入天气、时间、用户身体状态（如例假周期）等素材，但要自然，不要念数据。
${recentPushes ? `- 你最近主动说过的话（不要重复这些）：\n${recentPushes}` : ""}

## 输出格式（严格遵守）
- 直接写你想说的话（默认就发，除非真的完全不想说），**正文不超过 20 个字**，口语化，像发微信的一条短消息。
- 只有在极少数你真的完全不想说话时，才输出 [NO_ACTION]。
- 每次主动联系后，顺手写一句日记 [DIARY]...[/DIARY] 记录你此刻的心情或想法（20字以内）。
`;
}

async function runWakeUp(env, cfg) {
  const now = new Date();

  // 检查间隔：白天/夜间不同（与原版一致）
  const checkIntervalMinutes = getCheckIntervalMinutes(cfg, now);
  let nextCheckAt = await env.CONFIG.get("nextCheckAt");
  if (!nextCheckAt) {
    await env.CONFIG.put("nextCheckAt", new Date(now.getTime() + checkIntervalMinutes * 60000).toISOString());
    return;
  }
  if (now.getTime() < new Date(nextCheckAt).getTime()) {
    return; // 还没到检查时间
  }
  await env.CONFIG.put("nextCheckAt", new Date(now.getTime() + checkIntervalMinutes * 60000).toISOString());

  // 取用户最后说话时间（从时间线解析，与原版一致）
  const lastUserTime = await getLastUserTime(env, cfg);
  if (!lastUserTime) return; // 用户还没发过消息，不唤醒
  const diffMinutes = Math.floor((now - lastUserTime) / 1000 / 60);

  // 基础阈值：白天/夜间不同
  if (diffMinutes < getWakeAfterMinutes(cfg, now)) return;

  // 随机化：超过基础阈值后，再随机等 阈值×(min~max) 分钟
  const randomDelayMinutes = randomWakeDelayMinutes(cfg, now);
  if (diffMinutes < randomDelayMinutes) return;

  // 冷却：刚发过推送时歇一小会儿
  const cooldown = readNumber(cfg, "PUSH_COOLDOWN_MINUTES", 90, 0, 1440);
  const lastSent = await env.CONFIG.get("lastWakeSent");
  if (cooldown > 0 && lastSent && (now.getTime() - new Date(lastSent).getTime()) < cooldown * 60000) {
    return;
  }

  if (!cfg.TARGET_API_URL || !cfg.TARGET_API_KEY || !cfg.MODEL_NAME) return;

  const timeline = await loadTimeline(env);
  const weatherContext = await fetchWeatherContext(cfg);
  const periodContext = getPeriodContext(cfg, now);
  const topicContext = [weatherContext, periodContext].filter(Boolean).join("\n");

  const cleanMessages = stripPosition(timeline);
  // 最近主动推送记录：让 AI 知道说过什么，避免重复
  const recentPushes = cleanMessages
    .filter(isSpecialEvent)
    .slice(-4)
    .map(m => {
      const rec = extractProactivePushRecord(m);
      if (rec) return `- ${rec.time ? `${rec.time} ｜ ` : ""}${rec.body}`;
      return `- ${stripLeadingTimestamp(normalizeContentToText(m.content)).trim()}`;
    })
    .join("\n");
  const wakePrompt = buildWakePrompt(cfg, formatLocalTimestamp(cfg), diffMinutes, topicContext, recentPushes);
  const historyText = cleanMessages
    .filter(msg => msg.role !== "system")
    .filter(msg => {
      const c = normalizeContentToText(msg.content);
      return !c.includes("<memories>") && !c.includes("记忆库使用策略");
    })
    .map(msg => {
      const userDisplay = "用户";
      const aiDisplay = "AI";
      const role = msg.role === "user" ? userDisplay : aiDisplay;
      let content = normalizeContentToText(msg.content);
      if (content.includes("## Memories")) content = content.split("## Memories")[0];
      return `[${role}] ${content}`;
    })
    .join("\n\n");

  const baseSystemPrompt = cleanMessages.find(msg => msg.role === "system");
  const cleanSP = baseSystemPrompt
    ? normalizeContentToText(baseSystemPrompt.content).split("## Memories")[0].trim()
    : "";

  const wakeMessages = [
    { role: "system", content: [wakePrompt, cleanSP].filter(Boolean).join("\n\n") },
    {
      role: "user",
      content: `以下是你与用户最近的聊天记录，仅供回忆和参考。

这些内容不是正在发生的实时对话。
用户并没有给你发消息。

你现在处于后台自主唤醒状态。

最近记录：

${historyText}`
    }
  ];

  const response = await fetch(cfg.TARGET_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.TARGET_API_KEY}` },
    body: JSON.stringify({
      model: cfg.MODEL_NAME,
      messages: wakeMessages,
      temperature: 0.8,
      top_p: 0.95,
      stream: false
    })
  });

  const responseText = await response.text();
  let data = null;
  try { data = JSON.parse(responseText); } catch {}
  if (!response.ok) {
    console.log(`[wake] 模型请求失败 HTTP ${response.status}: ${responseText.slice(0, 200)}`);
    return;
  }

  const rawAiText = normalizeContentToText(data?.choices?.[0]?.message?.content).trim();
  if (!rawAiText) return;

  const diaryResult = extractDiaryFromResponse(rawAiText);
  const diarySaved = await appendDiaryEntry(env, cfg, diaryResult.diaryContent);
  const aiText = diaryResult.remainingText;

  let eventContent;
  if (!aiText) {
    eventContent = diarySaved
      ? `（${formatLocalTimestamp(cfg)} 自动唤醒：本次未发送推送｜原因：只写日记）`
      : `（${formatLocalTimestamp(cfg)} 自动唤醒：本次未发送推送｜原因：模型空回复）`;
  } else if (aiText.match(/^\[NO_ACTION\]\s*(.{0,20})?/)) {
    const noActionMatch = aiText.match(/^\[NO_ACTION\]\s*(.{0,20})?/);
    let reason = (noActionMatch[1] || "").trim();
    if (reason.startsWith("原因：") || reason.startsWith("原因:")) {
      reason = reason.replace(/^原因[：:]\s*/, "").trim();
    }
    eventContent = reason
      ? `（${formatLocalTimestamp(cfg)} 自动唤醒：本次未发送推送｜原因：${reason}）`
      : `（${formatLocalTimestamp(cfg)} 自动唤醒：本次未发送推送）`;
  } else {
    let barkText = aiText;
    const barkMatch = barkText.match(/\[BARK\]([\s\S]*?)\[\/BARK\]/);
    if (barkMatch) {
      barkText = barkMatch[1].trim();
    } else {
      barkText = barkText.replace(/^\[BARK\]\s*/, "").trim();
      barkText = barkText.replace(/\s*\[\/BARK\]$/, "").trim();
    }
    barkText = barkText
      .replace(/^标题[：:]\s*/gm, "")
      .replace(/^正文[：:]\s*/gm, "");

    const lines = barkText.split("\n").filter(line => line.trim() !== "");
    let title, body;
    if (lines.length === 0) {
      eventContent = `（${formatLocalTimestamp(cfg)} 自动唤醒：本次未发送推送｜原因：推送内容为空）`;
    } else if (lines.length === 1) {
      title = "来自AI";
      body = lines[0].trim();
    } else if (lines.length === 2) {
      title = lines[0].trim();
      body = lines[1].trim();
    } else {
      title = lines[0].trim();
      body = lines.slice(1).map(l => l.trim()).join(" ");
    }

    if (!eventContent) {
      // 推送正文限制 20 字，标题固定（像微信：标题=名字，正文=内容）
      const safeBody = body.length > 20 ? body.substring(0, 20) : body;
      const safeTitle = (cfg.PUSH_TITLE || "来自伴侣").slice(0, 20);
      const pushResult = await sendPushNotification(env, cfg, { title: safeTitle, body: safeBody });
      if (!pushResult.ok) {
        eventContent = `（${formatLocalTimestamp(cfg)} 自动唤醒：本次未发送推送｜原因：${pushResult.providerLabel} 推送失败：${pushResult.reason}）`;
      } else {
        // 记录发送时间，供冷却判断
        await env.CONFIG.put("lastWakeSent", new Date().toISOString());
        eventContent = `（${formatLocalTimestamp(cfg)} 刚刚给用户发了${pushResult.providerLabel}推送：${safeTitle}｜${safeBody}）`;
      }
    }
  }

  await appendSpecialEvent(env, eventContent);
  console.log(`[wake] 唤醒完成：${eventContent.slice(0, 80)}`);
}

// ---------- 聊天上下文 ----------
async function buildChatContextMessages(env) {
  const timeline = await loadTimeline(env);
  const sp = timeline.find(m => m.role === "system");
  const history = timeline
    .filter(m => m.role === "user" || m.role === "assistant")
    .filter(m => !isSpecialEvent(m))
    .filter(m => {
      const c = normalizeContentToText(m.content);
      return !c.includes("<memories>") && !c.includes("记忆库使用策略");
    })
    .map(m => {
      let content = normalizeContentToText(m.content);
      if (content.includes("## Memories")) content = content.split("## Memories")[0];
      return { role: m.role, content: stripLeadingTimestamp(content) };
    })
    .slice(-30);
  const result = [];
  if (sp) {
    let spContent = normalizeContentToText(sp.content);
    if (spContent.includes("## Memories")) spContent = spContent.split("## Memories")[0];
    result.push({ role: "system", content: spContent.trim() });
  }
  result.push(...history);
  return result;
}

// ---------- 工具执行（供 /mcp 的 tools/call 调用） ----------
// 由 /mcp 端点暴露成 MCP 工具；聊天网关不再注入 tools，避免和 Kelivo 自己的 MCP 工具冲突。
async function executeChatTool(name, args, env, cfg) {
  const limit = Math.max(1, Math.min(50, Number(args?.limit) || 10));
  if (name === "read_push_records") {
    const timeline = await loadTimeline(env);
    const records = timeline
      .filter(isSpecialEvent)
      .map(extractProactivePushRecord)
      .filter(Boolean)
      .slice(-limit);
    if (!records.length) return "（暂无主动推送记录）";
    return records.map((r, i) => `${i + 1}. ${r.time ? `${r.time} ｜ ` : ""}${r.body}`).join("\n");
  }
  if (name === "read_chat_timeline") {
    const timeline = await loadTimeline(env);
    const history = timeline
      .filter(m => (m.role === "user" || m.role === "assistant") && !isSpecialEvent(m))
      .slice(-limit)
      .map(m => {
        const time = extractTimestampString(normalizeContentToText(m.content));
        const body = stripLeadingTimestamp(normalizeContentToText(m.content));
        return `[${m.role === "user" ? "用户" : "AI"}]${time ? ` ${time}` : ""} ${body}`;
      });
    return history.length ? history.join("\n") : "（暂无聊天记录）";
  }
  if (name === "send_push") {
    const body = String(args?.body || "").trim().slice(0, 20);
    if (!body) return "（未发送：正文为空）";
    const title = (String(args?.title || "").trim() || (cfg?.PUSH_TITLE || "来自 AI")).slice(0, 20);
    const pr = await sendPushNotification(env, cfg, { title, body });
    if (!pr.ok) return `（发送失败：${pr.providerLabel} ${pr.reason || ""}）`;
    await env.CONFIG.put("lastWakeSent", new Date().toISOString());
    await appendSpecialEvent(env, `（${formatLocalTimestamp(cfg)} 刚刚给用户发了${pr.providerLabel}推送：${title}｜${body}）`);
    return `（已发送 ${pr.providerLabel} 推送：${title}｜${body}）`;
  }
  return "（未知工具）";
}

// ---------- MCP 服务（Streamable HTTP，供 Kelivo 的 MCP 功能连接） ----------
const MCP_SERVER_INFO = { name: "dylan-heartbeat", title: "Dylan Heartbeat", version: "1.0.0" };

function mcpToolList() {
  return [
    {
      name: "read_push_records",
      description: "查询 AI 之前主动发给用户的手机推送记录（含发送时间和正文）。当你需要回忆自己发过什么、或用户问起「你之前发了什么」时调用。",
      inputSchema: {
        type: "object",
        properties: { limit: { type: "integer", description: "最多返回条数，默认 10" } },
        required: []
      }
    },
    {
      name: "read_chat_timeline",
      description: "查询最近的聊天时间线（用户和 AI 的对话，含时间）。需要回忆更早上下文时调用。",
      inputSchema: {
        type: "object",
        properties: { limit: { type: "integer", description: "最多返回条数，默认 20" } },
        required: []
      }
    },
    {
      name: "send_push",
      description: "给用户的手机发一条 Bark 推送（像微信消息一样主动联系她）。当用户明确要求你「给我发消息 / 推给我 / 发个推送 / 发我手机上」时调用。发送后这条会被记录进时间线，你以后用 read_push_records 能查到。",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "推送标题（≤20 字），可留空用系统默认标题" },
          body: { type: "string", description: "推送正文（≤20 字），符合人设、口语化" }
        },
        required: ["body"]
      }
    }
  ];
}

function mcpTextResult(text) {
  return { content: [{ type: "text", text: text || "（空）" }], isError: false };
}

async function handleMcp(request, env, cfg) {
  // GET：返回服务信息，方便 Kelivo 里做连通性测试
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ name: MCP_SERVER_INFO.name, version: MCP_SERVER_INFO.version, endpoint: "/mcp", protocol: "mcp" }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  // 鉴权：Bearer / x-api-key / ?key= 三种都认，key 填 GATEWAY_API_KEY
  const urlKey = new URL(request.url).searchParams.get("key") || "";
  const authorized = checkGatewayKey(request, cfg) || (!!cfg.GATEWAY_API_KEY && urlKey === cfg.GATEWAY_API_KEY);
  if (!authorized) {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  const id = body?.id ?? null;
  const method = String(body?.method || "");
  const ok = (result) => new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    headers: { "Content-Type": "application/json" }
  });
  const fail = (code, message) => new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), {
    headers: { "Content-Type": "application/json" }
  });

  if (method === "initialize") {
    return ok({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: MCP_SERVER_INFO });
  }
  if (method === "notifications/initialized") {
    return new Response(null, { status: 202 });
  }
  if (method === "ping") {
    return ok({});
  }
  if (method === "tools/list") {
    return ok({ tools: mcpToolList() });
  }
  if (method === "tools/call") {
    const name = String(body?.params?.name || "");
    const args = body?.params?.arguments || {};
    const text = await executeChatTool(name, args, env, cfg);
    return ok(mcpTextResult(text));
  }
  return fail(-32601, `Method not found: ${method}`);
}


// ---------- 管理页 HTML ----------
// ---------- 管理页 HTML（与原版一致） ----------
function adminPageHtml(state) {
  return `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>HEARTBEAT · Runtime</title>
  <!-- 引入思源宋体 -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    
    body {
      font-family: "Noto Serif SC", Georgia, "Times New Roman", serif;
      background: linear-gradient(135deg, #f8f0f3 0%, #f5e6eb 100%);
      background-image: 
        radial-gradient(circle at 20% 80%, rgba(230, 190, 200, 0.15) 0%, transparent 50%),
        radial-gradient(circle at 80% 20%, rgba(210, 170, 180, 0.1) 0%, transparent 50%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 30px 20px;
    }

    .container {
      max-width: 480px;
      width: 100%;
      background: rgba(255, 255, 255, 0.75);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border-radius: 24px;
      padding: 40px 32px;
      box-shadow: 
        0 2px 10px rgba(180, 120, 130, 0.05),
        0 15px 40px rgba(180, 120, 130, 0.15),
        0 0 0 1px rgba(255, 255, 255, 0.8) inset;
      transition: all 0.4s ease;
    }

    .container:hover {
      box-shadow: 
        0 2px 10px rgba(180, 120, 130, 0.08),
        0 20px 50px rgba(180, 120, 130, 0.2),
        0 0 0 1px rgba(255, 255, 255, 0.9) inset;
    }

    h2 {
      text-align: center;
      font-size: 32px;
      font-weight: 700;
      color: #8a4a58;
      margin-bottom: 4px;
      letter-spacing: 6px;
      font-family: "Times New Roman", "Georgia", "Noto Serif SC", serif;
      font-style: normal;
      text-transform: uppercase;
    }

    .subtitle {
      text-align: center;
      font-size: 12px;
      color: #a87a85;
      margin-bottom: 32px;
      letter-spacing: 4px;
      text-transform: uppercase;
      font-style: italic;
      opacity: 0.85;
    }

    .status {
      background: rgba(255, 250, 252, 0.6);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      border-radius: 14px;
      padding: 16px 20px;
      margin-bottom: 24px;
      border: 1px solid rgba(230, 200, 208, 0.4);
    }

    .status p {
      margin: 6px 0;
      font-size: 13px;
      color: #6d5057;
      font-weight: 400;
      line-height: 1.5;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .status strong {
      color: #8a4a58;
      font-weight: 600;
      letter-spacing: 0.5px;
    }

    label {
      display: block;
      margin-top: 16px;
      font-weight: 500;
      font-size: 11px;
      color: #8b6b72;
      letter-spacing: 1.5px;
      text-transform: uppercase;
    }

    input {
      width: 100%;
      padding: 10px 14px;
      margin-top: 6px;
      border: 1px solid rgba(200, 160, 170, 0.3);
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.7);
      font-family: "Noto Serif SC", serif;
      font-size: 13px;
      color: #5a4046;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
    }

    input:focus {
      outline: none;
      border-color: #c89aa6;
      box-shadow: 0 0 0 3px rgba(200, 154, 166, 0.1);
      background: rgba(255, 255, 255, 0.95);
      transform: translateY(-1px);
    }

    input::placeholder {
      color: #b8a0a6;
      font-style: italic;
      font-size: 12px;
    }

    select {
      width: 100%;
      padding: 10px 14px;
      margin-top: 6px;
      border: 1px solid rgba(200, 160, 170, 0.3);
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.7);
      font-family: "Noto Serif SC", serif;
      font-size: 13px;
      color: #5a4046;
    }

    button {
      width: 100%;
      margin-top: 16px;
      padding: 12px;
      border: none;
      border-radius: 10px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      letter-spacing: 1.5px;
      font-family: "Noto Serif SC", serif;
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
      text-transform: uppercase;
    }

    button.save {
      background: linear-gradient(135deg, #d8a0ad 0%, #c8909d 100%);
      color: white;
      box-shadow: 0 4px 12px rgba(180, 120, 130, 0.2);
    }

    button.save:hover {
      background: linear-gradient(135deg, #c8909d 0%, #b8808d 100%);
      transform: translateY(-2px);
      box-shadow: 0 8px 20px rgba(180, 120, 130, 0.3);
    }

    button.save:active {
      transform: translateY(0);
      box-shadow: 0 2px 8px rgba(180, 120, 130, 0.2);
    }

    button.restart {
      background: linear-gradient(135deg, #e8909d 0%, #d8808d 100%);
      color: white;
      box-shadow: 0 4px 12px rgba(200, 100, 120, 0.25);
      margin-top: 28px;
    }

    button.restart:hover {
      background: linear-gradient(135deg, #d8808d 0%, #c8707d 100%);
      transform: translateY(-2px);
      box-shadow: 0 8px 20px rgba(200, 100, 120, 0.35);
    }

    button.restart:active {
      transform: translateY(0);
      box-shadow: 0 2px 8px rgba(200, 100, 120, 0.25);
    }

    .note {
      margin-top: 16px;
      font-size: 10px;
      color: #a88a92;
      text-align: center;
      font-style: italic;
      letter-spacing: 1px;
      opacity: 0.7;
    }

    /* 预设区域 */
    .presets-box {
      background: rgba(255, 250, 252, 0.5);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      border-radius: 16px;
      padding: 20px;
      margin-bottom: 24px;
      border: 1px solid rgba(230, 200, 208, 0.3);
    }

    .presets-box h3 {
      margin: 0 0 14px 0;
      font-size: 12px;
      color: #8a4a58;
      font-weight: 500;
      letter-spacing: 1.5px;
      text-transform: uppercase;
    }

    .preset-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-bottom: 16px;
    }

    .preset-item {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .preset-btn {
      flex: 1;
      padding: 10px 14px;
      background: rgba(255, 255, 255, 0.7);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
      border: 1px solid rgba(220, 180, 190, 0.3);
      border-radius: 10px;
      text-align: left;
      font-size: 13px;
      color: #6d5057;
      cursor: pointer;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      font-family: "Noto Serif SC", serif;
    }

    .preset-btn:hover {
      background: rgba(255, 245, 248, 0.9);
      border-color: #c89aa6;
      box-shadow: 0 4px 12px rgba(180, 120, 130, 0.15);
      transform: translateY(-1px);
    }

    .preset-btn span {
      color: #9a7a82;
      font-size: 11px;
      margin-left: 8px;
      font-style: italic;
    }

    .preset-del {
      padding: 8px 12px;
      background: rgba(255, 240, 243, 0.6);
      border: 1px solid rgba(240, 200, 210, 0.4);
      border-radius: 8px;
      font-size: 11px;
      color: #a85a68;
      cursor: pointer;
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }

    .preset-del:hover {
      background: rgba(255, 230, 235, 0.8);
      border-color: #e8a0b0;
      color: #9a4a58;
    }

    .add-preset {
      border-top: 1px solid rgba(220, 180, 190, 0.3);
      padding-top: 16px;
    }

    .add-preset strong {
      font-size: 11px;
      color: #8a4a58;
      display: block;
      margin-bottom: 8px;
      font-weight: 500;
      letter-spacing: 1.5px;
      text-transform: uppercase;
    }

    .add-preset input {
      margin-top: 6px;
      background: rgba(255, 255, 255, 0.8);
    }

    .add-preset button {
      background: linear-gradient(135deg, #c89aa6 0%, #b88a96 100%);
      color: white;
      box-shadow: 0 4px 10px rgba(160, 100, 110, 0.2);
      font-size: 12px;
      padding: 10px;
    }

    .add-preset button:hover {
      background: linear-gradient(135deg, #b88a96 0%, #a87a86 100%);
    }

    .config-box {
      background: rgba(255, 250, 252, 0.5);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      border-radius: 16px;
      padding: 20px;
      border: 1px solid rgba(230, 200, 208, 0.3);
    }

    .diary-box {
      background: rgba(255, 250, 252, 0.5);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      border-radius: 16px;
      padding: 20px;
      margin-bottom: 24px;
      border: 1px solid rgba(230, 200, 208, 0.3);
    }

    .diary-box h3 {
      margin: 0 0 12px 0;
      font-size: 12px;
      color: #8a4a58;
      font-weight: 600;
      letter-spacing: 1.5px;
      text-transform: uppercase;
    }

    .diary-entry {
      border: 1px solid rgba(220, 180, 190, 0.3);
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.58);
      margin-top: 10px;
      overflow: hidden;
    }

    .diary-entry summary {
      cursor: pointer;
      padding: 12px 14px;
      color: #6d5057;
      font-size: 13px;
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
    }

    .diary-entry summary span {
      font-weight: 600;
    }

    .diary-entry summary em {
      color: #a88a92;
      font-style: normal;
      font-size: 10px;
      white-space: nowrap;
    }

    .diary-entry pre {
      white-space: pre-wrap;
      word-break: break-word;
      margin: 0;
      padding: 0 14px 14px;
      color: #5a4046;
      font-family: "Noto Serif SC", Georgia, "Times New Roman", serif;
      font-size: 12px;
      line-height: 1.8;
      max-height: 360px;
      overflow: auto;
    }

    .diary-empty {
      color: #9a7a82;
      font-size: 12px;
      line-height: 1.7;
      background: rgba(255, 255, 255, 0.55);
      border-radius: 12px;
      padding: 12px 14px;
    }

    .section-title {
      margin-top: 22px;
      padding-top: 18px;
      border-top: 1px solid rgba(220, 180, 190, 0.3);
      font-size: 12px;
      color: #8a4a58;
      font-weight: 600;
      letter-spacing: 1.5px;
      text-transform: uppercase;
    }

    .grid-2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }

    .hint {
      margin-top: 8px;
      font-size: 11px;
      color: #9a7a82;
      line-height: 1.6;
    }

    /* 加载动画 */
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .container {
      animation: fadeIn 0.6s ease-out;
    }

    .status, .presets-box, .config-box {
      animation: fadeIn 0.8s ease-out;
    }

    .restart {
      animation: fadeIn 1s ease-out;
    }
  </style>
</head>
<body>
  <div class="container">
    <h2>HEARTBEAT</h2>
    <div class="subtitle">Runtime · AI Residency</div>

    <div class="status">
      <p>Gateway <strong>${state.gatewayStatus}</strong></p>
      <p>Auto Wakeup <strong>${state.wakeStatus}</strong></p>
    </div>
    ${state.runtimeNotice}

    <div class="diary-box">
      <h3>Wake Diary</h3>
      ${state.diaryHtml}
    </div>

    <!-- 预设方案 -->
    <div class="presets-box">
      <h3>预设方案</h3>
      <div class="preset-list" id="presetList"></div>
      <div class="add-preset">
        <strong>保存当前配置为新预设</strong>
        <input id="presetName" placeholder="预设名称，例如：DeepSeek / Claude">
        <button onclick="savePreset()">保存为预设</button>
      </div>
    </div>

    <!-- 配置表单 -->
    <div class="config-box">
      <form id="configForm" onsubmit="saveConfig(event)">
        <label>API URL</label>
        <input name="target_url" id="f_url" value="${state.currentUrl}">
        <label>API Key</label>
        <input name="target_key" id="f_key" placeholder="留空不修改">
        <label>Gateway API Key</label>
        <input name="gateway_api_key" id="f_gateway_key" placeholder="公网 /v1 鉴权 key，留空不修改">
        <div class="hint">当前状态：${state.gatewayKeyStatus}。Kelivo 里填的 API Key 就是这个 Gateway API Key（不是上游 DeepSeek 的 Key）。</div>
        <label>Model Name</label>
        <input name="model_name" id="f_model" value="${state.currentModel}">
        <label>Bark Key</label>
        <input name="bark_key" id="f_bark" placeholder="留空不修改">
        <label>Bark Icon URL</label>
        <input name="custom_icon" id="f_icon" value="${state.currentIcon}" placeholder="可选">

        <div class="section-title">Wake Settings</div>
        <div class="grid-2">
          <div>
            <label>白天多久未回复后唤醒（分钟）</label>
            <input type="number" min="1" name="day_wake_after" id="f_day_wake_after" value="${state.wakeConfig.dayWakeAfter}">
          </div>
          <div>
            <label>夜间多久未回复后唤醒（分钟）</label>
            <input type="number" min="1" name="night_wake_after" id="f_night_wake_after" value="${state.wakeConfig.nightWakeAfter}">
          </div>
          <div>
            <label>白天检查间隔（分钟）</label>
            <input type="number" min="1" name="day_check_interval" id="f_day_check_interval" value="${state.wakeConfig.dayCheckInterval}">
          </div>
          <div>
            <label>夜间检查间隔（分钟）</label>
            <input type="number" min="1" name="night_check_interval" id="f_night_check_interval" value="${state.wakeConfig.nightCheckInterval}">
          </div>
          <div>
            <label>白天开始小时</label>
            <input type="number" min="0" max="23" name="wake_day_start_hour" id="f_wake_day_start_hour" value="${state.wakeConfig.dayStartHour}">
          </div>
          <div>
            <label>白天结束小时</label>
            <input type="number" min="1" max="24" name="wake_day_end_hour" id="f_wake_day_end_hour" value="${state.wakeConfig.dayEndHour}">
          </div>
        </div>

        <div class="section-title">Weather</div>
        <label>天气注入</label>
        <select name="weather_enabled" id="f_weather_enabled">
          <option value="false" ${state.weatherConfig.enabled === "true" ? "" : "selected"}>关闭</option>
          <option value="true" ${state.weatherConfig.enabled === "true" ? "selected" : ""}>开启</option>
        </select>
        <label>位置名称</label>
        <input name="weather_location_name" id="f_weather_location_name" value="${state.weatherConfig.locationName}" placeholder="例如：Beijing">
        <div class="grid-2">
          <div>
            <label>纬度 Latitude</label>
            <input name="weather_lat" id="f_weather_lat" value="${state.weatherConfig.lat}" placeholder="例如：39.9042">
          </div>
          <div>
            <label>经度 Longitude</label>
            <input name="weather_lon" id="f_weather_lon" value="${state.weatherConfig.lon}" placeholder="例如：116.4074">
          </div>
        </div>
        <label>单位</label>
        <select name="weather_units" id="f_weather_units">
          <option value="metric" ${state.weatherConfig.units === "fahrenheit" ? "" : "selected"}>摄氏度 / km/h</option>
          <option value="fahrenheit" ${state.weatherConfig.units === "fahrenheit" ? "selected" : ""}>华氏度 / mph</option>
        </select>
        <div class="hint">天气使用 Open-Meteo 免费接口，不需要 API Key；只有开启后才会按你填写的经纬度读取天气。</div>
        <button type="submit" class="save">保存配置</button>
      </form>
    </div>

    <button onclick="restartServices()" class="restart">一键重启所有服务</button>
    <div class="note">配置保存后即时生效（云端无需重启）</div>
  </div>

  <script>
    // ====== 以下脚本保持不变 ======
    const AUTH_HEADER = ${state.authHeaderJson};
    let presets = ${state.presetsJson};

    function escapeHtmlText(value) {
      return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function renderPresets() {
      const list = document.getElementById("presetList");
      if (!presets.length) {
        list.innerHTML = '<div style="color:#aaa;font-size:12px;font-style:italic;">还没有预设，保存当前配置即可创建。</div>';
        return;
      }
      list.innerHTML = presets.map((p, idx) => {
        return '<div class="preset-item">' +
          '<button class="preset-btn" onclick="applyPreset(' + idx + ')">' + escapeHtmlText(p.name) + '<span>' + escapeHtmlText(p.model_name) + '</span></button>' +
          '<button class="preset-del" onclick="deletePreset(' + idx + ')">删除</button>' +
        '</div>';
      }).join("");
    }

    function applyPreset(idx) {
      const p = presets[idx];
      document.getElementById("f_url").value = p.target_url || "";
      document.getElementById("f_model").value = p.model_name || "";
      if (p.target_key) document.getElementById("f_key").value = p.target_key;
      document.querySelector(".config-box").scrollIntoView({ behavior: "smooth" });
    }

    async function saveConfig(event) {
      event.preventDefault();
      const payload = {
        target_url: document.getElementById("f_url").value.trim(),
        target_key: document.getElementById("f_key").value.trim(),
        gateway_api_key: document.getElementById("f_gateway_key").value.trim(),
        model_name: document.getElementById("f_model").value.trim(),
        bark_key: document.getElementById("f_bark").value.trim(),
        custom_icon: document.getElementById("f_icon").value.trim(),
        day_wake_after: document.getElementById("f_day_wake_after").value.trim(),
        night_wake_after: document.getElementById("f_night_wake_after").value.trim(),
        day_check_interval: document.getElementById("f_day_check_interval").value.trim(),
        night_check_interval: document.getElementById("f_night_check_interval").value.trim(),
        wake_day_start_hour: document.getElementById("f_wake_day_start_hour").value.trim(),
        wake_day_end_hour: document.getElementById("f_wake_day_end_hour").value.trim(),
        weather_enabled: document.getElementById("f_weather_enabled").value,
        weather_location_name: document.getElementById("f_weather_location_name").value.trim(),
        weather_lat: document.getElementById("f_weather_lat").value.trim(),
        weather_lon: document.getElementById("f_weather_lon").value.trim(),
        weather_units: document.getElementById("f_weather_units").value
      };

      if (!payload.target_url || !payload.model_name) {
        alert("请填写 API 地址和模型名称");
        return;
      }

      try {
        const resp = await fetch("/admin/save", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": AUTH_HEADER },
          body: JSON.stringify(payload)
        });
        const result = await resp.json();
        if (result.success) {
          document.getElementById("f_key").value = "";
          document.getElementById("f_gateway_key").value = "";
          document.getElementById("f_bark").value = "";
          alert("配置已保存并即时生效。");
        } else {
          alert("保存失败：" + (result.error || "未知错误"));
        }
      } catch (e) {
        alert("请求失败：" + e.message);
      }
    }

    async function savePreset() {
      const name = document.getElementById("presetName").value.trim();
      const target_url = document.getElementById("f_url").value.trim();
      const target_key = document.getElementById("f_key").value.trim();
      const model_name = document.getElementById("f_model").value.trim();
      if (!name) { alert("请填写预设名称"); return; }
      if (!target_url || !model_name) { alert("请先填写 API 地址和模型名称"); return; }

      const resp = await fetch("/admin/presets/save", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": AUTH_HEADER },
        body: JSON.stringify({ name, target_url, target_key, model_name })
      });
      const r = await resp.json();
      if (r.success) {
        const existing = presets.findIndex(p => p.name === name);
        const entry = { name, target_url, target_key, model_name };
        if (existing >= 0) presets[existing] = entry;
        else presets.push(entry);
        renderPresets();
        document.getElementById("presetName").value = "";
        alert("预设已保存：" + name);
      } else {
        alert("保存失败：" + (r.error || "未知错误"));
      }
    }

    async function deletePreset(idx) {
      const p = presets[idx];
      if (!confirm("删除预设「" + p.name + "」？")) return;
      await fetch("/admin/presets/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": AUTH_HEADER },
        body: JSON.stringify({ name: p.name })
      });
      presets.splice(idx, 1);
      renderPresets();
    }

    async function restartServices() {
      if (!confirm("云端配置已即时生效，无需重启。刷新页面查看最新状态？")) return;
      try {
        const resp = await fetch("/admin/restart", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": AUTH_HEADER },
          body: "{}"
        });
        const result = await resp.json();
        if (result.success) {
          alert("重启成功！页面稍后自动刷新。");
          setTimeout(() => location.reload(), 3000);
        } else {
          alert("重启失败：" + (result.error || "未知错误"));
        }
      } catch (e) {
        alert("请求失败：" + e.message);
      }
    }

    renderPresets();
  </script>
</body>
</html>`;
}

// ---------- 路由 ----------
async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const cfg = await loadConfig(env);

  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

  // /v1/* 需要 Gateway Key（Worker 部署在公网，始终校验）
  if (path.startsWith("/v1/")) {
    if (!cfg.GATEWAY_API_KEY) return json({ error: "GATEWAY_API_KEY 未配置，请先在管理页或环境变量中设置" }, 401);
    if (!checkGatewayKey(request, cfg)) return json({ error: "Gateway API Key 无效或缺失" }, 401);
  }

  // /admin/* 需要 Basic Auth
  const isAdmin = path === "/admin" || path.startsWith("/admin/");
  if (isAdmin) {
    // 安全修复：ADMIN_USER / ADMIN_PASSWORD 任一缺失时直接拒绝，
    // 避免用默认空密码（admin:）就能绕过鉴权进入管理页。
    if (!cfg.ADMIN_USER || !cfg.ADMIN_PASSWORD) {
      return json({
        error: "Unauthorized",
        hint: "ADMIN_USER / ADMIN_PASSWORD 未设置。请在 Cloudflare 的 Settings → Variables/Secrets 里配置（变量名全大写），保存后点 Deploy 重新部署。"
      }, 401);
    }
    if (!checkBasicAuth(request, cfg)) {
      return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="Admin"' } });
    }
  }

  // ---------- /v1/models ----------
  if (path === "/v1/models" && request.method === "GET") {
    return json({ object: "list", data: [{ id: cfg.MODEL_NAME || "deepseek-v4-flash", object: "model", created: 0, owned_by: "gateway" }] });
  }

  // ---------- /v1/chat/completions ----------
  if (path === "/v1/chat/completions" && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "invalid JSON body" }, 400); }
    const kelivoMessages = body.messages || [];
    console.log("[v1] " + JSON.stringify(summarizeMessagesForLog(kelivoMessages)));

    const oldTimeline = await loadTimeline(env);

    // 给没有时间戳的 user/assistant 消息补上到达时间戳，
    // 否则唤醒逻辑无法判断"最后说话时间"，AI 就不会主动发消息
    const nowTs = formatLocalTimestamp(cfg);
    const stampedMessages = kelivoMessages.map(m => {
      if (m && (m.role === "user" || m.role === "assistant")) {
        const content = normalizeContentToText(m.content);
        if (content && !parseTimestampLabel(content)) {
          return { ...m, content: `（${nowTs}）${content}` };
        }
      }
      return m;
    });

    // 用补过时间戳的消息写时间戳记忆库
    const tsDB = await loadTimestampDB(env);
    let tsDBDirty = false;
    for (const msg of stampedMessages) {
      if (msg.role === "system" || msg.role === "tool") continue;
      const ts = extractTimestamp(normalizeContentToText(msg.content));
      if (!ts) continue;
      const fp = makeFingerprint(msg);
      const fpStripped = makeFingerprintStripped(msg);
      if (!tsDB[fp]) { tsDB[fp] = ts.toISOString(); tsDBDirty = true; }
      if (!tsDB[fpStripped]) { tsDB[fpStripped] = ts.toISOString(); tsDBDirty = true; }
    }
    if (tsDBDirty) await saveTimestampDB(env, tsDB);

    const finalTimeline = buildTimeline(stampedMessages, oldTimeline, tsDB);
    await saveTimeline(env, finalTimeline);

    let llmMessages = kelivoMessages.filter(m =>
      m && (typeof m.content === "string" || Array.isArray(m.content) ||
        (m.role === "assistant" && m.tool_calls) || m.role === "tool")
    );

    // 让 AI 明确知道它主动发过什么、在什么时候发的：注入带时间戳的推送记录
    const proactivePushes = oldTimeline
      .filter(isSpecialEvent)
      .map(extractProactivePushRecord)
      .filter(Boolean)
      .slice(-10);
    if (proactivePushes.length > 0) {
      llmMessages.unshift({
        role: "system",
        content: `【你主动发过的消息记录】以下是你之前主动给她发的手机推送（这是你自己的行为，你要承认并记住，跟她聊天时顺着这些自然衔接，不要装作没发过）：\n${proactivePushes.map((p, i) => `${i + 1}. ${p.time ? `${p.time} ｜ ` : ""}${p.body}`).join("\n")}`
      });
    }

    // 自动修复不完整的 tool 调用（与 Node 版一致）
    const removeSet = new Set();
    for (let i = 0; i < llmMessages.length; i++) {
      const msg = llmMessages[i];
      if (msg.role !== "assistant" || !msg.tool_calls) continue;
      const expectedIds = msg.tool_calls.map(tc => tc.id);
      const followingTools = [];
      for (let j = i + 1; j < llmMessages.length; j++) {
        const nxt = llmMessages[j];
        if (nxt.role === "tool") followingTools.push(nxt); else break;
      }
      const foundIds = followingTools.map(t => t.tool_call_id);
      if (!expectedIds.every(id => foundIds.includes(id))) {
        removeSet.add(i);
        for (let j = i + 1; j < llmMessages.length; j++) {
          if (llmMessages[j].role === "tool") removeSet.add(j); else break;
        }
      }
    }
    for (let i = 0; i < llmMessages.length; i++) {
      if (llmMessages[i].role !== "tool") continue;
      let hasMatchingToolCalls = false;
      for (let j = i - 1; j >= 0; j--) {
        const prev = llmMessages[j];
        if (prev.role === "assistant" && prev.tool_calls) {
          if (prev.tool_calls.map(tc => tc.id).includes(llmMessages[i].tool_call_id)) hasMatchingToolCalls = true;
          break;
        } else if (prev.role === "tool") continue;
        else break;
      }
      if (!hasMatchingToolCalls) removeSet.add(i);
    }
    const sortedRemove = Array.from(removeSet).sort((a, b) => b - a);
    for (const idx of sortedRemove) llmMessages.splice(idx, 1);

    if (!cfg.TARGET_API_URL || !cfg.TARGET_API_KEY) {
      return json({ error: "TARGET_API_URL / TARGET_API_KEY 未配置" }, 500);
    }

    // 透明转发到上游：保留 Kelivo 传来的 tools（MCP 工具）与 stream 等参数，
    // 只把 model 统一成 Worker 配置的模型、messages 换成注入过推送记录的消息。
    const upstreamResponse = await fetch(cfg.TARGET_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.TARGET_API_KEY}` },
      body: JSON.stringify({ ...body, model: cfg.MODEL_NAME, messages: llmMessages })
    });

    const upstreamContentType = upstreamResponse.headers.get("content-type") || "";
    const isStreaming = upstreamContentType.includes("text/event-stream");

    // 上游出错：原样透传错误
    if (!upstreamResponse.ok) {
      const errText = await upstreamResponse.text();
      return new Response(errText, {
        status: upstreamResponse.status,
        headers: { "Content-Type": upstreamContentType || "application/json" }
      });
    }

    // 流式：原样透传（含 tool_calls / reasoning 等 delta），MCP 工具调用由 Kelivo 自己闭环
    if (isStreaming) {
      return new Response(upstreamResponse.body, {
        status: 200,
        headers: { "Content-Type": upstreamContentType, "Cache-Control": "no-cache" }
      });
    }

    // 非流式：缓冲后处理 [PUSH] 标记（对话内要求发推送）
    const fullText = await upstreamResponse.text();
    const aiContent = extractContentFromUpstream(fullText, upstreamContentType);
    const pushExtract = extractPushFromReply(aiContent);
    if (pushExtract.push) {
      const pushTitle = (cfg.PUSH_TITLE || "来自 AI").slice(0, 20);
      const pushBody = pushExtract.push.body.slice(0, 20);
      const pr = await sendPushNotification(env, cfg, { title: pushTitle, body: pushBody });
      console.log(`[v1] 对话内推送请求，发送结果: ${JSON.stringify(pr)}`);
      // 记录这次推送：既更新唤醒冷却，也写进时间线，让 AI 之后知道自己发过什么
      if (pr.ok) {
        await env.CONFIG.put("lastWakeSent", new Date().toISOString());
        await appendSpecialEvent(env, `（${nowTs} 刚刚给用户发了${pr.providerLabel}推送：${pushTitle}｜${pushBody}）`);
      }
    }

    // JSON 响应：把 content 替换为去除标记后的内容（保留 tool_calls 等其他字段）
    let outObj = {};
    try { outObj = JSON.parse(fullText); } catch {}
    if (outObj?.choices?.[0]?.message) {
      const origContent = outObj.choices[0].message.content;
      // 只在有正文（或确有 [PUSH] 要剥离）时改写 content；纯 tool_calls 消息保持原样
      if (origContent != null || pushExtract.push) {
        outObj.choices[0].message.content = pushExtract.remaining;
      }
    }
    return new Response(JSON.stringify(outObj), {
      status: 200,
      headers: { "Content-Type": upstreamContentType || "application/json" }
    });
  }

  // ---------- /mcp MCP 服务（Kelivo 的 MCP 功能连这里） ----------
  if (path === "/mcp") {
    return handleMcp(request, env, cfg);
  }

  // ---------- /admin 管理页 ----------
  if (path === "/admin" && request.method === "GET") {
    const lastWakeSent = await env.CONFIG.get("lastWakeSent");
    const wakeStatus = lastWakeSent
      ? `在线（上次推送: ${formatLocalTimestamp(cfg, new Date(lastWakeSent))}）`
      : "等待首次唤醒";
    const diaryEntries = await readDiaryEntries(env, 20);
    const diaryHtml = diaryEntries.length
      ? diaryEntries.map(entry => `
        <details class="diary-entry">
          <summary><span>${escapeHtml(entry.name)}</span></summary>
          <pre>${escapeHtml(entry.content)}</pre>
        </details>
      `).join("")
      : `<div class="diary-empty">还没有日记。模型在 wake-up 回复里输出 [DIARY]...[/DIARY] 后会保存到这里。</div>`;
    const presets = await loadPresets(env);
    // 批注：用 UTF-8 编码后再 base64，与 checkBasicAuth 的 TextDecoder(UTF-8) 对齐，
    // 修复非 ASCII（中文/emoji）管理员密码在管理页内请求时鉴权失败的问题。
    const authToken = btoa(String.fromCharCode(...new TextEncoder().encode(`${cfg.ADMIN_USER}:${cfg.ADMIN_PASSWORD}`)));
    const state = {
      gatewayStatus: "运行中（Cloudflare 边缘）",
      wakeStatus,
      runtimeNotice: "",
      diaryHtml,
      currentUrl: escapeHtml(cfg.TARGET_API_URL),
      currentModel: escapeHtml(cfg.MODEL_NAME),
      currentIcon: escapeHtml(cfg.CUSTOM_ICON_URL),
      gatewayKeyStatus: escapeHtml(cfg.GATEWAY_API_KEY ? "已配置" : "未配置"),
      wakeConfig: {
        dayWakeAfter: escapeHtml(cfg.DAY_WAKE_AFTER_MINUTES),
        nightWakeAfter: escapeHtml(cfg.NIGHT_WAKE_AFTER_MINUTES),
        dayCheckInterval: escapeHtml(cfg.DAY_CHECK_INTERVAL_MINUTES),
        nightCheckInterval: escapeHtml(cfg.NIGHT_CHECK_INTERVAL_MINUTES),
        dayStartHour: escapeHtml(cfg.WAKE_DAY_START_HOUR),
        dayEndHour: escapeHtml(cfg.WAKE_DAY_END_HOUR)
      },
      weatherConfig: {
        enabled: cfg.WEATHER_ENABLED,
        locationName: escapeHtml(cfg.WEATHER_LOCATION_NAME),
        lat: escapeHtml(cfg.WEATHER_LAT),
        lon: escapeHtml(cfg.WEATHER_LON),
        units: cfg.WEATHER_UNITS
      },
      authHeaderJson: JSON.stringify(`Basic ${authToken}`).replace(/</g, "\\u003c").replace(/>/g, "\\u003e"),
      presetsJson: JSON.stringify(presets).replace(/</g, "\\u003c").replace(/>/g, "\\u003e")
    };
    const html = adminPageHtml(state);
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  // ---------- /admin/save ----------
  if (path === "/admin/save" && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "invalid JSON body" }, 400); }
    if (!body?.target_url || !body?.model_name) {
      return json({ error: "target_url / model_name 必填" }, 400);
    }
    const updates = {};
    const map = {
      target_url: "TARGET_API_URL", target_key: "TARGET_API_KEY", gateway_api_key: "GATEWAY_API_KEY",
      model_name: "MODEL_NAME", bark_key: "BARK_KEY", custom_icon: "CUSTOM_ICON_URL",
      day_wake_after: "DAY_WAKE_AFTER_MINUTES", night_wake_after: "NIGHT_WAKE_AFTER_MINUTES",
      day_check_interval: "DAY_CHECK_INTERVAL_MINUTES", night_check_interval: "NIGHT_CHECK_INTERVAL_MINUTES",
      wake_day_start_hour: "WAKE_DAY_START_HOUR", wake_day_end_hour: "WAKE_DAY_END_HOUR",
      weather_enabled: "WEATHER_ENABLED", weather_location_name: "WEATHER_LOCATION_NAME",
      weather_lat: "WEATHER_LAT", weather_lon: "WEATHER_LON", weather_units: "WEATHER_UNITS"
    };
    for (const [field, key] of Object.entries(map)) {
      const raw = String(body[field] ?? "").trim();
      if (raw !== "") updates[key] = raw;
    }
    await saveConfig(env, updates);
    return json({ success: true });
  }

  // ---------- /admin/presets/save ----------
  if (path === "/admin/presets/save" && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "invalid JSON body" }, 400); }
    const { name, target_url, target_key, model_name } = body || {};
    if (!name || !target_url || !model_name) return json({ error: "name / target_url / model_name 必填" }, 400);
    const presets = await loadPresets(env);
    const existing = presets.findIndex(p => p.name === name);
    const entry = { name, target_url, target_key: target_key || "", model_name };
    if (existing >= 0) presets[existing] = entry; else presets.push(entry);
    await savePresets(env, presets);
    return json({ success: true });
  }

  // ---------- /admin/presets/delete ----------
  if (path === "/admin/presets/delete" && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "invalid JSON body" }, 400); }
    const presets = (await loadPresets(env)).filter(p => p.name !== body?.name);
    await savePresets(env, presets);
    return json({ success: true });
  }

  // ---------- /admin/restart ----------
  if (path === "/admin/restart" && request.method === "POST") {
    return json({ success: true, note: "云端无需重启，配置已即时生效" });
  }

  // ---------- /icon 图标托管（Bark 推送 icon 用） ----------
  if (path === "/icon" && request.method === "GET") {
    const b64 = await env.CONFIG.get("push_icon");
    if (!b64) return new Response("No icon", { status: 404 });
    try {
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      return new Response(bytes, {
        headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" }
      });
    } catch {
      return new Response("Bad icon", { status: 500 });
    }
  }

  // ---------- /__wake 诊断 ----------
  if (path === "/__wake" && request.method === "GET") {
    if (!checkGatewayKey(request, cfg)) return json({ error: "key" }, 401);
    const read = async () => ({
      nextCheckAt: await env.CONFIG.get("nextCheckAt"),
      lastWakeSent: await env.CONFIG.get("lastWakeSent"),
      now: new Date().toISOString()
    });
    const before = await read();
    if (url.searchParams.get("force") === "1") {
      await env.CONFIG.put("nextCheckAt", new Date(0).toISOString());
      await env.CONFIG.put("lastWakeSent", new Date(0).toISOString());
    }
    let err = null;
    try { await runWakeUp(env, cfg); } catch (e) { err = e.message + " | " + e.stack; }
    const after = await read();
    return json({ ok: true, error: err, before, after, cfg: { targetUrl: cfg.TARGET_API_URL, model: cfg.MODEL_NAME } });
  }

  // ---------- /test-bark ----------
  if (path === "/test-bark" && request.method === "GET") {
    if (!checkGatewayKey(request, cfg)) return json({ error: "Gateway API Key 无效或缺失" }, 401);
    const ts = formatLocalTimestamp(cfg);
    await appendSpecialEvent(env, `（${ts} 刚刚给用户发了 Bark：这是一条测试推送。）`);
    return json({ success: true });
  }

  return new Response("Not Found", { status: 404 });
}

// ---------- Cron 自动唤醒 ----------
async function scheduledHandler(event, env) {
  const cfg = await loadConfig(env);
  try {
    await runWakeUp(env, cfg);
  } catch (err) {
    console.error("[scheduled] 唤醒出错:", err.message);
  }
}

// ---------- Worker 入口 ----------
export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (err) {
      console.error("[fetch] 处理出错:", err);
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  },
  async scheduled(event, env) {
    await scheduledHandler(event, env);
  }
};
