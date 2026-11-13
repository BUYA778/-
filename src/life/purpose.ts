import type { NarrativeEntry } from '../memory/narrative-card.js';

export interface PurposeGateInput {
  enabled: boolean;
  nowMs: number;
  lastOwnerMessageMs: number;
  lastOutreachMs: number;
  sentToday: number;
  dailyMax: number;
  minIdleMinutes: number;
  quietStart: string;
  quietEnd: string;
  recentEntries: readonly NarrativeEntry[];
  budgetExhausted: boolean;
}

export interface PurposeGateDecision {
  shouldTriggerLLM: boolean;
  reason: string;
  seedTopic?: string;
}

function parseClockMinutes(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return 0;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function isQuietHours(nowMs: number, quietStart: string, quietEnd: string): boolean {
  const d = new Date(nowMs);
  const mins = d.getHours() * 60 + d.getMinutes();
  const start = parseClockMinutes(quietStart);
  const end = parseClockMinutes(quietEnd);
  if (start === end) return false;
  if (start < end) return mins >= start && mins < end;
  return mins >= start || mins < end;
}

/**
 * 省 Token 关键守门：纯本地规则先算完所有硬条件；
 * 只有 100% 满足触发条件时，才调用 1 次模型生成主动搭话，避免周期空轮询烧钱。
 */
export function evaluateLocalPurposeGate(input: PurposeGateInput): PurposeGateDecision {
  if (!input.enabled) return { shouldTriggerLLM: false, reason: '目的引擎已关闭' };
  if (input.budgetExhausted) return { shouldTriggerLLM: false, reason: '今日 Token 额度已耗尽' };
  if (input.sentToday >= input.dailyMax) return { shouldTriggerLLM: false, reason: '已达今日主动搭话上限' };
  if (isQuietHours(input.nowMs, input.quietStart, input.quietEnd)) {
    return { shouldTriggerLLM: false, reason: '当前处于夜间安静时段' };
  }

  const minIdleMs = input.minIdleMinutes * 60_000;
  if (input.nowMs - input.lastOwnerMessageMs < minIdleMs) {
    return { shouldTriggerLLM: false, reason: '主人刚聊过不久，保持安静不打扰' };
  }
  if (input.nowMs - input.lastOutreachMs < minIdleMs) {
    return { shouldTriggerLLM: false, reason: '距离上次主动搭话间隔太短' };
  }

  const candidate = [...input.recentEntries]
    .filter((e) => e.importance >= 45 || e.kind === 'promise' || e.kind === 'emotion')
    .sort((a, b) => b.importance - a.importance)[0];

  if (!candidate) {
    return { shouldTriggerLLM: false, reason: '近期记忆素材不足，不强行找话' };
  }

  return {
    shouldTriggerLLM: true,
    reason: '满足全部本地静默与素材条件，允许发起 1 次主动私聊',
    seedTopic: candidate.botReply ? `${candidate.userText} / ${candidate.botReply}` : candidate.userText,
  };
}
