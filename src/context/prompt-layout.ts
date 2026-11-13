export interface ChatMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  content: string;
}

export interface PrefixLayoutInput {
  toolDescriptions: string;
  personaFirstPerson: string;
  selfNoteRendered: string;
  narrativeCardRendered: string;
  moodSnapshot: string;
  localTimeBlock: string;
}

export interface AssembledPrompt {
  staticPrefix: string;
  semiStaticMiddle: string;
  dynamicTail: string;
  fullSystemContext: string;
  estimatedTokens: number;
}

export function estimateTokensRough(text: string): number {
  const s = String(text ?? '');
  let cjk = 0;
  for (const ch of s) {
    if (ch.charCodeAt(0) > 0x2e80) cjk += 1;
  }
  const nonCjk = s.length - cjk;
  return Math.ceil(cjk * 1.3 + nonCjk * 0.35);
}

/**
 * 省 Token 核心布局：「前静后动」
 * 1. staticPrefix：只放工具说明与静态人设（只要人不换，永远命中 1 折 Prefix Cache）
 * 2. semiStaticMiddle：放低频变动的我是谁与叙事记忆卡（按周期而非每句刷新）
 * 3. dynamicTail：放实时心情与时间块，防止时间戳破坏整条前置缓存
 */
export function assembleCacheFriendlyPrompt(input: PrefixLayoutInput): AssembledPrompt {
  const staticPrefix = [input.toolDescriptions.trim(), input.personaFirstPerson.trim()]
    .filter(Boolean)
    .join('\n\n');

  const semiStaticMiddle = [input.selfNoteRendered.trim(), input.narrativeCardRendered.trim()]
    .filter(Boolean)
    .join('\n\n');

  const dynamicTail = [input.moodSnapshot.trim(), input.localTimeBlock.trim()]
    .filter(Boolean)
    .join('\n\n');

  const fullSystemContext = [staticPrefix, semiStaticMiddle, dynamicTail].filter(Boolean).join('\n\n');
  return {
    staticPrefix,
    semiStaticMiddle,
    dynamicTail,
    fullSystemContext,
    estimatedTokens: estimateTokensRough(fullSystemContext),
  };
}

/**
 * 借鉴 dsh-world 的无工具残留对话压缩：
 * 触发压缩时剥离所有 tool 消息，只保留用户和助理正文用于生成摘要，避免工具杂音浪费摘要预算。
 */
export function stripToolTurnsForCompaction(messages: readonly ChatMessage[]): ChatMessage[] {
  const kept: ChatMessage[] = [];
  for (const msg of messages) {
    if (msg.role === 'tool') continue;
    if (msg.role === 'system' || msg.role === 'developer') {
      const prev = [...kept].reverse().find((m) => m.role === 'user' || m.role === 'assistant');
      if (prev?.role === 'user') kept.push(msg);
      continue;
    }
    const text = msg.content.trim();
    if (!text) continue;
    const prev = kept.at(-1);
    if (msg.role === 'assistant' && prev?.role === 'assistant') {
      prev.content = `${prev.content}\n${text}`;
    } else {
      kept.push({ role: msg.role, content: text });
    }
  }
  return kept;
}

export function isOffPeakHour(now: Date, startHHMM = '01:00', endHHMM = '07:00'): boolean {
  const parse = (s: string) => {
    const [h, m] = s.split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const mins = now.getHours() * 60 + now.getMinutes();
  const s = parse(startHHMM);
  const e = parse(endHHMM);
  return s <= e ? mins >= s && mins < e : mins >= s || mins < e;
}

export interface TokenCostComparison {
  originalSurfcoreDailyTokens: number;
  mianmianDailyTokens: number;
  savedPercent: number;
  originalEstimatedDailyCny: number;
  mianmianEstimatedDailyCny: number;
}

export function estimateDailyTokenSavings(params: {
  dailyMessages: number;
  avgTurnsPerWakeOriginal: number;
  originalContextTokens: number;
  mianmianContextTokens: number;
  cacheHitRatio: number;
  reasoningEffort?: 'off' | 'low' | 'medium' | 'high';
  modelCostMultiplier?: number;
}): TokenCostComparison {
  const msgs = Math.max(1, params.dailyMessages);
  const origTokens = msgs * params.avgTurnsPerWakeOriginal * params.originalContextTokens;
  const effortFactor =
    params.reasoningEffort === 'off'
      ? 1.0
      : params.reasoningEffort === 'medium'
        ? 1.28
        : params.reasoningEffort === 'high'
          ? 1.65
          : 1.08;
  // 眠眠：1 轮直出 + 可调思考强度
  const mianTokens = Math.round(msgs * 1 * params.mianmianContextTokens * effortFactor);
  const savedPercent = Math.max(0, Math.min(99, Math.round(((origTokens - mianTokens) / origTokens) * 1000) / 10));

  // DeepSeek-style blended pricing model (cached input ~0.2 CNY/1M, miss ~2 CNY/1M)
  const effectivePerMillion = (hit: number) => hit * 0.25 + (1 - hit) * 2.2;
  const costFactor = Math.max(0.4, params.modelCostMultiplier ?? 1.0);
  const origCny = Number(((origTokens / 1_000_000) * effectivePerMillion(0.88)).toFixed(3));
  const mianCny = Number(((mianTokens / 1_000_000) * effectivePerMillion(params.cacheHitRatio) * costFactor).toFixed(3));

  return {
    originalSurfcoreDailyTokens: origTokens,
    mianmianDailyTokens: mianTokens,
    savedPercent,
    originalEstimatedDailyCny: origCny,
    mianmianEstimatedDailyCny: mianCny,
  };
}
