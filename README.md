# Telegram 群管理机器人（Cloudflare Workers 版）

一个部署在 **Cloudflare Workers** 上的 Telegram 群管理机器人，主要用于：

- 新成员进群 **真人验证**（防广告、防机器人）
- 可选的 **“必须关注指定频道”** 验证
- 基于 **关键词黑名单** 的自动删除 + 自动封禁
- 管理员命令：禁言、踢出群、解除封禁
- 关键词列表存放在 **GitHub 文件中**，随时改随时生效（无需重新部署）

---

## 功能说明

### 1. 新成员进群验证

- 新成员进群后，机器人会：
  - 先 **限制其发言权限**
  - 在群里发送一条验证消息 + 按钮  
    > 「✅ 我是真人，点击验证」
- 成员点击按钮后：
  - （如果配置了要求关注的频道）会检查他是否关注了该频道  
  - 验证通过后 **恢复正常发言权限**

> 验证中“是否需要关注频道”是可选项：如果不配置频道，机器人只做真人验证，不检查关注情况。

---

### 2. 关注指定频道（可选）

- 通过环境变量 `REQUIRED_CHANNEL` 配置，例如：`@yourchannel`
- 当用户点击验证按钮时：
  - 机器人会调用 `getChatMember` 检查用户是否已关注该频道
  - 未关注则弹窗提示“请先关注频道后再验证”
- 如果不设置 `REQUIRED_CHANNEL`，则 **不会检查** 订阅状态

---

### 3. 关键词自动封禁（词表在 GitHub）

- 关键词列表存放在你 GitHub 仓库中的一个纯文本文件，如：`rules/banned_keywords.txt`
- 每行一个关键词，支持注释和空行，例如：

  ```text
  # 一行一个关键词，支持中文、英文
  广告
  推广
  色情
  https://t.me/

  # 暂时不用的可以注释掉
  # 赌场
  # 博彩
机器人通过环境变量 BANNED_KEYWORDS_URL 读取该文件（使用 raw 地址），并在 Worker 内部做简单缓存（默认 5 分钟刷新一次）

群成员发送消息时：

若内容包含任意黑名单关键词：

❌ 自动删除该条消息

🚫 对该用户执行封禁（使用 banChatMember，封禁时长由 BAN_DURATION_SECONDS 控制，默认 1 天）

在群里提示该用户因触发敏感词被封禁

4. 管理员命令（自动识别群管理员）

机器人不会使用固定管理员 ID，而是通过 getChatAdministrators 动态判断：

只有 群管理员 可以使用下面命令

用法均为：先回复目标用户的消息 然后发送命令

/ban

禁言（不踢出群）：

回复某人 + /ban
→ 永久禁言（关闭所有发送权限）

回复某人 + /ban 60
→ 禁言 60 分钟（60 为分钟数，可自行修改）

禁言效果：用户仍在群内，但不能发送任何消息/媒体。

/banl

踢出群（kick）：

回复某人 + /banl
→ 将该用户移出群组
实现方式：banChatMember + 立即 unbanChatMember，使其被踢出，但后续如需可以再进群。

/unban

解除禁言 / 封禁：

回复某人 + /unban

解除禁言（恢复发送消息权限）

同时尝试解除 ban（如果之前用的是 banChatMember）

项目架构

运行环境：Cloudflare Workers（无服务器、免费配额）

消息入口：Telegram Webhook

语言：TypeScript

关键词配置：托管在 GitHub，通过 BANNED_KEYWORDS_URL 动态拉取

部署步骤
0. 前置准备

你需要：

一个 Cloudflare 账号

安装 Node.js（推荐 18+）

全局或本地安装 wrangler（Cloudflare 官方 CLI）

一个 Telegram 机器人（在 @BotFather 创建，拿到 BOT_TOKEN）

一个 GitHub 仓库，用来：

存放本项目代码

存放 banned_keywords.txt（关键词列表）

1. 克隆项目代码
git clone https://github.com/yourname/tg-group-manager-bot.git
cd tg-group-manager-bot
npm install


仓库名、地址按你的实际情况替换。

2. 配置关键词文件（GitHub）

在你的仓库中创建文件，例如：

路径：rules/banned_keywords.txt

内容示例：

# 一行一个关键词
广告
推广
色情
https://t.me/


打开该文件，点击 Raw，复制浏览器地址，例如：

https://raw.githubusercontent.com/yourname/yourrepo/main/rules/banned_keywords.txt


这个地址将在后面作为 BANNED_KEYWORDS_URL 使用。

3. 配置 wrangler.toml

项目根目录下新建或修改 wrangler.toml：

name = "tg-group-manager-bot"
main = "src/worker.ts"
compatibility_date = "2024-11-27"

[vars]
# 可选：要求关注的频道（不需要就删掉或留空）
# REQUIRED_CHANNEL = "@your_channel_username"

# 新成员验证时，提示中的“建议在多少秒内完成”
VERIFY_TIMEOUT_SECONDS = "300"

# 关键词触发自动封禁的时长（秒），比如 1 天 = 86400
BAN_DURATION_SECONDS = "86400"

# GitHub 关键词文件的 RAW 地址
BANNED_KEYWORDS_URL = "https://raw.githubusercontent.com/yourname/yourrepo/main/rules/banned_keywords.txt"


REQUIRED_CHANNEL 是 可选 的：

配置后 → 用户验证前会检查是否已关注该频道

不配置 → 只做真人验证，不做频道检查

4. Cloudflare 登录 & 设置 Secret

登录 Cloudflare：

npx wrangler login


设置 Telegram Bot Token（必须，不要写进文件）：

npx wrangler secret put BOT_TOKEN
# 粘贴从 @BotFather 获取的 Token，例如：123456789:ABC-DEF...


BANNED_KEYWORDS_URL 没有敏感信息，可以直接写在 [vars] 里，
如果你不想暴露，也可以用 wrangler secret put BANNED_KEYWORDS_URL 来设置。

5. 部署到 Cloudflare Workers
npm run deploy
# 等价于
# npx wrangler deploy


部署成功后，会得到一个形如：

https://tg-group-manager-bot.your-name.workers.dev


的地址，这就是你的 Webhook URL。

6. 设置 Telegram Webhook

在浏览器打开（或用 curl 调用）：

https://api.telegram.org/bot<你的BOT_TOKEN>/setWebhook?url=https://tg-group-manager-bot.your-name.workers.dev


看到 {"ok":true,...} 就说明 webhook 设置成功。

7. 拉机器人进群 & 设置管理员

在 Telegram 中把机器人拉进目标群组

把机器人设为 管理员，并勾选至少：

删除消息

封禁用户

限制用户

测试：

新成员进群 → 是否弹出验证按钮

尝试发送黑名单关键词 → 是否被删除并封禁

管理员回复某人 /ban、/ban 10、/banl、/unban → 是否正常生效

常见问题
1. 不想强制关注频道怎么办？

确保 wrangler.toml 里 没有 REQUIRED_CHANNEL 或者留空即可。

这样机器人只会做“真人验证”，不会检查关注状态。

2. 修改关键词后需要重新部署吗？

不需要。
关键词文件在 GitHub，Worker 会定期重新拉取（默认 5 分钟缓存）：

你只要改 banned_keywords.txt 并 push 到 GitHub

等几分钟后，新规则就会自动生效

3. 想彻底拉黑某人，不让他再进群？

目前逻辑是：

关键词触发：banChatMember 一段时间（可配置）

/banl：ban 后立刻 unban，相当于“踢出群，但允许以后再进”

如果你想改成“永久 ban 不解封”，可以在代码中去掉 /banl 里的 unbanChatMember 调用。
