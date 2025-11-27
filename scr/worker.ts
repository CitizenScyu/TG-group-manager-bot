export interface Env {
  BOT_TOKEN: string;
  REQUIRED_CHANNEL?: string;       // 必须关注的频道，例如 @yourchannel
  VERIFY_TIMEOUT_SECONDS?: string; // 暂时没严格用到，可扩展超时逻辑
  BAN_DURATION_SECONDS?: string;   // 关键词触发自动封禁时长，默认 86400 秒（1 天）
  ADMIN_IDS?: string;              // 允许使用管理命令的管理员 ID，逗号分隔，例如 "123456,7890123"
  BANNED_KEYWORDS?: string;        // 关键词列表，逗号分隔，例如 "广告,推广,色情"
}

type TelegramUpdate = {
  update_id: number;
  message?: any;
  callback_query?: any;
};

const TELEGRAM_API_BASE = "https://api.telegram.org";

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

function getBannedKeywords(env: Env): string[] {
  if (!env.BANNED_KEYWORDS) return [];
  return env.BANNED_KEYWORDS
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function isAdmin(env: Env, userId?: number): boolean {
  if (!userId) return false;
  if (!env.ADMIN_IDS) return false;
  const ids = env.ADMIN_IDS.split(",").map((s) => s.trim());
  return ids.includes(String(userId));
}

function parseBanDurationMinutes(text?: string): number {
  if (!text) return 60; // 默认 60 分钟
  const n = Number(text);
  if (Number.isNaN(n) || n <= 0) return 60;
  return n;
}

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

  // 管理命令（/ban, /unban）
  if (text.startsWith("/ban")) {
    await handleBanCommand(message, env);
    return;
  }
  if (text.startsWith("/unban")) {
    await handleUnbanCommand(message, env);
    return;
  }

  // 关键词检测
  const banned = getBannedKeywords(env);
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

      // 计算封禁时间
      const baseBanSeconds = Number(env.BAN_DURATION_SECONDS || "86400"); // 默认 1 天
      const untilDate = Math.floor(Date.now() / 1000) + baseBanSeconds;

      await callTelegram(env, "banChatMember", {
        chat_id: chatId,
        user_id: userId,
        until_date: untilDate,
      });

      await callTelegram(env, "sendMessage", {
        chat_id: chatId,
        text: `因发送包含敏感关键词「${hit}」的消息，用户已被封禁。`,
        reply_to_message_id: message.message_id,
      });
    }
  }
}

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
    text += `另外，需要先关注指定频道 ${requiredChannel} 才能通过验证。\n`;
  }
  text += `（建议在 ${verifyTimeout} 秒内完成）`;

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

async function handleCallbackQuery(callback: any, env: Env) {
  const data: string = callback.data;
  const from = callback.from;
  const fromId = from.id;
  const callbackId = callback.id;

  if (!data || !data.startsWith("verify:")) {
    // 其他类型回调，可按需扩展
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

  // 解除限制
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

async function handleBanCommand(message: any, env: Env) {
  const chatId = message.chat.id;
  const fromId = message.from?.id;
  const text: string = message.text || "";

  if (!isAdmin(env, fromId)) {
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
      text: "请通过「回复目标用户的消息」的方式使用 /ban，例如：\n回复某条消息后发送 `/ban 60` 表示封禁 60 分钟。",
      reply_to_message_id: message.message_id,
      parse_mode: "Markdown",
    });
    return;
  }

  const targetUserId = reply.from.id;
  const parts = text.split(" ").filter((s) => s.length > 0);
  const minutes = parseBanDurationMinutes(parts[1]);
  const untilDate = Math.floor(Date.now() / 1000) + minutes * 60;

  await callTelegram(env, "banChatMember", {
    chat_id: chatId,
    user_id: targetUserId,
    until_date: untilDate,
  });

  await callTelegram(env, "sendMessage", {
    chat_id: chatId,
    text: `已封禁该用户 ${minutes} 分钟。`,
    reply_to_message_id: message.message_id,
  });
}

async function handleUnbanCommand(message: any, env: Env) {
  const chatId = message.chat.id;
  const fromId = message.from?.id;

  if (!isAdmin(env, fromId)) {
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

  await callTelegram(env, "unbanChatMember", {
    chat_id: chatId,
    user_id: targetUserId,
    only_if_banned: true,
  });

  await callTelegram(env, "sendMessage", {
    chat_id: chatId,
    text: `已解除该用户封禁。`,
    reply_to_message_id: message.message_id,
  });
}
