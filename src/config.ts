export type ModelProviderId = 'deepseek' | 'openai' | 'gemini' | 'anthropic' | 'custom';
export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high';

export interface ReasoningOption {
  id: ReasoningEffort;
  label: string;
  shortLabel: string;
  defaultBudgetTokens: number;
  tokenMultiplier: number;
  description: string;
}

export const REASONING_EFFORT_OPTIONS: readonly ReasoningOption[] = [
  {
    id: 'off',
    label: '关闭思考',
    shortLabel: '关闭 (Off)',
    defaultBudgetTokens: 0,
    tokenMultiplier: 1.0,
    description: '零思考 Token 消耗，毫秒级直出回答，最适合高频闲聊与早晚问候。',
  },
  {
    id: 'low',
    label: '低思考 · 省 Token 推荐',
    shortLabel: '低思考 (Low)',
    defaultBudgetTokens: 1024,
    tokenMultiplier: 1.08,
    description: '仅保留约 1K 思考预算做情绪与记忆判断，兼顾灵动感与极低费用。',
  },
  {
    id: 'medium',
    label: '中等思考',
    shortLabel: '中等 (Medium)',
    defaultBudgetTokens: 4096,
    tokenMultiplier: 1.28,
    description: '约 4K 思考深度，适合回忆旧事、复杂承诺对齐和主动关怀规划。',
  },
  {
    id: 'high',
    label: '深度推理',
    shortLabel: '深度 (High)',
    defaultBudgetTokens: 12288,
    tokenMultiplier: 1.65,
    description: '开放充裕思考链，用于重大情绪安慰或睡前深度日记总结（耗费较高）。',
  },
];

export interface MianmianConfig {
  ownerQQ: string;
  timeZone: string;
  characterId: string;
  model: {
    provider: ModelProviderId;
    chatModel: string;
    maintenanceModel: string;
    followDshDefault: boolean;
    dshProfileDir: string;
    reasoningEffort: ReasoningEffort;
    thinkingBudgetTokens: number;
    temperature: number;
    autoDowngradeCasualChat: boolean;
  };
  snowluma: {
    wsUrl: string;
    httpUrl: string;
    token: string;
  };
  context: {
    maxTokensBeforeCompact: number;
    recentTurnsKeep: number;
    offPeakStart: string;
    offPeakEnd: string;
  };
  memory: {
    selfCapChars: number;
    narrativeMaxChars: number;
    minAnchorImportance: number;
    autoCompactRatio: number;
    refreshIntervalMinutes: number;
  };
  voice: {
    enabled: boolean;
    onlineEndpoint: string;
    apiKey: string;
    voiceId: string;
    maxChars: number;
    maxPerMinute: number;
  };
  purpose: {
    enabled: boolean;
    quietStart: string;
    quietEnd: string;
    minIdleMinutes: number;
    dailyMax: number;
  };
  morningGreeting: {
    enabled: boolean;
    clock: string;
  };
  budget: {
    dailyMaxCny: number;
    warnAtRatio: number;
  };
  console: {
    host: '127.0.0.1';
    port: number;
  };
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Record<string, unknown> ? DeepPartial<T[K]> : T[K];
};

export type MianmianConfigInput = DeepPartial<MianmianConfig> & {
  context?: DeepPartial<MianmianConfig['context']> & { reasoningMode?: ReasoningEffort };
};

export const DEFAULT_CONFIG: MianmianConfig = {
  ownerQQ: '',
  timeZone: 'Asia/Shanghai',
  characterId: 'mianmian',
  model: {
    provider: 'custom',
    chatModel: 'dsh:default',
    maintenanceModel: 'dsh:default',
    followDshDefault: true,
    dshProfileDir: '',
    reasoningEffort: 'low',
    thinkingBudgetTokens: 1024,
    temperature: 0.85,
    autoDowngradeCasualChat: true,
  },
  snowluma: {
    wsUrl: 'ws://127.0.0.1:3001',
    httpUrl: 'http://127.0.0.1:3000',
    token: '',
  },
  context: {
    maxTokensBeforeCompact: 48000,
    recentTurnsKeep: 24,
    offPeakStart: '01:00',
    offPeakEnd: '07:00',
  },
  memory: {
    selfCapChars: 1500,
    narrativeMaxChars: 2500,
    minAnchorImportance: 65,
    autoCompactRatio: 0.9,
    refreshIntervalMinutes: 360,
  },
  voice: {
    enabled: false,
    onlineEndpoint: '',
    apiKey: '',
    voiceId: 'mianmian-default',
    maxChars: 120,
    maxPerMinute: 2,
  },
  purpose: {
    enabled: true,
    quietStart: '23:30',
    quietEnd: '08:30',
    minIdleMinutes: 180,
    dailyMax: 3,
  },
  morningGreeting: {
    enabled: true,
    clock: '08:30',
  },
  budget: {
    dailyMaxCny: 5.0,
    warnAtRatio: 0.8,
  },
  console: {
    host: '127.0.0.1',
    port: 3210,
  },
};

function clamp(n: unknown, fallback: number, min: number, max: number): number {
  const num = Number(n);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function normalizeProvider(v: unknown): ModelProviderId {
  if (v === 'deepseek' || v === 'openai' || v === 'gemini' || v === 'anthropic' || v === 'custom') {
    return v;
  }
  return 'custom';
}

function normalizeReasoningEffort(v: unknown, legacy?: unknown): ReasoningEffort {
  if (v === 'off' || v === 'low' || v === 'medium' || v === 'high') return v;
  if (legacy === 'off' || legacy === 'low' || legacy === 'medium' || legacy === 'high') return legacy;
  return 'low';
}

export function defaultBudgetForEffort(effort: ReasoningEffort): number {
  return REASONING_EFFORT_OPTIONS.find((o) => o.id === effort)?.defaultBudgetTokens ?? 1024;
}

export function normalizeConfig(raw: MianmianConfigInput = {}): MianmianConfig {
  const effort = normalizeReasoningEffort(raw.model?.reasoningEffort, raw.context?.reasoningMode);
  const defaultBudget = defaultBudgetForEffort(effort);
  const rawBudget = raw.model?.thinkingBudgetTokens;
  const thinkingBudgetTokens =
    effort === 'off'
      ? 0
      : Math.round(clamp(rawBudget ?? defaultBudget, defaultBudget, 0, 32768));

  const chatModel = String(raw.model?.chatModel || DEFAULT_CONFIG.model.chatModel).trim() || 'dsh:default';
  const maintenanceModel =
    String(raw.model?.maintenanceModel || chatModel || DEFAULT_CONFIG.model.maintenanceModel).trim() ||
    'dsh:default';

  return {
    ownerQQ: String(raw.ownerQQ ?? DEFAULT_CONFIG.ownerQQ).replace(/\D/g, ''),
    timeZone: String(raw.timeZone || DEFAULT_CONFIG.timeZone),
    characterId:
      String(raw.characterId || DEFAULT_CONFIG.characterId).replace(/[^a-zA-Z0-9_-]/g, '') || 'mianmian',
    model: {
      provider: normalizeProvider(raw.model?.provider),
      chatModel,
      maintenanceModel,
      followDshDefault: Boolean(raw.model?.followDshDefault ?? chatModel === 'dsh:default'),
      dshProfileDir: String(raw.model?.dshProfileDir ?? '').trim(),
      reasoningEffort: effort,
      thinkingBudgetTokens,
      temperature: Number(clamp(raw.model?.temperature, 0.85, 0, 1.5).toFixed(2)),
      autoDowngradeCasualChat: Boolean(raw.model?.autoDowngradeCasualChat ?? true),
    },
    snowluma: {
      wsUrl: String(raw.snowluma?.wsUrl || DEFAULT_CONFIG.snowluma.wsUrl),
      httpUrl: String(raw.snowluma?.httpUrl || DEFAULT_CONFIG.snowluma.httpUrl),
      token: String(raw.snowluma?.token ?? ''),
    },
    context: {
      maxTokensBeforeCompact: Math.round(clamp(raw.context?.maxTokensBeforeCompact, 48000, 16000, 128000)),
      recentTurnsKeep: Math.round(clamp(raw.context?.recentTurnsKeep, 24, 6, 80)),
      offPeakStart: String(raw.context?.offPeakStart || '01:00'),
      offPeakEnd: String(raw.context?.offPeakEnd || '07:00'),
    },
    memory: {
      selfCapChars: Math.round(clamp(raw.memory?.selfCapChars, 1500, 400, 5000)),
      narrativeMaxChars: Math.round(clamp(raw.memory?.narrativeMaxChars, 2500, 600, 6000)),
      minAnchorImportance: Math.round(clamp(raw.memory?.minAnchorImportance, 65, 30, 95)),
      autoCompactRatio: Number(clamp(raw.memory?.autoCompactRatio, 0.9, 0.6, 0.98).toFixed(2)),
      refreshIntervalMinutes: Math.round(clamp(raw.memory?.refreshIntervalMinutes, 360, 10, 1440)),
    },
    voice: {
      enabled: Boolean(raw.voice?.enabled ?? false),
      onlineEndpoint: String(raw.voice?.onlineEndpoint ?? ''),
      apiKey: String(raw.voice?.apiKey ?? ''),
      voiceId: String(raw.voice?.voiceId || 'mianmian-default'),
      maxChars: Math.round(clamp(raw.voice?.maxChars, 120, 20, 300)),
      maxPerMinute: Math.round(clamp(raw.voice?.maxPerMinute, 2, 1, 10)),
    },
    purpose: {
      enabled: Boolean(raw.purpose?.enabled ?? true),
      quietStart: String(raw.purpose?.quietStart || '23:30'),
      quietEnd: String(raw.purpose?.quietEnd || '08:30'),
      minIdleMinutes: Math.round(clamp(raw.purpose?.minIdleMinutes, 180, 30, 720)),
      dailyMax: Math.round(clamp(raw.purpose?.dailyMax, 3, 0, 10)),
    },
    morningGreeting: {
      enabled: Boolean(raw.morningGreeting?.enabled ?? true),
      clock: String(raw.morningGreeting?.clock || '08:30'),
    },
    budget: {
      dailyMaxCny: Number(clamp(raw.budget?.dailyMaxCny, 5.0, 0.5, 500).toFixed(2)),
      warnAtRatio: Number(clamp(raw.budget?.warnAtRatio, 0.8, 0.5, 0.95).toFixed(2)),
    },
    console: {
      host: '127.0.0.1',
      port: Math.round(clamp(raw.console?.port, 3210, 1024, 65535)),
    },
  };
}

function yamlStr(val: string): string {
  return JSON.stringify(val);
}

export function renderCordisPatchYaml(raw: MianmianConfigInput): string {
  const c = normalizeConfig(raw);
  return [
    '# DSH Profile Cordis 装配补丁（可由可视面板或 scripts/setup-dsh.ps1 生成）',
    'plugins:',
    '  mianmian:',
    '    package: dsh-plugin-mianmian',
    '    enabled: true',
    '    config:',
    '      # 唯一绑定主人 QQ 号（非该账号发来的消息在入口直接丢弃）',
    `      ownerQQ: ${yamlStr(c.ownerQQ)}`,
    `      timeZone: ${yamlStr(c.timeZone)}`,
    `      characterId: ${yamlStr(c.characterId)}`,
    '      # DSH 模型与思考强度调度（仅调用 DSH 已配模型，不保存任何 API Key）',
    '      model:',
    `        provider: ${yamlStr(c.model.provider)}`,
    `        chatModel: ${yamlStr(c.model.chatModel)}`,
    `        maintenanceModel: ${yamlStr(c.model.maintenanceModel)}`,
    `        followDshDefault: ${c.model.followDshDefault}`,
    `        dshProfileDir: ${yamlStr(c.model.dshProfileDir)}`,
    `        reasoningEffort: ${yamlStr(c.model.reasoningEffort)}`,
    `        thinkingBudgetTokens: ${c.model.thinkingBudgetTokens}`,
    `        temperature: ${c.model.temperature}`,
    `        autoDowngradeCasualChat: ${c.model.autoDowngradeCasualChat}`,
    '      # SnowLuma QQ 通道',
    '      snowluma:',
    `        wsUrl: ${yamlStr(c.snowluma.wsUrl)}`,
    `        httpUrl: ${yamlStr(c.snowluma.httpUrl)}`,
    `        token: ${yamlStr(c.snowluma.token)}`,
    '      # 省 Token 上下文压缩',
    '      context:',
    `        maxTokensBeforeCompact: ${c.context.maxTokensBeforeCompact}`,
    `        recentTurnsKeep: ${c.context.recentTurnsKeep}`,
    `        offPeakStart: ${yamlStr(c.context.offPeakStart)}`,
    `        offPeakEnd: ${yamlStr(c.context.offPeakEnd)}`,
    '      # 三层融合记忆配额',
    '      memory:',
    `        selfCapChars: ${c.memory.selfCapChars}`,
    `        narrativeMaxChars: ${c.memory.narrativeMaxChars}`,
    `        minAnchorImportance: ${c.memory.minAnchorImportance}`,
    `        autoCompactRatio: ${c.memory.autoCompactRatio}`,
    `        refreshIntervalMinutes: ${c.memory.refreshIntervalMinutes}`,
    '      # 在线语音 TTS（无本地依赖）',
    '      voice:',
    `        enabled: ${c.voice.enabled}`,
    `        onlineEndpoint: ${yamlStr(c.voice.onlineEndpoint)}`,
    `        apiKey: ${yamlStr(c.voice.apiKey)}`,
    `        voiceId: ${yamlStr(c.voice.voiceId)}`,
    `        maxChars: ${c.voice.maxChars}`,
    `        maxPerMinute: ${c.voice.maxPerMinute}`,
    '      # 1v1 主动关怀与早安',
    '      purpose:',
    `        enabled: ${c.purpose.enabled}`,
    `        quietStart: ${yamlStr(c.purpose.quietStart)}`,
    `        quietEnd: ${yamlStr(c.purpose.quietEnd)}`,
    `        minIdleMinutes: ${c.purpose.minIdleMinutes}`,
    `        dailyMax: ${c.purpose.dailyMax}`,
    '      morningGreeting:',
    `        enabled: ${c.morningGreeting.enabled}`,
    `        clock: ${yamlStr(c.morningGreeting.clock)}`,
    '      # 每日预算熔断',
    '      budget:',
    `        dailyMaxCny: ${c.budget.dailyMaxCny}`,
    `        warnAtRatio: ${c.budget.warnAtRatio}`,
    '      console:',
    '        host: "127.0.0.1"',
    `        port: ${c.console.port}`,
    '',
  ].join('\n');
}
