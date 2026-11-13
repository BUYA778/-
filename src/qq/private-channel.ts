export interface IncomingOneBotPrivateEvent {
  post_type: string;
  message_type?: string;
  user_id?: number | string;
  self_id?: number | string;
  message_id?: number | string;
  raw_message?: string;
  time?: number;
}

export interface PlannedReply {
  messages: string[];
  stickers: string[];
  voices: string[];
  qzonePosts: string[];
}

const HOST_NOISE_LINE_RE = /^\s*(?:Time sampled|Browser time zone|Elapsed since|Elapsed from)\b/;
const HOST_FRAGMENT_RE = /[ \t]*text">m\d{5}\b|[ \t]*\bm\d{5}[ \t]*$/gm;
const TOOL_DSML_MARKUP_RE = /<\/?[|｜]+\s*DSML\s*[|｜]+[\s\S]*$/;
const INLINE_TAG_RE = /\[\[(sticker|voice|qzone):([^[\]]+)\]\]/g;

/**
 * 1v1 主人入口硬过滤：
 * 只要不是绑定 ownerQQ 的私聊消息（包括任何群聊、其他好友、陌生人），第一行直接丢弃。
 */
export function acceptOwnerPrivateMessage(event: IncomingOneBotPrivateEvent, ownerQQ: string): {
  accepted: boolean;
  reason: string;
  text?: string;
} {
  if (!ownerQQ) return { accepted: false, reason: '未配置 ownerQQ，拒绝处理消息' };
  if (event.post_type !== 'message') return { accepted: false, reason: '非消息事件' };
  if (event.message_type !== 'private') return { accepted: false, reason: '已禁用群聊，非私聊消息直接丢弃' };
  if (String(event.user_id ?? '') !== String(ownerQQ)) {
    return { accepted: false, reason: '非主人 QQ 号发来消息，按 1v1 规则直接丢弃' };
  }
  const text = String(event.raw_message ?? '').trim();
  if (!text) return { accepted: false, reason: '空消息' };
  return { accepted: true, reason: '通过主人 1v1 私聊验证', text };
}

/**
 * 剥离模型输出中可能泄露的 DeepSeek 工具标签（<｜DSML｜...>）、时间样本头和内部传输序号。
 */
export function stripHostNoise(raw: string): string {
  const noMarkup = String(raw ?? '')
    .replace(/\r\n/g, '\n')
    .replace(TOOL_DSML_MARKUP_RE, '')
    .replace(HOST_FRAGMENT_RE, '');

  const lines = noMarkup.split('\n').filter((line) => !HOST_NOISE_LINE_RE.test(line));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 省 Token 单轮直出解析器：
 * 模型无需额外调用发送工具，直接用空行分段、内联 [[sticker:xx]] / [[voice:xx]] / [[qzone:xx]] 表达，
 * 由桥接代码拆分为真人节奏的多条发送任务。
 */
export function planSingleTurnReply(rawModelText: string): PlannedReply {
  const cleaned = stripHostNoise(rawModelText);
  const stickers: string[] = [];
  const voices: string[] = [];
  const qzonePosts: string[] = [];

  const textWithoutTags = cleaned.replace(INLINE_TAG_RE, (_all, kind: string, payload: string) => {
    const val = payload.trim();
    if (!val) return '';
    if (kind === 'sticker') stickers.push(val);
    else if (kind === 'voice') voices.push(val);
    else if (kind === 'qzone') qzonePosts.push(val);
    return '';
  });

  const messages = textWithoutTags
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .slice(0, 6);

  return { messages, stickers, voices, qzonePosts };
}
