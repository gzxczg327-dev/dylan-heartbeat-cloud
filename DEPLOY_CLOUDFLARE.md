# 🚀 部署指南(填空形式)

> 让 Kelivo 里的 AI 在你沉默时主动给你发消息(Bark 推送到 iPhone)。
> 适用:iPhone + DeepSeek API + 中国大陆(不用梯子)。

---

## 📋 准备清单(先准备好这 5 样)

| # | 需要什么 | 在哪拿 | 免费? |
|---|---------|--------|-------|
| 1 | Cloudflare 账号 | <https://dash.cloudflare.com> | ✅ 免费 |
| 2 | 一个域名(自己的或免费的) | 见第 1 步 | ✅ us.kg 免费 |
| 3 | DeepSeek API Key | <https://platform.deepseek.com> | 充值后按量付费 |
| 4 | Bark App + Key | App Store 搜「Bark」 | ✅ 免费 |
| 5 | Kelivo App | App Store 搜「Kelivo」 | ✅ 免费 |

> ⚠️ **为什么必须有域名**:Cloudflare 免费送的 `workers.dev` 域名在中国大陆被墙,手机不挂梯子打不开。绑定一个你自己的域名就能绕开,不用梯子。

---

## 第 1 步:准备域名(不开梯子的关键)

**情况 A:你已经有自己的域名**(比如 `xxx.com`)

1. 把域名添加到 Cloudflare:登录后点 **Add a domain / Websites → Add a site**
2. 按提示把域名的 NS(名称服务器)改成 Cloudflare 分配的
3. 改完后 Cloudflare 显示「Active」即可

**情况 B:没有域名,申请免费域名(推荐 us.kg)**

1. 打开 <https://register.us.kg> 注册账号(邮箱即可)
2. 申请一个免费域名,比如 `ai-你的名字.us.kg`
3. 在 us.kg 后台,把域名的 **Name Server(NS)** 改成 Cloudflare 分配的两个 NS 地址
   - 先到 Cloudflare → Add a domain → 输入你的 `xxx.us.kg` → 选择 **Free 计划** → 它会告诉你两个 NS 地址
4. 回到 us.kg 填这两个 NS → 保存 → 等 Cloudflare 显示「Active」(几分钟到几小时)

---

## 第 2 步:部署 Worker(二选一)

### 方式 A:Dashboard 粘贴(推荐,不用装软件)

1. 打开 <https://dash.cloudflare.com> → 左侧 **Workers & Pages**
2. 点 **Create → Create Worker** → 名字随便填(如 `heartbeat`)→ **Deploy**
3. 点 **Edit code** → 全选删除默认代码
4. 打开本项目的 **`worker.js`** 文件,全选复制,粘贴进去
5. 点右上角 **Deploy**

### 方式 B:wrangler 命令行

```bash
npm install -g wrangler
wrangler login
wrangler kv namespace create CONFIG   # 记下输出的 id,填进 wrangler.toml
wrangler deploy
```

---

## 第 3 步:配 KV 存储 + 定时器

### 3.1 创建 KV(存 AI 的记忆)

1. 左侧 **Workers & Pages → KV** → **Create a namespace** → 名字填 `CONFIG` → Add
2. 回到你的 Worker → **Settings → Variables** → 拉到 **KV Namespace Bindings**
3. **Add binding**:变量名填 `CONFIG`,选刚建的 namespace → Save

### 3.2 开定时器(AI 主动发消息的关键)

1. Worker → **Settings → Triggers** → **Cron Triggers → Add**
2. 表达式填 `* * * * *`(每分钟检查一次,代码内自己判断间隔)→ Save

---

## 第 4 步:绑定域名(不用梯子的关键)

1. Worker → **Settings → Domains & Routes** → **Custom Domains → Add**
2. 输入一个子域名,比如 `ai.你的域名.com` 或 `ai.你的名字.us.kg`
3. Cloudflare 会自动配好 DNS 和证书 → 等它变绿 ✅

> 绑定完成后,你的 Worker 地址就是 `https://ai.你的域名.com`,大陆手机能直接访问。

---

## 第 5 步:填配置(填空形式)

Worker → **Settings → Variables → Add**(密码类建议用 **Add secret**,加密存储)

| 变量名 | 填什么 | 说明 |
|--------|--------|------|
| `TARGET_API_URL` | `https://api.deepseek.com/v1/chat/completions` | 固定不变 |
| `TARGET_API_KEY` | `sk-你的DeepSeek密钥` | 在 platform.deepseek.com 创建 |
| `MODEL_NAME` | `deepseek-chat` | 固定不变 |
| `BARK_KEY` | `你的BarkKey` | iPhone 装 Bark 后在 App 里看到 |
| `GATEWAY_API_KEY` | `自己随便编一长串`(如 30 位随机字母数字) | Kelivo 里填这个,不是 DeepSeek key |
| `ADMIN_USER` | `自己定,如 admin` | 管理页登录用户名 |
| `ADMIN_PASSWORD` | `自己定一个密码` | 管理页登录密码 |
| `PUSH_TITLE` | `DeepSeek`(或你想显示的名字) | 通知栏大字标题 |
| `TIME_ZONE` | `Asia/Shanghai` | 时区,固定 |

> 这些填完,**点 Deploy 重新部署**让它们生效。

---

## 第 6 步:Kelivo 里填(填空)

打开 Kelivo → 设置 → 供应商 → 添加 → 选 **OpenAI**,填:

| 设置项 | 填什么 |
|--------|--------|
| 基础地址 Base URL | `https://ai.你的域名.com/v1` |
| API Key | 你在第 5 步填的 `GATEWAY_API_KEY` |
| 模型 Model | `deepseek-chat` |

填完点「测试连通性」,成功即可。

---

## ✅ 验证 + 调频率

1. 在 Kelivo 里跟 AI 聊几句(它会记住)
2. **停止说话**,过 2~20 分钟随机,AI 会主动推送到 iPhone 通知
3. 想调频率:电脑打开 `https://ai.你的域名.com/admin`(用 ADMIN_USER/ADMIN_PASSWORD 登录)→ **Wake Settings**:
   - 最短多久后主动发消息(默认 2 分钟)
   - 最长多久后主动发消息(默认 20 分钟)
   - 推送冷却(默认 2 分钟)

---

## ❓ 常见问题

| 问题 | 解决 |
|------|------|
| Kelivo 测试连不上 | 检查域名绑定成功没、URL 末尾有没有 `/v1` |
| AI 不发消息 | 先在 Kelivo 发一条消息建立计时;确认 Cron 定时器加了 |
| 手机收不到推送 | Bark App 里先点「推送测试」;确认 BARK_KEY 填对 |
| 想改 AI 人设 | 在 Kelivo 里改助手的人设/记忆即可,Worker 不会破坏 |
| 想清空 AI 记忆 | KV → CONFIG namespace → 删掉 `timeline` 键 |
