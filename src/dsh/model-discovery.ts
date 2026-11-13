import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ModelProviderId, ReasoningEffort } from '../config.js';

export interface DiscoveredDshModel {
  id: string;
  label: string;
  provider: ModelProviderId;
  source: 'dsh-runtime' | 'dsh-cordis-yml' | 'dsh-models-json' | 'dsh-imported';
  sourceFile?: string;
  isDefault?: boolean;
  supportsReasoningToggle: boolean;
  supportedEfforts: ReasoningEffort[];
}

export interface DshDiscoveryResult {
  profileDir: string;
  scannedFiles: string[];
  defaultModelId: string | null;
  models: DiscoveredDshModel[];
}

export interface DshRuntimeContextLike {
  model?: {
    listModels?: () => unknown;
    current?: unknown;
  };
  dsh?: {
    listModels?: () => unknown;
    defaultModel?: unknown;
  };
  config?: Record<string, unknown>;
}

const SECRET_KEY_RE = /(api[_-]?key|secret|token|password|auth)/i;
const MODEL_KEY_RE = /^(?:chatModel|defaultModel|model|modelName|modelId|primaryModel)$/i;
const ALL_EFFORTS: readonly ReasoningEffort[] = ['off', 'low', 'medium', 'high'];

export function resolveDefaultDshProfileDir(): string {
  if (process.env.DSH_PROFILE_DIR) return process.env.DSH_PROFILE_DIR;
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(dshHome, 'profiles', 'default');
}

function inferProviderFromText(modelId: string, hint = ''): ModelProviderId {
  const combined = `${hint} ${modelId}`.toLowerCase();
  if (combined.includes('deepseek')) return 'deepseek';
  if (combined.includes('gemini')) return 'gemini';
  if (combined.includes('claude') || combined.includes('anthropic')) return 'anthropic';
  if (
    combined.includes('gpt') ||
    /\bo[134](?:-|$)/.test(combined) ||
    combined.includes('openai')
  ) {
    return 'openai';
  }
  return 'custom';
}

function parseExplicitEfforts(raw: unknown): ReasoningEffort[] | null {
  if (raw === false) return ['off'];
  if (Array.isArray(raw)) {
    const valid = ALL_EFFORTS.filter((e) => raw.includes(e));
    if (valid.length > 0) return valid;
  }
  if (typeof raw === 'string') {
    const parts = raw
      .split(/[\s,|/]+/)
      .map((s) => s.trim().toLowerCase())
      .filter((s): s is ReasoningEffort => (ALL_EFFORTS as readonly string[]).includes(s));
    if (parts.length > 0) return ALL_EFFORTS.filter((e) => parts.includes(e));
  }
  return null;
}

export function inferSupportedEfforts(modelId: string, meta?: Record<string, unknown>): ReasoningEffort[] {
  if (meta) {
    const explicit =
      parseExplicitEfforts(meta.supportedEfforts ?? meta.reasoningEfforts ?? meta.efforts) ??
      (meta.supportsReasoning === false || meta.reasoning === false || meta.thinking === false
        ? (['off'] as ReasoningEffort[])
        : null);
    if (explicit) return explicit;
  }

  const id = modelId.toLowerCase();

  // 纯直出非推理模型
  if (
    id.includes('4o-mini') ||
    id === 'gpt-4o' ||
    id.includes('gpt-4o-') ||
    id.includes('gpt-3.5') ||
    id.includes('gpt-4.1') ||
    id.includes('deepseek-v2') ||
    id.includes('flash-lite') ||
    id.includes('haiku')
  ) {
    return ['off'];
  }

  // 强制开启思维链的纯推理模型（不支持彻底关闭思考）
  if (
    id.includes('reasoner') ||
    id.includes('deepseek-r1') ||
    /\bo1(?:-|$)/.test(id) ||
    /\bo3(?:-|$)/.test(id) ||
    /\bo4-mini(?:-|$)/.test(id) ||
    id.includes('qwq')
  ) {
    return ['low', 'medium', 'high'];
  }

  // 可调思考强度模型及用户后续新增的任意自定义模型（默认开放完整 4 档）
  return ['off', 'low', 'medium', 'high'];
}

function makeModelRecord(params: {
  id: string;
  label?: string;
  hint?: string;
  source: DiscoveredDshModel['source'];
  sourceFile?: string;
  isDefault?: boolean;
  meta?: Record<string, unknown>;
}): DiscoveredDshModel {
  const supportedEfforts = inferSupportedEfforts(params.id, params.meta);
  return {
    id: params.id,
    label: params.label || `${params.id}（DSH 已配置）`,
    provider: inferProviderFromText(params.id, params.hint),
    source: params.source,
    ...(params.sourceFile ? { sourceFile: params.sourceFile } : {}),
    ...(params.isDefault ? { isDefault: true } : {}),
    supportsReasoningToggle: supportedEfforts.some((e) => e !== 'off'),
    supportedEfforts,
  };
}

function pushUniqueModel(map: Map<string, DiscoveredDshModel>, item: DiscoveredDshModel): void {
  const cleanId = item.id.trim().replace(/^['"]|['"]$/g, '');
  if (!cleanId || cleanId === 'dsh:default' || cleanId.length > 120 || SECRET_KEY_RE.test(cleanId)) return;
  if (cleanId.startsWith('sk-') || cleanId.startsWith('AIza')) return;

  const existing = map.get(cleanId);
  if (!existing) {
    map.set(cleanId, { ...item, id: cleanId });
    return;
  }

  map.set(cleanId, {
    ...existing,
    isDefault: Boolean(existing.isDefault || item.isDefault),
    supportedEfforts:
      item.supportedEfforts.length !== 4 ? item.supportedEfforts : existing.supportedEfforts,
    supportsReasoningToggle:
      item.supportedEfforts.length !== 4
        ? item.supportsReasoningToggle
        : existing.supportsReasoningToggle,
  });
}

const EFFORT_META_KEY_RE = /^(?:supportedEfforts|reasoningEfforts|efforts|capabilities|tags)$/i;
const MODEL_ARRAY_KEY_RE = /^(?:models|availableModels|modelList)$/i;

export function extractModelsFromJsonObject(
  data: unknown,
  source: DiscoveredDshModel['source'],
  sourceFile?: string,
): { models: DiscoveredDshModel[]; defaultModelId: string | null } {
  const map = new Map<string, DiscoveredDshModel>();
  let defaultModelId: string | null = null;

  function visit(node: unknown, hintPath: string): void {
    if (!node || typeof node === 'string') return;
    const leafKey = hintPath.split('.').pop() ?? '';
    if (EFFORT_META_KEY_RE.test(leafKey)) return;

    if (Array.isArray(node)) {
      for (const item of node) {
        if (typeof item === 'string' && MODEL_ARRAY_KEY_RE.test(leafKey)) {
          pushUniqueModel(
            map,
            makeModelRecord({ id: item, hint: hintPath, source, sourceFile }),
          );
        } else {
          visit(item, hintPath);
        }
      }
      return;
    }
    if (typeof node !== 'object') return;
    const rec = node as Record<string, unknown>;
    for (const [k, v] of Object.entries(rec)) {
      if (SECRET_KEY_RE.test(k) || EFFORT_META_KEY_RE.test(k)) continue;
      if (typeof v === 'string' && MODEL_KEY_RE.test(k)) {
        const isDef = /default|primary/i.test(k) || Boolean(rec.isDefault ?? rec.default);
        if (isDef && !defaultModelId) defaultModelId = v.trim();
        pushUniqueModel(
          map,
          makeModelRecord({
            id: v,
            label: typeof rec.label === 'string' ? rec.label : undefined,
            hint: `${hintPath}.${k}`,
            source,
            sourceFile,
            isDefault: isDef,
            meta: rec,
          }),
        );
      } else if (typeof v === 'string' && k === 'id' && hintPath.toLowerCase().includes('model')) {
        const isDef = Boolean(rec.isDefault ?? rec.default);
        if (isDef && !defaultModelId) defaultModelId = v.trim();
        pushUniqueModel(
          map,
          makeModelRecord({
            id: v,
            label: typeof rec.name === 'string' ? `${rec.name} (${v})` : undefined,
            hint: hintPath,
            source,
            sourceFile,
            isDefault: isDef,
            meta: rec,
          }),
        );
      } else {
        visit(v, `${hintPath}.${k}`);
      }
    }
  }

  visit(data, 'root');
  return { models: [...map.values()], defaultModelId };
}

export function extractModelsFromYamlText(
  yamlText: string,
  source: DiscoveredDshModel['source'],
  sourceFile?: string,
): { models: DiscoveredDshModel[]; defaultModelId: string | null } {
  const map = new Map<string, DiscoveredDshModel>();
  let defaultModelId: string | null = null;
  let currentSection = '';
  let inModelsList = false;
  let modelsIndent = 0;
  let lastListModelId: string | null = null;

  const lines = String(yamlText ?? '').split(/\r?\n/);
  for (const rawLine of lines) {
    const commentStripped = rawLine.replace(/\s+#.*$/, '');
    if (!commentStripped.trim() || commentStripped.trim().startsWith('#')) continue;
    const indent = commentStripped.search(/\S/);
    const trimmed = commentStripped.trim();

    if (inModelsList && indent <= modelsIndent && !trimmed.startsWith('-')) {
      inModelsList = false;
      lastListModelId = null;
    }

    const kv = trimmed.match(/^([a-zA-Z0-9_.-]+)\s*:\s*(.*)$/);
    if (kv) {
      const key = kv[1];
      const rawVal = kv[2].trim();
      const val = rawVal.replace(/^['"]|['"]$/g, '');
      if (SECRET_KEY_RE.test(key)) continue;

      // 行内列表，例如 models: [deepseek-chat, qwen3-32b]
      if (/^(?:models|availableModels)$/i.test(key) && rawVal.startsWith('[') && rawVal.endsWith(']')) {
        const items = rawVal
          .slice(1, -1)
          .split(',')
          .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
          .filter(Boolean);
        for (const item of items) {
          pushUniqueModel(map, makeModelRecord({ id: item, hint: currentSection, source, sourceFile }));
        }
        continue;
      }

      // 绑定到上一个列表模型对象的支持思考档位字段，如 supportedEfforts: [off, low]
      if (/^(?:supportedEfforts|reasoningEfforts|efforts)$/i.test(key) && lastListModelId) {
        const bracketClean = rawVal.replace(/^\[|\]$/g, '');
        const explicit = parseExplicitEfforts(bracketClean);
        const target = map.get(lastListModelId);
        if (explicit && target) {
          target.supportedEfforts = explicit;
          target.supportsReasoningToggle = explicit.some((e) => e !== 'off');
        }
        continue;
      }

      if (!val) {
        currentSection = key;
        if (/^(?:models|availableModels)$/i.test(key)) {
          inModelsList = true;
          modelsIndent = indent;
          lastListModelId = null;
        }
        continue;
      }

      if (MODEL_KEY_RE.test(key)) {
        const isDef = /default|primary/i.test(key);
        if (isDef && !defaultModelId) defaultModelId = val;
        pushUniqueModel(
          map,
          makeModelRecord({
            id: val,
            hint: currentSection,
            source,
            sourceFile,
            isDefault: isDef,
          }),
        );
      }
      continue;
    }

    if (inModelsList && trimmed.startsWith('-')) {
      const itemText = trimmed.slice(1).trim();
      const idMatch = itemText.match(/^(?:id|model|name)\s*:\s*(.+)$/);
      const modelId = (idMatch ? idMatch[1] : itemText).trim().replace(/^['"]|['"]$/g, '');
      if (modelId && !modelId.includes(':')) {
        lastListModelId = modelId;
        pushUniqueModel(
          map,
          makeModelRecord({
            id: modelId,
            hint: currentSection,
            source,
            sourceFile,
          }),
        );
      }
    }
  }

  return { models: [...map.values()], defaultModelId };
}

export function parseDshConfigText(
  rawText: string,
  fileName = 'imported',
): {
  models: DiscoveredDshModel[];
  defaultModelId: string | null;
} {
  const trimmed = String(rawText ?? '').trim();
  if (!trimmed) return { models: [], defaultModelId: null };
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const json = JSON.parse(trimmed);
      return extractModelsFromJsonObject(json, 'dsh-imported', fileName);
    } catch {
      // fall through to YAML parser
    }
  }
  return extractModelsFromYamlText(trimmed, 'dsh-imported', fileName);
}

function collectCandidateConfigFiles(profileDir: string): string[] {
  const topNames = [
    'cordis.yml',
    'cordis.yaml',
    'models.json',
    'providers.json',
    'config.json',
    'dsh.config.json',
    'dsh.yml',
    'settings.json',
  ];
  const collected = new Set<string>();
  for (const name of topNames) {
    if (existsSync(join(profileDir, name))) collected.add(name);
  }

  // 递归扫描 DSH Profile 下的 models/providers/plugins 等配置子目录（深度 <= 2），确保后续新增模型文件也能实时识别
  const subDirs = ['models', 'providers', 'plugins', 'conf'];
  for (const sub of subDirs) {
    const subAbs = join(profileDir, sub);
    if (!existsSync(subAbs)) continue;
    try {
      for (const entry of readdirSync(subAbs, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dsh-plugin-mianmian') {
          continue;
        }
        const rel = join(sub, entry.name);
        if (entry.isFile() && /\.(?:yml|yaml|json)$/i.test(entry.name)) {
          collected.add(rel);
        } else if (entry.isDirectory()) {
          const nestedAbs = join(subAbs, entry.name);
          for (const nested of readdirSync(nestedAbs, { withFileTypes: true })) {
            if (
              nested.isFile() &&
              /\.(?:yml|yaml|json)$/i.test(nested.name) &&
              nested.name !== 'package.json' &&
              nested.name !== 'tsconfig.json' &&
              nested.name !== 'cordis.patch.yml'
            ) {
              collected.add(join(rel, nested.name));
            }
          }
        }
      }
    } catch {
      // skip unreadable directory
    }
  }

  return [...collected];
}

export function discoverDshModels(options?: {
  profileDir?: string;
  ctx?: DshRuntimeContextLike;
}): DshDiscoveryResult {
  const profileDir = options?.profileDir || resolveDefaultDshProfileDir();
  const merged = new Map<string, DiscoveredDshModel>();
  const scannedFiles: string[] = [];
  let defaultModelId: string | null = null;

  // 1. 实时检查 Cordis / DSH 运行时上下文暴露的已配模型列表（无缓存，新增模型立即可见）
  const ctx = options?.ctx;
  if (ctx) {
    try {
      const sources = [
        typeof ctx.dsh?.listModels === 'function' ? ctx.dsh.listModels() : null,
        typeof ctx.model?.listModels === 'function' ? ctx.model.listModels() : null,
        ctx.config ?? null,
      ].filter(Boolean);

      for (const src of sources) {
        const res = extractModelsFromJsonObject(src, 'dsh-runtime', 'cordis-runtime');
        for (const m of res.models) pushUniqueModel(merged, m);
        if (res.defaultModelId && !defaultModelId) defaultModelId = res.defaultModelId;
      }

      const rtDef = ctx.dsh?.defaultModel ?? ctx.model?.current;
      if (typeof rtDef === 'string' && rtDef.trim()) {
        defaultModelId = rtDef.trim();
        pushUniqueModel(
          merged,
          makeModelRecord({
            id: rtDef.trim(),
            label: `${rtDef.trim()}（DSH 运行时默认）`,
            source: 'dsh-runtime',
            isDefault: true,
          }),
        );
      }
    } catch {
      // ignore malformed runtime host hooks
    }
  }

  // 2. 无缓存扫描本地 DSH Profile 根目录与子目录下的模型/Cordis 配置文件
  if (existsSync(profileDir)) {
    const candidateFiles = collectCandidateConfigFiles(profileDir);
    for (const rel of candidateFiles) {
      const abs = join(profileDir, rel);
      scannedFiles.push(rel.replace(/\\/g, '/'));
      try {
        const content = readFileSync(abs, 'utf8');
        const isJson = rel.toLowerCase().endsWith('.json');
        const parsed = isJson
          ? extractModelsFromJsonObject(JSON.parse(content), 'dsh-models-json', rel.replace(/\\/g, '/'))
          : extractModelsFromYamlText(content, 'dsh-cordis-yml', rel.replace(/\\/g, '/'));
        for (const m of parsed.models) pushUniqueModel(merged, m);
        if (parsed.defaultModelId && !defaultModelId) defaultModelId = parsed.defaultModelId;
      } catch {
        // skip unreadable or invalid config file
      }
    }
  }

  const models = [...merged.values()];
  if (!defaultModelId && models.length > 0) {
    defaultModelId = models[0].id;
  }

  return {
    profileDir,
    scannedFiles,
    defaultModelId,
    models,
  };
}
