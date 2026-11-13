import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeConfig,
  renderCordisPatchYaml,
  type MianmianConfig,
  type MianmianConfigInput,
  type ReasoningEffort,
} from './config.js';
import { assembleCacheFriendlyPrompt, isOffPeakHour } from './context/prompt-layout.js';
import {
  discoverDshModels,
  inferSupportedEfforts,
  parseDshConfigText,
  type DshRuntimeContextLike,
} from './dsh/model-discovery.js';
import { createAlarmManager } from './life/alarm.js';
import { renderMoodSnapshot, setMoodFile } from './life/mood.js';
import { createPhotoAlbum } from './life/photos.js';
import { evaluateLocalPurposeGate } from './life/purpose.js';
import { createArchiveStore } from './memory/archive.js';
import { readDiaryEntry, writeTodayDiary } from './memory/diary.js';
import {
  applyDailyDecay,
  renderNarrativePromptBlock,
  scorePrivateInteraction,
  type NarrativeEntry,
} from './memory/narrative-card.js';
import { readSelfNote } from './memory/self-note.js';
import { readCharacterPersona, renderPersonaFirstPerson } from './persona/role-card.js';
import { acceptOwnerPrivateMessage, planSingleTurnReply } from './qq/private-channel.js';
import { createOnlineVoiceClient } from './voice/online-tts.js';

export const name = 'mianmian';

export interface BrainToolDescriptor {
  name: string;
  description: string;
  execute: (args: Record<string, unknown>) => Promise<string> | string;
}

function localDayKey(now = new Date(), timeZone = 'Asia/Shanghai'): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

export function createMianmianRuntime(
  rawConfig: MianmianConfigInput,
  dataRoot?: string,
  hostCtx?: DshRuntimeContextLike,
) {
  let cfg = normalizeConfig(rawConfig);
  const rootDir = dataRoot ?? join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'mianmian');
  const charDir = join(rootDir, 'characters', cfg.characterId);
  const roomDir = join(charDir, 'room');
  const diaryDir = join(charDir, 'diary');
  const narrativeFile = join(charDir, 'narrative-card.json');
  const selfFile = join(roomDir, '我是谁.md');
  const moodFile = join(roomDir, 'mood.md');

  mkdirSync(roomDir, { recursive: true });
  mkdirSync(diaryDir, { recursive: true });

  const archive = createArchiveStore(join(charDir, 'archive.sqlite'), diaryDir);
  const album = createPhotoAlbum(join(charDir, 'photos', 'album.sqlite'));
  const alarms = createAlarmManager();
  let voice = createOnlineVoiceClient(cfg.voice);

  function getConfig(): MianmianConfig {
    return structuredClone(cfg);
  }

  function updateConfig(patch: MianmianConfigInput): MianmianConfig {
    cfg = normalizeConfig({
      ...cfg,
      ...patch,
      model: { ...cfg.model, ...(patch.model ?? {}) },
      snowluma: { ...cfg.snowluma, ...(patch.snowluma ?? {}) },
      context: { ...cfg.context, ...(patch.context ?? {}) },
      memory: { ...cfg.memory, ...(patch.memory ?? {}) },
      voice: { ...cfg.voice, ...(patch.voice ?? {}) },
      purpose: { ...cfg.purpose, ...(patch.purpose ?? {}) },
      morningGreeting: { ...cfg.morningGreeting, ...(patch.morningGreeting ?? {}) },
      budget: { ...cfg.budget, ...(patch.budget ?? {}) },
    });
    voice = createOnlineVoiceClient(cfg.voice);
    return getConfig();
  }

  function discoverModels() {
    return discoverDshModels({
      profileDir: cfg.model.dshProfileDir || undefined,
      ctx: hostCtx,
    });
  }

  function resolveEffectiveChatModel(): {
    modelId: string;
    fromDshDefault: boolean;
    discoveredCount: number;
    supportedEfforts: ReasoningEffort[];
    effectiveEffort: ReasoningEffort;
  } {
    const discovered = discoverModels();
    const useDshDefault =
      (cfg.model.followDshDefault || cfg.model.chatModel === 'dsh:default') &&
      Boolean(discovered.defaultModelId);

    const modelId = useDshDefault
      ? (discovered.defaultModelId as string)
      : cfg.model.chatModel;

    const matched = discovered.models.find((m) => m.id === modelId);
    const supportedEfforts =
      matched?.supportedEfforts ??
      (modelId === 'dsh:default'
        ? (['off', 'low', 'medium', 'high'] as ReasoningEffort[])
        : inferSupportedEfforts(modelId));

    const effectiveEffort = supportedEfforts.includes(cfg.model.reasoningEffort)
      ? cfg.model.reasoningEffort
      : (supportedEfforts.includes('low') ? 'low' : supportedEfforts[0]);

    return {
      modelId,
      fromDshDefault: useDshDefault,
      discoveredCount: discovered.models.length,
      supportedEfforts,
      effectiveEffort,
    };
  }

  let lastOwnerMessageMs = Date.now();
  let lastOutreachMs = 0;
  let outreachToday = 0;
  let dailySpentCny = 0;

  function loadNarrativeEntries(): NarrativeEntry[] {
    if (!existsSync(narrativeFile)) return [];
    try {
      const parsed = JSON.parse(readFileSync(narrativeFile, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function saveNarrativeEntries(entries: readonly NarrativeEntry[]): void {
    writeFileSync(narrativeFile, JSON.stringify(entries, null, 2), 'utf8');
  }

  /** 精简版核心 6 个「大脑决策型」工具（收发/标已读全部交给程序，节省 60%+ Token） */
  const brainTools: BrainToolDescriptor[] = [
    {
      name: 'memory_find',
      description: '在长期归档（聊天原文与历史日记）中按关键词或时间翻找线索，返回最多 8 条 200 字摘录与 ref。',
      execute: (args) => {
        const hits = archive.find({
          query: typeof args.query === 'string' ? args.query : undefined,
          kind: args.kind === 'diary' || args.kind === 'conversation' ? args.kind : 'all',
          limit: typeof args.limit === 'number' ? args.limit : 8,
        });
        return JSON.stringify(hits);
      },
    },
    {
      name: 'memory_read',
      description: '读取 memory_find 返回的某条 ref 原文（支持 offset 分页，每次最多 2000 字）。',
      execute: (args) => {
        const ref = String(args.ref ?? '');
        return JSON.stringify(archive.readRef(ref, Number(args.offset) || 0, Number(args.limit) || 2000));
      },
    },
    {
      name: 'set_mood',
      description: '记录此刻心情（固定 11 词：开心/兴奋/平静/安心/烦/生气/紧张/难过/累/孤单/想念，0-10 整数 + 最多 3 行小事）。',
      execute: (args) => {
        const res = setMoodFile(moodFile, String(args.mood ?? ''));
        if (!res.ok) throw new Error(res.error);
        return '心情已记录。';
      },
    },
    {
      name: 'plan_next',
      description: '给自己定一个闹钟和便条（提供 at 或 after_minutes，以及 note），到点自动醒来找主人。',
      execute: (args) => {
        const record = alarms.planNext(
          {
            ...(typeof args.at === 'string' ? { at: args.at } : {}),
            ...(typeof args.after_minutes === 'number' ? { after_minutes: args.after_minutes } : {}),
          },
          String(args.note ?? ''),
        );
        return `已定好闹钟：${record.at}（${record.note}）`;
      },
    },
    {
      name: 'write_diary',
      description: '把今天的感想写进今天的日记（昨天及更早的日记已合上只读，不可篡改）。',
      execute: (args) => {
        const today = localDayKey(new Date(), cfg.timeZone);
        const res = writeTodayDiary(
          diaryDir,
          today,
          String(args.content ?? ''),
          typeof args.date === 'string' ? args.date : today,
        );
        if (!res.ok) throw new Error(res.error);
        return `已写入 ${today} 日记。`;
      },
    },
    {
      name: 'save_photo',
      description: '把当前对话中的图片保存到 1v1 相册，附带说明和标签。',
      execute: (args) => {
        const base64 = String(args.base64 ?? '');
        const bytes = new Uint8Array(Buffer.from(base64, 'base64'));
        const saved = album.savePhoto(
          bytes,
          String(args.description ?? ''),
          Array.isArray(args.tags) ? args.tags.map(String) : [],
        );
        return `已收藏到相册：${saved.id}`;
      },
    },
  ];

  function buildPromptContext(now = new Date()) {
    const persona = readCharacterPersona(charDir);
    const personaText = renderPersonaFirstPerson(persona, 3000);
    const selfNote = readSelfNote(selfFile, cfg.memory.selfCapChars);
    const narrative = renderNarrativePromptBlock(loadNarrativeEntries(), cfg.memory.narrativeMaxChars);
    const moodText = renderMoodSnapshot(moodFile);
    const toolText = brainTools.map((t) => `- ${t.name}: ${t.description}`).join('\n');

    return assembleCacheFriendlyPrompt({
      toolDescriptions: `# 可用工具\n${toolText}`,
      personaFirstPerson: personaText,
      selfNoteRendered: selfNote.rendered,
      narrativeCardRendered: narrative.text,
      moodSnapshot: moodText,
      localTimeBlock: `当前时间：${now.toISOString()}（${cfg.timeZone}）`,
    });
  }

  function recordTurn(userText: string, modelRawReply: string, turnId: string, now = new Date()) {
    const iso = now.toISOString();
    const planned = planSingleTurnReply(modelRawReply);
    const botPlain = planned.messages.join('\n');

    archive.appendMessage(turnId, 'user', userText, iso);
    if (botPlain) archive.appendMessage(turnId, 'assistant', botPlain, iso);

    const scored = scorePrivateInteraction(userText);
    const entries = loadNarrativeEntries();
    entries.push({
      id: `mem_${Date.now()}`,
      kind: scored.kind,
      title: userText.slice(0, 24),
      userText,
      ...(botPlain ? { botReply: botPlain } : {}),
      importance: scored.importance,
      reasons: scored.reasons,
      pinned: scored.pinned,
      clarity: 'vivid',
      createdAt: iso,
      decaySteps: 0,
    });
    saveNarrativeEntries(entries.slice(-400));
    lastOwnerMessageMs = now.getTime();
    return planned;
  }

  function runOffPeakMaintenance(now = new Date()): { ran: boolean; keptEntries: number } {
    if (!isOffPeakHour(now, cfg.context.offPeakStart, cfg.context.offPeakEnd)) {
      return { ran: false, keptEntries: loadNarrativeEntries().length };
    }
    const decayed = applyDailyDecay(loadNarrativeEntries(), cfg.memory.minAnchorImportance);
    saveNarrativeEntries(decayed);
    return { ran: true, keptEntries: decayed.length };
  }

  function startConsoleServer(): http.Server {
    const server = http.createServer((req, res) => {
      const host = req.headers.host ?? '';
      if (!host.startsWith('127.0.0.1:') && !host.startsWith('localhost:')) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '仅允许本机回环访问' }));
        return;
      }
      if (req.url === '/api/status') {
        const resolvedModel = resolveEffectiveChatModel();
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            ok: true,
            characterId: cfg.characterId,
            ownerBound: Boolean(cfg.ownerQQ),
            chatModel: resolvedModel.modelId,
            fromDshDefault: resolvedModel.fromDshDefault,
            discoveredDshModels: resolvedModel.discoveredCount,
            supportedEfforts: resolvedModel.supportedEfforts,
            reasoningEffort: resolvedModel.effectiveEffort,
            maintenanceModel: cfg.model.maintenanceModel,
            thinkingBudgetTokens: cfg.model.thinkingBudgetTokens,
            dailySpentCny,
            dailyMaxCny: cfg.budget.dailyMaxCny,
            narrativeCount: loadNarrativeEntries().length,
            todayDiaryExists: Boolean(readDiaryEntry(diaryDir, localDayKey(new Date(), cfg.timeZone))),
            nextAlarm: alarms.checkAlarm() ?? null,
          }),
        );
        return;
      }
      if ((req.url === '/api/dsh/models' && req.method === 'GET') || (req.url === '/api/dsh/refresh' && req.method === 'POST')) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, ...discoverModels(), effective: resolveEffectiveChatModel() }));
        return;
      }
      if (req.url === '/api/dsh/import' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          try {
            const parsedBody = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
              content?: string;
              fileName?: string;
            };
            const parsed = parseDshConfigText(String(parsedBody.content ?? ''), parsedBody.fileName || 'imported');
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true, ...parsed }));
          } catch (err) {
            res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : '解析失败' }));
          }
        });
        return;
      }
      if (req.url === '/api/config' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, config: getConfig(), yaml: renderCordisPatchYaml(cfg) }));
        return;
      }
      if (req.url === '/api/config' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as MianmianConfigInput;
            const next = updateConfig(parsed);
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true, config: next, yaml: renderCordisPatchYaml(next) }));
          } catch (err) {
            res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : '无效配置 JSON' }));
          }
        });
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('眠眠 2.0 控制台已运行（回环保护模式）。');
    });
    server.listen(cfg.console.port, '127.0.0.1');
    return server;
  }

  function checkPurposeOutreach(now = new Date()) {
    return evaluateLocalPurposeGate({
      enabled: cfg.purpose.enabled,
      nowMs: now.getTime(),
      lastOwnerMessageMs,
      lastOutreachMs,
      sentToday: outreachToday,
      dailyMax: cfg.purpose.dailyMax,
      minIdleMinutes: cfg.purpose.minIdleMinutes,
      quietStart: cfg.purpose.quietStart,
      quietEnd: cfg.purpose.quietEnd,
      recentEntries: loadNarrativeEntries(),
      budgetExhausted: dailySpentCny >= cfg.budget.dailyMaxCny,
    });
  }

  function dispose(): void {
    archive.close();
    album.close();
  }

  return {
    get config() {
      return cfg;
    },
    getConfig,
    updateConfig,
    discoverModels,
    resolveEffectiveChatModel,
    brainTools,
    acceptIncoming: (event: Parameters<typeof acceptOwnerPrivateMessage>[0]) =>
      acceptOwnerPrivateMessage(event, cfg.ownerQQ),
    buildPromptContext,
    recordTurn,
    runOffPeakMaintenance,
    checkPurposeOutreach,
    startConsoleServer,
    get voice() {
      return voice;
    },
    alarms,
    dispose,
  };
}

/** DSH / Cordis 插件激活入口 */
export function apply(
  ctx: DshRuntimeContextLike & {
    on?: (event: string, fn: () => void) => void;
    logger?: { info: (msg: string) => void };
  },
  rawConfig: MianmianConfigInput = {},
) {
  const runtime = createMianmianRuntime(rawConfig, undefined, ctx);
  const consoleServer = runtime.startConsoleServer();
  const resolved = runtime.resolveEffectiveChatModel();
  ctx.logger?.info(
    `[mianmian 2.0] 已启动（模型：${resolved.modelId}${resolved.fromDshDefault ? ' [继承自DSH]' : ''} · 思考强度：${resolved.effectiveEffort} · 回环 ${runtime.config.console.host}:${runtime.config.console.port}）`,
  );
  ctx.on?.('dispose', () => {
    consoleServer.close();
    runtime.dispose();
  });
  return runtime;
}
