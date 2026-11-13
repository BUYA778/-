export type MemoryClarity = 'vivid' | 'clear' | 'fuzzy' | 'trace';
export type MemoryKind = 'first' | 'emotion' | 'promise' | 'conflict' | 'event';

export interface NarrativeEntry {
  id: string;
  kind: MemoryKind;
  title: string;
  userText: string;
  botReply?: string;
  importance: number;
  reasons: string[];
  pinned: boolean;
  clarity: MemoryClarity;
  createdAt: string;
  decaySteps: number;
}

export interface ScoreResult {
  importance: number;
  kind: MemoryKind;
  pinned: boolean;
  reasons: string[];
}

const STRONG_EMOTION_RE = /喜欢|想念|难过|委屈|哭了|抱抱|永远|心疼|害怕|崩溃|爱死|舍不得|好想你/;
const MILD_EMOTION_RE = /开心|高兴|生气|烦躁|累了|焦虑|感动|谢谢|抱歉|失眠|紧张|孤单/;
const FIRST_MILESTONE_RE = /第一次|初次|头一次|最早|纪念日|周年|刚认识/;
const PROMISE_RE = /答应|约定|说好|以后|下次|记得|不要忘|发誓|拉钩|陪你/;
const CONFLICT_RE = /吵架|道歉|对不起|和好|误会|冷战|别生气/;

export function scorePrivateInteraction(text: string): ScoreResult {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  const reasons: string[] = ['1v1 私聊基础分'];
  let score = 20;
  let kind: MemoryKind = 'event';
  let pinned = false;

  const chars = Array.from(clean);
  if (chars.length < 6) {
    score -= 12;
    reasons.push('短句信息量低');
  }

  let emotionBonus = 0;
  const strongHits = clean.match(new RegExp(STRONG_EMOTION_RE.source, 'g')) ?? [];
  const mildHits = clean.match(new RegExp(MILD_EMOTION_RE.source, 'g')) ?? [];
  const exclamations = (clean.match(/[!！]/g) ?? []).length;
  emotionBonus = Math.min(24, strongHits.length * 10 + mildHits.length * 4 + exclamations * 2);
  if (emotionBonus > 0) {
    score += emotionBonus;
    kind = 'emotion';
    reasons.push(`情绪浓度 +${emotionBonus}`);
  }

  if (PROMISE_RE.test(clean)) {
    score += 22;
    kind = 'promise';
    reasons.push('约定/承诺 +22');
  }

  if (CONFLICT_RE.test(clean)) {
    score += 18;
    kind = 'conflict';
    reasons.push('矛盾/和好 +18');
  }

  if (FIRST_MILESTONE_RE.test(clean)) {
    score = 100;
    kind = 'first';
    pinned = true;
    reasons.push('里程碑/第一次 → 置顶 100');
  }

  const finalScore = Math.max(1, Math.min(100, score));
  if (finalScore >= 85) pinned = true;

  return { importance: finalScore, kind, pinned, reasons };
}

export function clarityFromScore(importance: number, decaySteps: number, pinned: boolean): MemoryClarity {
  if (pinned || decaySteps <= 1) return 'vivid';
  const effective = importance - decaySteps * 6;
  if (effective >= 55) return 'clear';
  if (effective >= 30) return 'fuzzy';
  return 'trace';
}

export function applyDailyDecay(
  entries: readonly NarrativeEntry[],
  minAnchorImportance = 65,
  dropBelow = 15,
): NarrativeEntry[] {
  const next: NarrativeEntry[] = [];
  for (const entry of entries) {
    if (entry.pinned || entry.importance >= minAnchorImportance) {
      next.push({ ...entry, clarity: clarityFromScore(entry.importance, entry.decaySteps, true) });
      continue;
    }
    const steps = entry.decaySteps + 1;
    const effective = entry.importance - steps * 6;
    if (effective < dropBelow) continue;
    next.push({
      ...entry,
      decaySteps: steps,
      clarity: clarityFromScore(entry.importance, steps, false),
    });
  }
  return next;
}

export function renderNarrativePromptBlock(
  entries: readonly NarrativeEntry[],
  maxChars = 2500,
): { text: string; includedCount: number; droppedCount: number } {
  if (!entries.length) {
    return { text: '', includedCount: 0, droppedCount: 0 };
  }
  const sorted = [...entries].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.importance !== b.importance) return b.importance - a.importance;
    return b.createdAt.localeCompare(a.createdAt);
  });

  const lines: string[] = [];
  let usedChars = 0;
  let includedCount = 0;

  for (const item of sorted) {
    const day = item.createdAt.slice(0, 10);
    const tag = item.pinned ? '置顶' : item.clarity === 'fuzzy' ? '模糊' : '清晰';
    const pair = item.botReply
      ? `主人：${item.userText} → 我回：${item.botReply}`
      : `主人：${item.userText}`;
    const line = `- [${day} · ${tag}] ${pair}`;
    const len = Array.from(line).length + 1;
    if (usedChars + len > maxChars && includedCount > 0) break;
    lines.push(line);
    usedChars += len;
    includedCount += 1;
  }

  return {
    text: `<叙事记忆卡>\n${lines.join('\n')}\n</叙事记忆卡>`,
    includedCount,
    droppedCount: sorted.length - includedCount,
  };
}
