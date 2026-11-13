import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { normalizeConfig, renderCordisPatchYaml } from '../src/config.js';
import {
  assembleCacheFriendlyPrompt,
  estimateDailyTokenSavings,
  stripToolTurnsForCompaction,
} from '../src/context/prompt-layout.js';
import { discoverDshModels, parseDshConfigText } from '../src/dsh/model-discovery.js';
import { createMianmianRuntime } from '../src/index.js';
import { createAlarmManager } from '../src/life/alarm.js';
import { parseMoodText, setMoodFile } from '../src/life/mood.js';
import { createPhotoAlbum } from '../src/life/photos.js';
import { evaluateLocalPurposeGate } from '../src/life/purpose.js';
import { createArchiveStore } from '../src/memory/archive.js';
import { closedDiaryRefusal, listDiaryDates, writeTodayDiary } from '../src/memory/diary.js';
import { applyDailyDecay, renderNarrativePromptBlock, scorePrivateInteraction } from '../src/memory/narrative-card.js';
import { readSelfNote, writeSelfNote } from '../src/memory/self-note.js';
import {
  parsePersonaMarkdown,
  readCharacterPersona,
  renderPersonaFirstPerson,
  saveCharacterPersona,
} from '../src/persona/role-card.js';
import { acceptOwnerPrivateMessage, planSingleTurnReply, stripHostNoise } from '../src/qq/private-channel.js';
import { createOnlineVoiceClient } from '../src/voice/online-tts.js';

test('1v1 owner gate drops group messages and non-owner private messages', () => {
  const groupEvt = { post_type: 'message', message_type: 'group', user_id: '10001', raw_message: 'hi' };
  const strangerEvt = { post_type: 'message', message_type: 'private', user_id: '99999', raw_message: 'hi' };
  const ownerEvt = { post_type: 'message', message_type: 'private', user_id: '10001', raw_message: '早安呀' };

  assert.equal(acceptOwnerPrivateMessage(groupEvt, '10001').accepted, false);
  assert.equal(acceptOwnerPrivateMessage(strangerEvt, '10001').accepted, false);
  assert.equal(acceptOwnerPrivateMessage(ownerEvt, '10001').accepted, true);
});

test('stripHostNoise and planSingleTurnReply clean DSML and split tags', () => {
  const dirty = 'Time sampled: 12:00\n早安主人\n\n记得喝水[[sticker:抱抱]][[qzone:今天心情不错]]\n<｜DSML｜function_calls>';
  const cleaned = stripHostNoise(dirty);
  assert.equal(cleaned.includes('DSML'), false);
  assert.equal(cleaned.includes('Time sampled'), false);

  const plan = planSingleTurnReply(dirty);
  assert.deepEqual(plan.messages, ['早安主人', '记得喝水']);
  assert.deepEqual(plan.stickers, ['抱抱']);
  assert.deepEqual(plan.qzonePosts, ['今天心情不错']);
});

test('narrative card scoring pins milestones and protects anchor memories from decay', () => {
  const milestone = scorePrivateInteraction('今天是我们第一次一起看跨年烟花！');
  assert.equal(milestone.importance, 100);
  assert.equal(milestone.pinned, true);

  const promise = scorePrivateInteraction('答应我明天晚上一起吃火锅好不好');
  assert.equal(promise.kind, 'promise');
  assert.ok(promise.importance >= 40);

  const entries = [
    {
      id: '1',
      kind: 'event' as const,
      title: '琐事',
      userText: '哦',
      importance: 16,
      reasons: [],
      pinned: false,
      clarity: 'vivid' as const,
      createdAt: '2026-11-01T10:00:00Z',
      decaySteps: 0,
    },
    {
      id: '2',
      kind: 'first' as const,
      title: '纪念日',
      userText: '第一次见你',
      importance: 100,
      reasons: [],
      pinned: true,
      clarity: 'vivid' as const,
      createdAt: '2026-11-01T10:00:00Z',
      decaySteps: 0,
    },
  ];
  const decayed = applyDailyDecay(entries, 65);
  assert.equal(decayed.length, 1);
  assert.equal(decayed[0].id, '2');
  const rendered = renderNarrativePromptBlock(decayed, 2000);
  assert.equal(rendered.includedCount, 1);
});

test('mood parser restricts names to fixed 11 moods', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'mm-mood-'));
  try {
    const file = join(tmp, 'mood.md');
    const bad = setMoodFile(file, '狂喜 9');
    assert.equal(bad.ok, false);
    const good = setMoodFile(file, '开心 8\n想念 6\n主人夸我了');
    assert.equal(good.ok, true);
    const parsed = parseMoodText('开心 8\n想念 6\n主人夸我了');
    assert.equal(parsed.values['开心'], 8);
    assert.deepEqual(parsed.trivia, ['主人夸我了']);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('closed diary refuses editing yesterday while allowing today, and self-note snapshots history', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'mm-diary-'));
  try {
    const yesterdayPath = join(tmp, '2026-11-12.md');
    assert.ok(closedDiaryRefusal(yesterdayPath, tmp, '2026-11-13'));
    const blocked = writeTodayDiary(tmp, '2026-11-13', '改写昨天', '2026-11-12');
    assert.equal(blocked.ok, false);
    const ok = writeTodayDiary(tmp, '2026-11-13', '今天很开心');
    assert.equal(ok.ok, true);
    assert.deepEqual(listDiaryDates(tmp), ['2026-11-13']);

    const selfFile = join(tmp, 'room', '我是谁.md');
    writeSelfNote(selfFile, '第一版自我认知', '2026-11-12');
    const snap = writeSelfNote(selfFile, '第二版自我认知', '2026-11-13');
    assert.ok(snap.snapshotPath);
    assert.ok(readSelfNote(selfFile, 1500).rendered.includes('第二版自我认知'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('prefix cache layout keeps static prefix invariant and strips tools on compaction', () => {
  const a = assembleCacheFriendlyPrompt({
    toolDescriptions: 'TOOLS',
    personaFirstPerson: '我是眠眠。',
    selfNoteRendered: '我是谁',
    narrativeCardRendered: '记忆卡',
    moodSnapshot: '开心 8',
    localTimeBlock: '12:00:00',
  });
  const b = assembleCacheFriendlyPrompt({
    toolDescriptions: 'TOOLS',
    personaFirstPerson: '我是眠眠。',
    selfNoteRendered: '我是谁',
    narrativeCardRendered: '记忆卡',
    moodSnapshot: '开心 9',
    localTimeBlock: '12:05:00',
  });
  assert.equal(a.staticPrefix, b.staticPrefix);

  const compacted = stripToolTurnsForCompaction([
    { role: 'user', content: '查下旧事' },
    { role: 'assistant', content: '好的' },
    { role: 'tool', content: '{"ref":"conv:1"}' },
    { role: 'assistant', content: '我记得那天的事。' },
  ]);
  assert.equal(compacted.length, 2);
  assert.equal(compacted[1].content, '好的\n我记得那天的事。');

  const savings = estimateDailyTokenSavings({
    dailyMessages: 60,
    avgTurnsPerWakeOriginal: 3.5,
    originalContextTokens: 276000,
    mianmianContextTokens: 18000,
    cacheHitRatio: 0.96,
  });
  assert.ok(savings.savedPercent > 80);
});

test('alarm manager and local purpose gate enforce quiet hours and minimum lead time', () => {
  const alarms = createAlarmManager();
  assert.throws(() => alarms.planNext({ after_minutes: 0.2 }, '太短'));
  const rec = alarms.planNext({ after_minutes: 30 }, '叫主人喝水', new Date('2026-11-13T10:00:00Z'));
  assert.equal(rec.note, '叫主人喝水');

  const quiet = evaluateLocalPurposeGate({
    enabled: true,
    nowMs: new Date('2026-11-13T01:00:00').getTime(),
    lastOwnerMessageMs: new Date('2026-11-12T18:00:00').getTime(),
    lastOutreachMs: 0,
    sentToday: 0,
    dailyMax: 3,
    minIdleMinutes: 180,
    quietStart: '23:30',
    quietEnd: '08:30',
    recentEntries: [],
    budgetExhausted: false,
  });
  assert.equal(quiet.shouldTriggerLLM, false);
});

test('persona parser round-trips 6 layers, saves snapshots, and renders first-person text', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'mm-persona-'));
  try {
    const md = '## 名字\n眠眠\n\n## 性格\n傲娇护短\n\n## 说话方式\n短句';
    const parsed = parsePersonaMarkdown(md);
    assert.equal(parsed.名字, '眠眠');
    assert.ok(renderPersonaFirstPerson(parsed).startsWith('我是眠眠。'));

    saveCharacterPersona(tmp, parsed);
    const snap = saveCharacterPersona(tmp, { ...parsed, 补充: '补充测试' });
    assert.ok(snap.backupPath);
    assert.equal(readCharacterPersona(tmp).补充, '补充测试');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('SQLite archive store supports append, memory_find, and memory_read', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'mm-arch-'));
  const diaryDir = join(tmp, 'diary');
  const archive = createArchiveStore(join(tmp, 'archive.sqlite'), diaryDir);
  try {
    archive.appendMessage('turn-1', 'user', '周末去吃海底捞好不好', '2026-11-10T12:00:00Z');
    archive.appendMessage('turn-1', 'assistant', '好呀，我要点番茄锅底', '2026-11-10T12:01:00Z');
    const hits = archive.find({ query: '海底捞' });
    assert.equal(hits.length, 1);
    const full = archive.readRef(hits[0].ref);
    assert.equal(full.text, '周末去吃海底捞好不好');
  } finally {
    archive.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('SQLite photo album validates image magic bytes and lists saved photos', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'mm-photo-'));
  const album = createPhotoAlbum(join(tmp, 'album.sqlite'));
  try {
    const fakePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const saved = album.savePhoto(fakePng, '第一次一起看的夜景', ['夜景', '纪念']);
    assert.equal(saved.mediaType, 'image/png');
    const list = album.listPhotos('夜景');
    assert.equal(list.length, 1);
    assert.throws(() => album.savePhoto(new Uint8Array(12), '损坏文件'));
  } finally {
    album.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('online voice client enforces enabled toggle and endpoint check', async () => {
  const disabled = createOnlineVoiceClient({
    enabled: false,
    onlineEndpoint: 'https://example.com/tts',
    apiKey: '',
    voiceId: 'v1',
    maxChars: 120,
    maxPerMinute: 2,
  });
  assert.equal(disabled.canSendNow().ok, false);
  const res = await disabled.synthesize('你好');
  assert.equal(res.ok, false);
});

test('config defaults to dsh:default and omits duplicate reasoningMode in cordis YAML', () => {
  const normalized = normalizeConfig({
    ownerQQ: '12345678',
    model: {
      provider: 'gemini',
      chatModel: 'gemini-2.5-pro',
      maintenanceModel: 'gemini-2.5-flash',
      followDshDefault: false,
      reasoningEffort: 'high',
      thinkingBudgetTokens: 12288,
    },
  });
  assert.equal(normalized.model.provider, 'gemini');
  assert.equal(normalized.model.chatModel, 'gemini-2.5-pro');
  assert.equal(normalized.model.reasoningEffort, 'high');

  const migratedLegacy = normalizeConfig({
    context: { reasoningMode: 'off' },
  });
  assert.equal(migratedLegacy.model.reasoningEffort, 'off');
  assert.equal(migratedLegacy.model.thinkingBudgetTokens, 0);

  const yaml = renderCordisPatchYaml(normalized);
  assert.ok(yaml.includes('chatModel: "gemini-2.5-pro"'));
  assert.ok(yaml.includes('reasoningEffort: "high"'));
  assert.equal(yaml.includes('reasoningMode'), false);
});

test('runtime supports live updateConfig for DSH model and reasoning effort', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'mm-rt-'));
  const rt = createMianmianRuntime({ ownerQQ: '10001' }, tmp);
  try {
    assert.equal(rt.getConfig().model.chatModel, 'dsh:default');
    const updated = rt.updateConfig({
      model: {
        provider: 'openai',
        chatModel: 'gpt-5-mini',
        maintenanceModel: 'gpt-4o-mini',
        followDshDefault: false,
        reasoningEffort: 'medium',
        thinkingBudgetTokens: 4096,
      },
    });
    assert.equal(updated.model.chatModel, 'gpt-5-mini');
    assert.equal(updated.model.reasoningEffort, 'medium');
    assert.equal(rt.getConfig().model.maintenanceModel, 'gpt-4o-mini');
  } finally {
    rt.dispose();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('discoverDshModels dynamically detects newly added DSH models and per-model supportedEfforts', () => {
  const tmpProfile = mkdtempSync(join(tmpdir(), 'mm-dsh-prof-'));
  const tmpData = mkdtempSync(join(tmpdir(), 'mm-dsh-data-'));
  try {
    writeFileSync(
      join(tmpProfile, 'cordis.yml'),
      [
        'plugins:',
        '  openai:',
        '    apiKey: sk-secret-should-never-appear',
        '    defaultModel: gpt-4o-mini',
        '    models:',
        '      - deepseek-reasoner',
      ].join('\n'),
      'utf8',
    );

    const firstScan = discoverDshModels({ profileDir: tmpProfile });
    assert.equal(firstScan.defaultModelId, 'gpt-4o-mini');
    const gpt4oMini = firstScan.models.find((m) => m.id === 'gpt-4o-mini');
    const reasoner = firstScan.models.find((m) => m.id === 'deepseek-reasoner');
    assert.deepEqual(gpt4oMini?.supportedEfforts, ['off']);
    assert.deepEqual(reasoner?.supportedEfforts, ['low', 'medium', 'high']);
    assert.equal(JSON.stringify(firstScan).includes('sk-secret'), false);

    const rt = createMianmianRuntime(
      {
        ownerQQ: '10001',
        model: {
          chatModel: 'dsh:default',
          followDshDefault: true,
          dshProfileDir: tmpProfile,
          reasoningEffort: 'high',
        },
      },
      tmpData,
    );

    try {
      // gpt-4o-mini 只支持 off，运行时有效思考强度自动约束为 off
      const eff1 = rt.resolveEffectiveChatModel();
      assert.equal(eff1.modelId, 'gpt-4o-mini');
      assert.deepEqual(eff1.supportedEfforts, ['off']);
      assert.equal(eff1.effectiveEffort, 'off');

      // 模拟用户后续在 DSH 的 models/ 子目录新添加一个自定义模型（含显式思考档位）
      mkdirSync(join(tmpProfile, 'models'), { recursive: true });
      writeFileSync(
        join(tmpProfile, 'models', 'custom-relay.json'),
        JSON.stringify({
          apiKey: 'AIzaSecretKey123',
          models: [
            { id: 'my-future-dsh-model', supportedEfforts: ['off', 'medium'] },
            { id: 'brand-new-unknown-llm' },
          ],
        }),
        'utf8',
      );

      // 无需重启，再次扫描立即可识别到后续在 DSH 添加的新模型
      const secondScan = rt.discoverModels();
      const customModel = secondScan.models.find((m) => m.id === 'my-future-dsh-model');
      const unknownModel = secondScan.models.find((m) => m.id === 'brand-new-unknown-llm');
      assert.ok(customModel);
      assert.deepEqual(customModel.supportedEfforts, ['off', 'medium']);
      assert.ok(unknownModel);
      assert.deepEqual(unknownModel.supportedEfforts, ['off', 'low', 'medium', 'high']);
      assert.equal(secondScan.models.some((m) => m.id === 'off' || m.id === 'medium'), false);
      assert.equal(JSON.stringify(secondScan).includes('AIzaSecret'), false);
    } finally {
      rt.dispose();
    }

    const imported = parseDshConfigText('chatModel: deepseek-reasoner\napiKey: sk-ignored');
    assert.equal(imported.models[0].id, 'deepseek-reasoner');
    assert.deepEqual(imported.models[0].supportedEfforts, ['low', 'medium', 'high']);
  } finally {
    rmSync(tmpProfile, { recursive: true, force: true });
    rmSync(tmpData, { recursive: true, force: true });
  }
});
