import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const MOODS = ['开心', '兴奋', '平静', '安心', '烦', '生气', '紧张', '难过', '累', '孤单', '想念'] as const;
export type MoodName = (typeof MOODS)[number];

export interface ParsedMood {
  values: Record<string, number>;
  trivia: string[];
  outside: string[];
  unreadLines: number;
}

const MAX_TRIVIA_LINES = 3;
const MAX_TRIVIA_CHARS = 12;

export function parseMoodText(raw: string): ParsedMood {
  const values: Record<string, number> = {};
  const trivia: string[] = [];
  const outside: string[] = [];
  let unreadLines = 0;

  for (const lineRaw of String(raw ?? '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (!line) continue;
    const match = /^(.*?)[\s\u3000:：]+([+-]?\d+(?:\.\d+)?)$/u.exec(line);
    if (match) {
      const name = match[1].trim();
      const val = Number(match[2]);
      if (!name || !Number.isInteger(val) || val < 0 || val > 10) {
        unreadLines += 1;
      } else if (!(MOODS as readonly string[]).includes(name)) {
        if (!outside.includes(name)) outside.push(name);
      } else {
        values[name] = val;
      }
      continue;
    }
    if (trivia.length < MAX_TRIVIA_LINES) {
      trivia.push(Array.from(line).slice(0, MAX_TRIVIA_CHARS).join(''));
    }
  }

  return { values, trivia, outside, unreadLines };
}

export function setMoodFile(moodFile: string, rawMoodText: string): { ok: true; parsed: ParsedMood } | { ok: false; error: string } {
  const parsed = parseMoodText(rawMoodText);
  if (parsed.outside.length > 0) {
    return {
      ok: false,
      error: `${parsed.outside.join('、')} 不在固定心情词表中，只能用：${MOODS.join('、')}`,
    };
  }
  if (parsed.unreadLines > 0) {
    return {
      ok: false,
      error: `有 ${parsed.unreadLines} 行格式不正确，心情必须是「心情名 0-10整数」，例如「开心 7」`,
    };
  }
  if (Object.keys(parsed.values).length === 0 && parsed.trivia.length === 0) {
    return { ok: false, error: '没有写入任何有效心情或小事' };
  }
  mkdirSync(dirname(moodFile), { recursive: true });
  const tmp = `${moodFile}.tmp`;
  writeFileSync(tmp, `${rawMoodText.trim()}\n`, 'utf8');
  renameSync(tmp, moodFile);
  return { ok: true, parsed };
}

export function renderMoodSnapshot(moodFile: string): string {
  if (!existsSync(moodFile) || !statSync(moodFile).isFile()) return '';
  const parsed = parseMoodText(readFileSync(moodFile, 'utf8'));
  const pairs = MOODS.filter((m) => (parsed.values[m] ?? 0) > 0).map((m) => `${m} ${parsed.values[m]}`);
  if (!pairs.length && !parsed.trivia.length) return '';
  const lines = ['【我的心情值】'];
  if (pairs.length) lines.push(pairs.join(' · '));
  for (const t of parsed.trivia) lines.push(`小事：${t}`);
  return lines.join('\n');
}
