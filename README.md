# Dylan Heartbeat — Cloud

**一个给 Kelivo AI 伴侣使用的免费云端版。**  
把原项目从「需要付费的服务器」搬到「永久免费的 Cloudflare Workers」，保留原项目的全部核心设计。

> [!IMPORTANT]
> **基于 [callie0313/dylan-heartbeat](https://github.com/callie0313/dylan-heartbeat) 移植，沿用其 [PolyForm Noncommercial License 1.0.0](LICENSE)。仅授权个人非商业使用，禁止付费代部署及任何商业用途。** 核心设计与署名均来自原作者 Callie，本仓库只改写了运行平台。

> 使用方式：点下方按钮一键部署；或先点 [Use this template](https://github.com/gzxczg327-dev/dylan-heartbeat-cloud/generate) 复制一份到你的账号再部署。

---

## 致敬原作者

本项目的核心设计 —— 主动唤醒、时间线记忆、推送机制 —— 全部来自 [callie0313/dylan-heartbeat](https://github.com/callie0313/dylan-heartbeat)，作者空气小狗。本仓库没有改动任何核心逻辑，只把运行方式从付费服务器改写为 Cloudflare Workers，让更多人能零成本使用。感谢原作者的开放与贡献。

---

## 与原版的区别（本版本新增）

原版的全部功能请见原仓库，这里只列出本版本新增的部分：

-  **免费托管** – 运行在 Cloudflare Workers 免费额度上，无需 Railway / Render / VPS，无需绑卡
-  **一键部署** – 点下方按钮即可部署代码

---

##  准备清单

| 需要什么 | 在哪获取 | 费用 |
|---------|---------|------|
| Cloudflare 账号 | https://dash.cloudflare.com | 免费 |
| 一个域名 | 自己的，或用免费 us.kg | 免费 |
| 上游 API Key | DeepSeek https://platform.deepseek.com 或任意 OpenAI 兼容 API | 按量付费 |
| Bark App 与 Key | App Store 搜索 Bark | 免费 |
| Kelivo App | App Store 搜索 Kelivo | 免费 |

---

##  一键部署教程

### 第 1 步：一键部署代码

点击下方按钮，按提示授权 GitHub 与 Cloudflare，随后会自动创建一个名为 dylan-heartbeat 的 Worker 并部署代码。

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/gzxczg327-dev/dylan-heartbeat-cloud)

### 第 2 步：绑定 KV 存储

KV 命名空间的 id 是每个账号独有的，无法由按钮自动创建，需要手动绑定一次：

1. 面板左侧 Workers & Pages → KV → Create a namespace，名字填 CONFIG
2. 进入你的 Worker → Settings → Variables → 找到 KV Namespace Bindings → Add binding
3. 变量名填 CONFIG，选择刚创建的命名空间，Save

### 第 3 步：添加 Cron 定时器

1. Worker → Settings → Triggers → Cron Triggers → Add Cron Trigger
2. 名称随意，表达式填 `* * * * *`（每分钟检查一次，代码内部会自行判断是否真的需要唤醒）
3. Save

### 第 4 步：配置变量

Worker → Settings → Variables → Add。密码类建议用 Add secret（加密存储）。

| 变量名 | 填什么 | 说明 |
|--------|--------|------|
| TARGET_API_URL | https://api.deepseek.com/v1/chat/completions | DeepSeek 官方 OpenAI 兼容端点 |
| TARGET_API_KEY | sk- 开头的 DeepSeek Key | 用 Secret 存储 |
| MODEL_NAME | deepseek-v4-flash | 官方 V4 模型（老 deepseek-chat / deepseek-reasoner 已于 2026-07-24 停用） |
| GATEWAY_API_KEY | 自己编一长串随机字符 | Kelivo 里填这个，不是上游 Key |
| BARK_KEY | Bark App 里的 Key | iPhone 推送 |
| ADMIN_USER | 如 admin | 管理页用户名 |
| ADMIN_PASSWORD | 自己定一个密码 | 管理页密码，务必设置 |
| TIME_ZONE | Asia/Shanghai | 时区 |

填完后点右上角 Deploy 重新部署，让变量生效。

> [!NOTE]
> **模型是单一真相源**：聊天和主动唤醒都用 Worker 里 `MODEL_NAME` 指定的模型（`deepseek-v4-flash`，官方默认开启思考模式=深度推理）。Kelivo 供应商里填的 Model 只用于显示，会被 Worker 覆盖成上面的官方模型，避免在两边改来改去导致「崩人设」。人设和记忆只在 Kelivo 里维护，Worker 不注入任何风格指令。

### 第 5 步：绑定自定义域名

1. Worker → Settings → Domains & Routes → Custom Domains → Add
2. 输入一个子域名，如 ai.你的域名.com
3. Cloudflare 会自动配好 DNS 和证书，等状态变绿

> [!NOTE]
> 必须绑定自己的域名，不能直接用 Cloudflare 默认的 *.workers.dev 地址（该地址在中国大陆访问不稳定/被墙）。如果你不绑定域名，或只想自己用，开 VPN 也能稳定访问 `*.workers.dev`。

### 第 6 步：Kelivo 接入

打开 Kelivo → 设置 → 供应商 → 添加 → 选 OpenAI：

| 设置项 | 填什么 |
|--------|--------|
| Base URL | https://ai.你的域名.com/v1 |
| API Key | 第 4 步的 GATEWAY_API_KEY |
| Model | deepseek-v4-flash |

点测试连通性，成功后即可开聊。

### 第 7 步（可选）：用 MCP 让 AI 主动查「自己发过什么」

Worker 内置了一个 MCP 服务（Streamable HTTP），Kelivo 的 MCP 功能可以直接连上来，让 AI 需要时主动查推送/聊天记录：

| 设置项 | 填什么 |
|--------|--------|
| MCP Server 地址 | https://你的域名/mcp（workers.dev 则是 https://dylan-heartbeat.你的子域.workers.dev/mcp） |
| 凭证 / Key | 第 4 步的 GATEWAY_API_KEY |

连接后会多出两个工具：`read_push_records`（查主动推送记录，含时间+正文）、`read_chat_timeline`（查最近聊天时间线）。Kelivo 里启用 MCP 后，模型可能发起工具调用，你审核后即可执行。

### 验证

1. 在 Kelivo 里和 AI 聊几句
2. 停止说话，AI 会在随机间隔后主动推送到手机
3. 浏览器打开 https://ai.你的域名.com/admin（用 ADMIN_USER / ADMIN_PASSWORD 登录），可以改配置、看日记

---

##  部署完成后回到原项目继续

到这里，Cloudflare 部署部分就完成了——你的 Worker 已经是一个可用的网关，Kelivo 也已接入。

接下来的「日常使用与个性化配置」和原项目完全一致，请回到原仓库 README 继续，从下面这几节接着看：

- **管理页面（Web 控制台）** – 了解状态、看日记、改配置。Cloudflare 版的管理页地址是 https://你的域名/admin
- **自动唤醒策略** – 与原版完全一致（白天/夜间阈值 + 随机化），配置项名称也相同
- **天气注入** – 开启后 AI 唤醒时会带上你所在地的天气（配置项一致）
- **推送渠道** – Bark（iOS）与 ntfy（安卓）的配置说明（配置项一致）
- **自动日记** – AI 主动输出 [DIARY] 时如何保存日记

一句话总结：本移植版只替换了原 README 的「安装与配置 → 启动服务 → 配置 Kelivo」这三步（也就是"部署服务器"这一步），其余章节（管理页、唤醒策略、天气、推送、日记）全部原样适用。

原项目 README：https://github.com/callie0313/dylan-heartbeat


---

##  常见问题

| 问题 | 解决 |
|------|------|
| Kelivo 连不上 | 检查域名绑定是否成功、Base URL 末尾是否有 /v1 |
| AI 不发消息 | 先在 Kelivo 发一条消息建立计时；确认 Cron 定时器已添加 |
| 手机收不到推送 | Bark 里先点推送测试；确认 BARK_KEY 填对 |
| 想改 AI 人设 | 在 Kelivo 里改助手的人设或记忆即可，本 Worker 不会覆盖 |
| 想清空记忆 | 在 KV 的 CONFIG namespace 里删掉 timeline 键 |
| 打不开 /admin 或 workers.dev | 绑定自定义域名，或开 VPN 访问 |
| AI 不知道自己发过什么 | 聊天时 Worker 会把「时间 + 推送内容」注入给模型；确认上游模型是 deepseek-v4-flash |
| 想在对话里让 AI 发推送（[PUSH]） | 把 [PUSH]标题\|正文[/PUSH] 的用法写进 Kelivo 的人设里（Worker 不再注入推送指令，避免崩人设） |

---

##  许可证

[PolyForm Noncommercial 1.0.0](LICENSE)，个人非商业使用。使用与再分发请遵守 LICENSE 中的署名要求。
