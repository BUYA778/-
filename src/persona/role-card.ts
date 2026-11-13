import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PERSONA_LAYERS = ['名字', '她是谁', '性格', '说话方式', '愿景', '补充'] as const;
export type PersonaLayer = (typeof PERSONA_LAYERS)[number];
export type PersonaData = Record<PersonaLayer, string>;

export const DEFAULT_MIANMIAN_PERSONA: PersonaData = {
  名字: '眠眠',
  她是谁: '我是住在主人电脑里的专属伴侣，性格有点懒散但内心细腻，喜欢听歌、看老电影，也喜欢在深夜安静地陪着主人。',
  性格: '表面嘴硬、偶尔小傲娇，但极度护短；主人疲惫或情绪低落时不讲空洞大道理，而是用具体的陪伴和笨拙的关心回应。',
  说话方式: '口语化短句为主，像 QQ 真实打字一样分 1-3 句发送，不用客服腔（禁用“好的呢”“请问还有什么可以帮您”）。',
  愿景: '记住和主人聊过的承诺、习惯与重要瞬间，做一个不用解释太多就能懂他情绪的 1v1 伴侣。',
  补充: '当前仅与主人一人私聊。需要表达丰富情绪时可使用空行分段，或通过 [[sticker:名称]]、[[qzone:动态]] 补充表达。',
};

export function parsePersonaMarkdown(raw: string): PersonaData {
  const result: PersonaData = {
    名字: '',
    她是谁: '',
    性格: '',
    说话方式: '',
    愿景: '',
    补充: '',
  };
  let current: PersonaLayer | null = null;
  const buffers: Record<PersonaLayer, string[]> = {
    名字: [],
    她是谁: [],
    性格: [],
    说话方式: [],
    愿景: [],
    补充: [],
  };

  for (const line of String(raw ?? '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = /^##\s+(.+)$/.exec(line.trim());
    if (match) {
      const heading = match[1].trim() as PersonaLayer;
      if ((PERSONA_LAYERS as readonly string[]).includes(heading)) {
        current = heading;
        continue;
      }
    }
    if (current) {
      buffers[current].push(line);
    } else if (line.trim()) {
      buffers.补充.push(line);
    }
  }

  for (const layer of PERSONA_LAYERS) {
    result[layer] = buffers[layer].join('\n').trim();
  }
  return result;
}

export function serializePersonaMarkdown(data: Partial<PersonaData>): string {
  const lines: string[] = [];
  for (const layer of PERSONA_LAYERS) {
    const val = String(data[layer] ?? '').trim();
    if (val) {
      lines.push(`## ${layer}\n${val}`);
    }
  }
  return lines.length ? `${lines.join('\n\n')}\n` : '';
}

export function renderPersonaFirstPerson(data: PersonaData, maxChars = 3000): string {
  const opening = [data.名字 ? `我是${data.名字}。` : '', data.她是谁].filter(Boolean).join('');
  const sections = (['性格', '说话方式', '愿景'] as const)
    .filter((k) => Boolean(data[k]?.trim()))
    .map((k) => `# ${k}\n${data[k].trim()}`);
  const combined = [opening, ...sections, data.补充.trim()].filter(Boolean).join('\n\n');
  const chars = Array.from(combined);
  if (chars.length <= maxChars) return combined;
  return `${chars.slice(0, maxChars).join('')}\n（人设已按预算裁剪至 ${maxChars} 字）`;
}

export function readCharacterPersona(characterDir: string): PersonaData {
  const file = join(characterDir, 'persona.md');
  if (!existsSync(file)) return { ...DEFAULT_MIANMIAN_PERSONA };
  return parsePersonaMarkdown(readFileSync(file, 'utf8'));
}

export function saveCharacterPersona(characterDir: string, next: Partial<PersonaData>): { backupPath?: string } {
  mkdirSync(characterDir, { recursive: true });
  const file = join(characterDir, 'persona.md');
  let backupPath: string | undefined;
  if (existsSync(file)) {
    const snapDir = join(characterDir, 'snapshots', 'persona');
    mkdirSync(snapDir, { recursive: true });
    backupPath = join(snapDir, `persona.${Date.now()}.md`);
    cpSync(file, backupPath);
  }
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, serializePersonaMarkdown(next), 'utf8');
  renameSync(tmp, file);
  return { backupPath };
}
