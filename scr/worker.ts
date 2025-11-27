export interface Env {
  BOT_TOKEN: string;

  // 可选：要求关注的频道用户名，例如 "@yourchannel"
  // 不配置或为空，则不做关注检查（你说的“可选项”）
  REQUIRED_CHANNEL?: string;

  // 新成员验证提示里的建议超时时间（秒）
  VERIFY_TIMEOUT_SECONDS?: string;

  // 关键词触发时，自动封禁用户的封禁时间（秒，banChatMember）
  BAN_DURATION_SECONDS?: string;

  // 关键词列表的 GitHub 原始文件地址，比如：
  // https://raw.githubusercontent.com/yourname/yourrepo/main/banned_keywords.txt
  BANNED_KEYWORDS_URL?: string;
}

type TelegramUpdate = {
  update_id: number;
  message?: any;
  callback_query?: any;
};

const TELEGRAM_API_BASE = "https://api.telegram.org";

// ---------- 通用 Telegram API 调用 ----------

async function callTelegram(env: Env, method: string, params: Record<string, unknown>) {
  const url = `${TELEGRAM_API_BASE}/bot${env.BOT_TOKEN}/${method}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });

  let data: any;
  try {
    data = await resp.json();
  } catch (e) {
    console.error("Telegram API parse error", method, e);
    return null;
  }
  if (!data.ok) {
    console.error("Telegram API error", method, data);
  }
  return data;
}

// ---------- 关键词从 GitHub 拉取 & 缓存 ----------

let cachedKeywords: string[] = [];
let lastKeywordsFetch = 0;

async function getBannedKeywords(env: Env): Promise<string[]> {
  const url = env.BANNED_KEYWORDS_URL;
  if (!url) return [];

  const now = Date.now();
  // 简单缓存 5 分钟，减少请求 GitHub 次数
  if (cachedKeywords.length > 0 && now - lastKeywordsFetch < 5 * 60 * 1000) {
    return cachedKeywords;
  }

  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      console.error("Failed to fetch banned keywords:", resp.status);
      return cachedKeywords; // 返回旧缓存
    }
    const text = await resp.text();
    const list = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));

    cachedKeywords = list;
    lastKeywordsFetch = now;
    console.log("Loaded banned keywords:", cachedKeywords);
  } catch (e) {
    console.error("Error fetching banned keywords:", e);
  }

  return cachedKeywords;
}

// ---------- 检查是否群管理员 ----------

async function isAdmin(env: Env, chatId: number, userId?: number): Promise<boolean> {
  if (!userId) return false;
  const res = await callTelegram(env, "getChatAdministrators", { chat_id: chatId });
  if (!res || !res.result) return false;

  const admins: any[] = res.result;
  return admins.some((m) => m.user && m.user.id === userId);
}

// ---------- /ban 参数解析 ----------

function parseBanDurationMinutes(text?: string): number | null {
  if (!text) return null; // 代表“永久禁言”
  const n = Number(text);
  if (Number.isNaN(n) || n <= 0) return null;
  return n;
}

// ---------- Worker 入口 ----------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("OK");
    }

    const update = (await request.json()) as TelegramUpdate;

    try {
      if (update.message) {
        await handleMessage(update.message, env);
      } else if (update.callback_query) {
        await handleCallbackQuery(update.callback_query, env);
      }
    } catch (e) {
      console.error("Error handling update", e);
    }

    return new Response("OK");
  },
};

// ---------- 消息处理 ----------

async function handleMessage(message: any, env: Env) {
  const chat = message.chat;
  const chatId = chat.id;

  // 新成员进群
  if (message.new_chat_members && Array.isArray(message.new_chat_members)) {
    for (const member of message.new_chat_members) {
      await handleNewMember(chatId, member, env);
    }
    return;
  }

  const text: string | undefined = message.text;

  // 只处理群消息中的文字内容
  if (!text || !chat || (chat.type !== "group" && chat.type !== "supergroup")) {
    return;
  }

  // 管理命令
  if (text.startsWith("/banl")) {
    await handleBanKickCommand(message, env); // /banl 踢出群
    return;
  }
  if (text.startsWith("/ban")) {
    await handleBanCommand(message, env); // /ban 禁言
    return;
  }
  if (text.startsWith("/unban")) {
    await handleUnbanCommand(message, env);
    return;
  }

  // 关键词检测（GitHub 词表）
  const banned = await getBannedKeywords(env);
  if (banned.length > 0) {
    const lowered = text.toLowerCase();
    const hit = banned.find((w) => w && lowered.includes(w.toLowerCase()));
    if (hit) {
      const userId = message.from?.id;
      if (!userId) return;

      // 删除消息
      await callTelegram(env, "deleteMessage", {
        chat_id: chatId,
        message_id: message.message_id,
      });

      // 关键词：直接 banChatMember（踢 + 封禁一段时间）
      const baseBanSeconds = Number(env.BAN_DURATION_SECONDS || "86400"); // 默认 1 天
      const untilDate = Math.floor(Date.now() / 1000) + baseBanSeconds;

      await callTelegram(env, "banChatMember", {
        chat_id: chatId,
        user_id: userId,
        until_date: untilDate,
      });

      await callTelegram(env, "sendMessage", {
        chat_id: chatId,
        text: `因发送包含敏感关键词「${hit}」的消息，用户已被封禁（约 ${Math.round(
          baseBanSeconds / 3600
        )} 小时）。`,
      });
    }
  }
}

// ---------- 新成员进群验证 ----------

async function handleNewMember(chatId: number, member: any, env: Env) {
  // 不处理机器人自己
  if (member.is_bot) return;

  const userId = member.id;
  const mentionName = member.username
    ? `@${member.username}`
    : (member.first_name || "新成员");

  // 先限制发言（需要机器人是管理员）
  await callTelegram(env, "restrictChatMember", {
    chat_id: chatId,
    user_id: userId,
    permissions: {
      can_send_messages: false,
      can_send_media_messages: false,
      can_send_polls: false,
      can_send_other_messages: false,
      can_add_web_page_previews: false,
      can_change_info: false,
      can_invite_users: false,
      can_pin_messages: false,
    },
  });

  const requiredChannel = env.REQUIRED_CHANNEL;
  const verifyTimeout = Number(env.VERIFY_TIMEOUT_SECONDS || "300");

  let text = `欢迎 ${mentionName} 加入本群！\n\n`;
  text += `为了防止机器人和广告号，请点击下方按钮完成「真人验证」。\n`;
  if (requiredChannel) {
    text += `另外，需要先关注指定频道 ${requiredChannel} 才能通过验证（该项为可选配置）。\n`;
  }
  text += `建议在 ${verifyTimeout} 秒内完成验证。`;

  await callTelegram(env, "sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "✅ 我是真人，点击验证",
            callback_data: `verify:${chatId}:${userId}`,
          },
        ],
      ],
    },
  });
}

// ---------- 验证按钮回调 ----------

async function handleCallbackQuery(callback: any, env: Env) {
  const data: string = callback.data;
  const from = callback.from;
  const fromId = from.id;
  const callbackId = callback.id;

  if (!data || !data.startsWith("verify:")) {
    await callTelegram(env, "answerCallbackQuery", {
      callback_query_id: callbackId,
      text: "未知操作。",
      show_alert: false,
    });
    return;
  }

  const parts = data.split(":");
  if (parts.length < 3) return;

  const chatId = Number(parts[1]);
  const targetUserId = Number(parts[2]);

  // 只能本人点击验证
  if (fromId !== targetUserId) {
    await callTelegram(env, "answerCallbackQuery", {
      callback_query_id: callbackId,
      text: "只能本人点击该验证按钮。",
      show_alert: true,
    });
    return;
  }

  // 如果要求关注频道，检查是否已关注
  if (env.REQUIRED_CHANNEL) {
    const res = await callTelegram(env, "getChatMember", {
      chat_id: env.REQUIRED_CHANNEL,
      user_id: fromId,
    });

    const status = res?.result?.status;
    const okStatuses = ["member", "administrator", "creator"];

    if (!okStatuses.includes(status)) {
      await callTelegram(env, "answerCallbackQuery", {
        callback_query_id: callbackId,
        text: `请先关注频道 ${env.REQUIRED_CHANNEL} 再点击验证。`,
        show_alert: true,
      });
      return;
    }
  }

  // 解除限制（恢复发言）
  await callTelegram(env, "restrictChatMember", {
    chat_id: chatId,
    user_id: targetUserId,
    permissions: {
      can_send_messages: true,
      can_send_media_messages: true,
      can_send_polls: true,
      can_send_other_messages: true,
      can_add_web_page_previews: true,
      can_change_info: false,
      can_invite_users: true,
      can_pin_messages: false,
    },
  });

  await callTelegram(env, "answerCallbackQuery", {
    callback_query_id: callbackId,
    text: "验证成功，欢迎加入聊天！",
    show_alert: false,
  });

  await callTelegram(env, "sendMessage", {
    chat_id: chatId,
    text: `✅ 用户已通过验证，欢迎~`,
  });
}

// ---------- /ban：禁言（不踢出群） ----------
// 用法：
//   回复某人的消息 + /ban         -> 永久禁言（所有发送权限关闭）
//   回复某人的消息 + /ban 60      -> 禁言 60 分钟

async function handleBanCommand(message: any, env: Env) {
  const chatId = message.chat.id;
  const fromId = message.from?.id;
  const text: string = message.text || "";

  if (!(await isAdmin(env, chatId, fromId))) {
    await callTelegram(env, "sendMessage", {
      chat_id: chatId,
      text: "你没有权限使用 /ban 命令。",
      reply_to_message_id: message.message_id,
    });
    return;
  }

  const reply = message.reply_to_message;
  if (!reply || !reply.from) {
    await callTelegram(env, "sendMessage", {
      chat_id: chatId,
      text: "请通过「回复目标用户的消息」的方式使用 /ban，例如：\n" +
            "回复某条消息后发送 `/ban` 表示永久禁言；\n" +
            "回复某条消息后发送 `/ban 60` 表示禁言 60 分钟。",
      reply_to_message_id: message.message_id,
      parse_mode: "Markdown",
    });
    return;
  }

  const targetUserId = reply.from.id;
  const parts = text.split(" ").filter((s) => s.length > 0);
  const minutes = parseBanDurationMinutes(parts[1]); // 可能为 null（永久）

  let untilDate: number | undefined = undefined;
  let msg = "";

  if (minutes && minutes > 0) {
    untilDate = Math.floor(Date.now() / 1000) + minutes * 60;
    msg = `已禁言该用户 ${minutes} 分钟（禁止发送消息）。`;
  } else {
    msg = "已永久禁言该用户（禁止发送消息）。";
  }

  await callTelegram(env, "restrictChatMember", {
    chat_id: chatId,
    user_id: targetUserId,
    until_date: untilDate, // 若 undefined，则为无限期
    permissions: {
      can_send_messages: false,
      can_send_media_messages: false,
      can_send_polls: false,
      can_send_other_messages: false,
      can_add_web_page_previews: false,
      can_change_info: false,
      can_invite_users: false,
      can_pin_messages: false,
    },
  });

  await callTelegram(env, "sendMessage", {
    chat_id: chatId,
    text: msg,
    reply_to_message_id: message.message_id,
  });
}

// ---------- /banl：踢出群（kick） ----------
// 用法：回复某人的消息 + /banl

async function handleBanKickCommand(message: any, env: Env) {
  const chatId = message.chat.id;
  const fromId = message.from?.id;

  if (!(await isAdmin(env, chatId, fromId))) {
    await callTelegram(env, "sendMessage", {
      chat_id: chatId,
      text: "你没有权限使用 /banl 命令。",
      reply_to_message_id: message.message_id,
    });
    return;
  }

  const reply = message.reply_to_message;
  if (!reply || !reply.from) {
    await callTelegram(env, "sendMessage", {
      chat_id: chatId,
      text: "请通过「回复目标用户的消息」的方式使用 /banl。",
      reply_to_message_id: message.message_id,
    });
    return;
  }

  const targetUserId = reply.from.id;

  // Telegram 常见做法：先 ban 再马上 unban，让对方被踢出群但未来可以再次加入
  await callTelegram(env, "banChatMember", {
    chat_id: chatId,
    user_id: targetUserId,
  });

  await callTelegram(env, "unbanChatMember", {
    chat_id: chatId,
    user_id: targetUserId,
    only_if_banned: true,
  });

  await callTelegram(env, "sendMessage", {
    chat_id: chatId,
    text: "已将该用户移出群组（kick）。",
    reply_to_message_id: message.message_id,
  });
}

// ---------- /unban：解除封禁 / 解除禁言 ----------
// 用法：回复某人的消息 + /unban

async function handleUnbanCommand(message: any, env: Env) {
  const chatId = message.chat.id;
  const fromId = message.from?.id;

  if (!(await isAdmin(env, chatId, fromId))) {
    await callTelegram(env, "sendMessage", {
      chat_id: chatId,
      text: "你没有权限使用 /unban 命令。",
      reply_to_message_id: message.message_id,
    });
    return;
  }

  const reply = message.reply_to_message;
  if (!reply || !reply.from) {
    await callTelegram(env, "sendMessage", {
      chat_id: chatId,
      text: "请通过「回复目标用户的消息」的方式使用 /unban。",
      reply_to_message_id: message.message_id,
    });
    return;
  }

  const targetUserId = reply.from.id;

  // 1）解除禁言：恢复发送权限
  await callTelegram(env, "restrictChatMember", {
    chat_id: chatId,
    user_id: targetUserId,
    permissions: {
      can_send_messages: true,
      can_send_media_messages: true,
      can_send_polls: true,
      can_send_other_messages: true,
      can_add_web_page_previews: true,
      can_change_info: false,
      can_invite_users: true,
      can_pin_messages: false,
    },
  });

  // 2）解除封禁（如果曾被 banChatMember）
  await callTelegram(env, "unbanChatMember", {
    chat_id: chatId,
    user_id: targetUserId,
    only_if_banned: true,
  });

  await callTelegram(env, "sendMessage", {
    chat_id: chatId,
    text: "已解除该用户禁言 / 封禁。",
    reply_to_message_id: message.message_id,
  });
}
