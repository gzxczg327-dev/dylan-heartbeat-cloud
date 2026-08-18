# Dylan Heartbeat — Cloud（免费云端版）

让 **Kelivo** 里的 AI 伴侣 24 小时在线、永久免费运行：当你沉默时，AI 会自己醒来，决定要不要主动给你发消息（iPhone 的 Bark / 安卓的 ntfy 推送），并把这些主动行为记进共同记忆里。

> 这是 [callie0313/dylan-heartbeat](https://github.com/callie0313/dylan-heartbeat) 的 **Cloudflare Workers 免费云端版**：核心逻辑沿用原项目，只是把「需要自建/付费的 Node 服务器」换成「永久免费的 Cloudflare Worker」。

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/gzxczg327-dev/dylan-heartbeat-cloud)

---

## ✨ 核心能力

- 🧠 持续记忆 — 对话存 Cloudflare KV，AI 记得发生过的事
- ⏰ 主动唤醒 — 你不说话，AI 自己醒来，按配置的随机间隔主动找你（默认 2~180 分钟）
- 📳 手机推送 — Bark（iPhone）/ ntfy（安卓）
- 💬 连发对话 — AI 不再一问一答，可一次连发几句短句
- 🎭 人设不破坏 — 完整保留你在 Kelivo 里设置的角色
- 🌡️ 话题素材 — 天气 / 时间 / 例假周期，自然融入聊天
- 📔 心情日记 — AI 主动联系时随手记一句

---

## 🌐 需要梯子吗？—— 不需要

手机只跟 Worker（Cloudflare 边缘）通信，Worker 再去请求上游 API；默认上游是国内的 DeepSeek，直连即可。

> 唯一要求：**必须绑定自己的域名**。Cloudflare 送的 `*.workers.dev` 免费域名在中国大陆被墙，绑定一个自己的域名（us.kg 免费域名即可）就能绕开、不用梯子。

---

## 🔌 支持哪些 API？

网关实现的是 OpenAI 兼容协议（`/v1/chat/completions` + `/v1/models`），**任何 OpenAI 兼容 API 都能用**：DeepSeek、Moonshot Kimi、通义 Qwen、智谱 GLM、豆包/火山方舟、硅基流动、OpenAI、Claude（OpenAI 兼容端点）、Gemini（OpenAI 兼容端点）、OpenRouter 等。

只需改三个配置：`TARGET_API_URL`、`TARGET_API_KEY`、`MODEL_NAME`。

---

## 🚀 快速部署

**完整步骤见 [DEPLOY_CLOUDFLARE.md](DEPLOY_CLOUDFLARE.md)**（填空式，照着填就行）。一句话流程：

1. 点上方 **Deploy to Cloudflare Workers** 按钮，一键部署代码
2. 配 KV 存储（binding 名填 `CONFIG`）+ Cron 定时器（表达式 `* * * * *`）
3. 绑定自定义域名（不开梯子的关键）
4. 在 Variables/Secrets 里填配置（见下方清单）
5. Kelivo 里填域名 + `GATEWAY_API_KEY`，开聊

---

## 🔑 配置清单

| 变量名 | 填什么 |
|--------|--------|
| `TARGET_API_URL` | 上游 OpenAI 兼容端点，如 `https://api.deepseek.com/v1/chat/completions` |
| `TARGET_API_KEY` | 上游 API Key（DeepSeek 的 `sk-` 开头） |
| `MODEL_NAME` | 模型名，如 `deepseek-chat` |
| `GATEWAY_API_KEY` | 自己编的长随机串；Kelivo 里填这个，不是上游 Key |
| `BARK_KEY` | Bark App 里的 Key（iPhone 推送） |
| `ADMIN_USER` / `ADMIN_PASSWORD` | 管理页账号密码（务必设置，不能留空） |
| `TIME_ZONE` | `Asia/Shanghai` |

> 代码里不含任何密钥、密码、图片，全部由你部署时填入。

---

## 📁 文件说明

| 路径 | 作用 |
|------|------|
| `worker.js` | Worker 单文件（核心，全部逻辑） |
| `wrangler.toml` | CLI 部署配置 |
| `DEPLOY_CLOUDFLARE.md` | 部署指南（填空式） |

---

## 📜 许可证

基于 [callie0313/dylan-heartbeat](https://github.com/callie0313/dylan-heartbeat)，沿用其 [PolyForm Noncommercial 1.0.0](LICENSE)（个人非商业使用）。详见 LICENSE。
