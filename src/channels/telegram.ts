import https from 'https';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Api, Bot, InputFile } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { registerChannelAdapter } from './channel-registry.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';

const execAsync = promisify(exec);

// Track which chats last sent a voice message (for voice replies)
const pendingVoiceReply = new Map<string, boolean>();

const VENV_PYTHON = '/home/ryan/nanoclaw/venv/bin/python3';

async function transcribeVoice(audioPath: string): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(
      `${VENV_PYTHON} /home/ryan/nanoclaw/scripts/transcribe.py "${audioPath}"`,
      { timeout: 60000 },
    );
    const transcript = stdout.trim();
    if (!transcript) {
      log.warn('[Voice] Empty transcript', { stderr });
      return '';
    }
    return transcript;
  } catch (err) {
    log.error('[Voice] Transcription failed', { err });
    return '';
  }
}

async function synthesizeVoice(text: string, outputPath: string): Promise<boolean> {
  try {
    const ttsText = text.length > 500 ? text.substring(0, 497) + '...' : text;
    await execAsync(`${VENV_PYTHON} /home/ryan/nanoclaw/scripts/tts.py "${outputPath}" ${JSON.stringify(ttsText)}`, {
      timeout: 60000,
    });
    return true;
  } catch (err) {
    log.error('[Voice] TTS failed', { err });
    return false;
  }
}

function extractText(message: OutboundMessage): string | null {
  const content = message.content as Record<string, unknown> | string | undefined;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }
  return null;
}

async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, { ...options, parse_mode: 'Markdown' });
  } catch (err) {
    log.debug('Markdown send failed, falling back to plain text', { err });
    await api.sendMessage(chatId, text, options);
  }
}

function createAdapter(): ChannelAdapter {
  let bot: Bot | null = null;
  let botToken = '';

  const adapter: ChannelAdapter = {
    name: 'telegram',
    channelType: 'telegram',
    supportsThreads: true,

    async setup(config: ChannelSetup): Promise<void> {
      const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
      botToken = process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
      if (!botToken) throw new Error('Telegram: TELEGRAM_BOT_TOKEN not set');

      bot = new Bot(botToken, {
        client: { baseFetchConfig: { agent: https.globalAgent, compress: true } },
      });

      bot.command('chatid', (ctx) => {
        const chatId = ctx.chat.id;
        const chatType = ctx.chat.type;
        const chatName =
          chatType === 'private' ? ctx.from?.first_name || 'Private' : (ctx.chat as any).title || 'Unknown';
        ctx.reply(`Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`, {
          parse_mode: 'Markdown',
        });
      });

      bot.command('ping', (ctx) => {
        ctx.reply(`${ASSISTANT_NAME} is online.`);
      });

      const TELEGRAM_BOT_COMMANDS = new Set(['chatid', 'ping']);

      bot.on('message:text', async (ctx) => {
        if (ctx.message.text.startsWith('/')) {
          const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
          if (TELEGRAM_BOT_COMMANDS.has(cmd)) return;
        }

        const platformId = String(ctx.chat.id);
        let text = ctx.message.text;
        const timestamp = new Date(ctx.message.date * 1000).toISOString();
        const senderName = ctx.from?.first_name || ctx.from?.username || ctx.from?.id.toString() || 'Unknown';
        const senderId = ctx.from?.id.toString() || '';
        const msgId = ctx.message.message_id.toString();
        const threadId = ctx.message.message_thread_id?.toString() ?? null;

        const chatName = ctx.chat.type === 'private' ? senderName : (ctx.chat as any).title || platformId;
        const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';

        // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
        const botUsername = ctx.me?.username?.toLowerCase();
        let isMention = false;
        if (botUsername) {
          const entities = ctx.message.entities || [];
          const mentioned = entities.some((entity) => {
            if (entity.type === 'mention') {
              const mentionText = text.substring(entity.offset, entity.offset + entity.length).toLowerCase();
              return mentionText === `@${botUsername}`;
            }
            return false;
          });
          if (mentioned) {
            isMention = true;
            if (!TRIGGER_PATTERN.test(text)) {
              text = `@${ASSISTANT_NAME} ${text}`;
            }
          }
        }

        config.onMetadata(platformId, chatName, isGroup);

        await config.onInbound(platformId, threadId, {
          id: msgId,
          kind: 'chat',
          timestamp,
          content: { text, sender: senderName, senderId },
          isMention,
          isGroup,
        });

        log.info('Telegram message received', { platformId, chatName, sender: senderName });
      });

      const storeNonText = async (ctx: any, placeholder: string) => {
        const platformId = String(ctx.chat.id);
        const timestamp = new Date(ctx.message.date * 1000).toISOString();
        const senderName = ctx.from?.first_name || ctx.from?.username || ctx.from?.id?.toString() || 'Unknown';
        const senderId = ctx.from?.id?.toString() || '';
        const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
        const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';

        config.onMetadata(platformId, undefined, isGroup);
        await config.onInbound(platformId, null, {
          id: ctx.message.message_id.toString(),
          kind: 'chat',
          timestamp,
          content: { text: `${placeholder}${caption}`, sender: senderName, senderId },
          isGroup,
        });
      };

      bot.on('message:photo', (ctx) => storeNonText(ctx, '[Photo]'));
      bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
      bot.on('message:voice', async (ctx) => {
        const platformId = String(ctx.chat.id);
        const timestamp = new Date(ctx.message.date * 1000).toISOString();
        const senderName = ctx.from?.first_name || ctx.from?.username || ctx.from?.id?.toString() || 'Unknown';
        const senderId = ctx.from?.id?.toString() || '';
        const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';

        config.onMetadata(platformId, undefined, isGroup);

        try {
          const fileInfo = await ctx.api.getFile(ctx.message.voice.file_id);
          const fileUrl = `https://api.telegram.org/file/bot${botToken}/${fileInfo.file_path}`;

          const tmpPath = path.join(os.tmpdir(), `voice_in_${Date.now()}.ogg`);
          const response = await fetch(fileUrl);
          const buffer = await response.arrayBuffer();
          fs.writeFileSync(tmpPath, Buffer.from(buffer));

          log.info('[Voice] Transcribing voice message...', { platformId });
          const transcript = await transcribeVoice(tmpPath);
          try {
            fs.unlinkSync(tmpPath);
          } catch {}

          if (transcript) {
            log.info('[Voice] Transcript ready', { platformId, transcript });
            pendingVoiceReply.set(platformId, true);
            await config.onInbound(platformId, null, {
              id: ctx.message.message_id.toString(),
              kind: 'chat',
              timestamp,
              content: { text: transcript, sender: senderName, senderId },
              isGroup,
            });
          } else {
            await storeNonText(ctx, '[Voice message - transcription failed]');
          }
        } catch (err) {
          log.error('[Voice] Error processing voice message', { err, platformId });
          await storeNonText(ctx, '[Voice message]');
        }
      });
      bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
      bot.on('message:document', (ctx) => {
        const name = ctx.message.document?.file_name || 'file';
        storeNonText(ctx, `[Document: ${name}]`);
      });
      bot.on('message:sticker', (ctx) => {
        const emoji = ctx.message.sticker?.emoji || '';
        storeNonText(ctx, `[Sticker ${emoji}]`);
      });
      bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
      bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

      bot.catch((err) => {
        log.error('Telegram bot error', { err: err.message });
      });

      await new Promise<void>((resolve) => {
        bot!.start({
          onStart: (botInfo) => {
            log.info('Telegram bot connected', { username: botInfo.username, id: botInfo.id });
            console.log(`\n  Telegram bot: @${botInfo.username}`);
            console.log(`  Send /chatid to the bot to get a chat's registration ID\n`);
            resolve();
          },
        });
      });
    },

    async teardown(): Promise<void> {
      if (bot) {
        bot.stop();
        bot = null;
        log.info('Telegram bot stopped');
      }
    },

    isConnected(): boolean {
      return bot !== null;
    },

    async deliver(platformId: string, threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      if (!bot) {
        log.warn('Telegram bot not initialized');
        return undefined;
      }

      const text = extractText(message);
      if (text === null) return undefined;

      try {
        const options = threadId ? { message_thread_id: parseInt(threadId, 10) } : {};

        const MAX_LENGTH = 4096;
        if (text.length <= MAX_LENGTH) {
          await sendTelegramMessage(bot.api, platformId, text, options);
        } else {
          for (let i = 0; i < text.length; i += MAX_LENGTH) {
            await sendTelegramMessage(bot.api, platformId, text.slice(i, i + MAX_LENGTH), options);
          }
        }
        log.info('Telegram message sent', { platformId, length: text.length, threadId });

        // After sending text, also send voice if this chat triggered with a voice message
        if (pendingVoiceReply.get(platformId)) {
          pendingVoiceReply.delete(platformId);
          const tmpOgg = path.join(os.tmpdir(), `tts_${Date.now()}.ogg`);
          const ok = await synthesizeVoice(text, tmpOgg);
          if (ok && fs.existsSync(tmpOgg)) {
            try {
              await bot.api.sendVoice(platformId, new InputFile(tmpOgg));
              log.info('[Voice] Voice reply sent', { platformId });
            } catch (ttsErr) {
              log.error('[Voice] Failed to send voice reply', { ttsErr, platformId });
            } finally {
              try {
                fs.unlinkSync(tmpOgg);
              } catch {}
            }
          }
        }
      } catch (err) {
        log.error('Failed to send Telegram message', { platformId, err });
      }

      return undefined;
    },

    async setTyping(platformId: string, _threadId: string | null): Promise<void> {
      if (!bot) return;
      try {
        await bot.api.sendChatAction(platformId, 'typing');
      } catch (err) {
        log.debug('Failed to send Telegram typing indicator', { platformId, err });
      }
    },
  };

  return adapter;
}

registerChannelAdapter('telegram', {
  factory: () => {
    const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
    const token = process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
    if (!token) {
      log.warn('Telegram: TELEGRAM_BOT_TOKEN not set, skipping channel');
      return null;
    }
    return createAdapter();
  },
});
