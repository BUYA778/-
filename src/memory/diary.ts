import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DIARY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.md$/;

export function closedDiaryRefusal(
  targetPath: string,
  diaryDir: string,
  todayKey: string,
  openDays: ReadonlySet<string> = new Set([todayKey]),
): string | undefined {
  const absTarget = resolve(targetPath);
  const absDir = resolve(diaryDir);
  if (relative(absDir, dirname(absTarget)) !== '') return undefined;
  const match = DIARY_FILE_RE.exec(basename(absTarget));
  if (!match) return undefined;
  const day = match[1];
  if (openDays.has(day)) return undefined;
  return `${day} 的日记已经合上了，不能修改过去；如果记错了或想法变了，请写进今天（${todayKey}）的日记。`;
}

export function listDiaryDates(diaryDir: string): string[] {
  if (!existsSync(diaryDir)) return [];
  return readdirSync(diaryDir)
    .filter((name) => DIARY_FILE_RE.test(name))
    .map((name) => name.slice(0, 10))
    .sort()
    .reverse();
}

export function readDiaryEntry(diaryDir: string, date: string): string | undefined {
  if (!DATE_RE.test(date)) return undefined;
  const file = join(diaryDir, `${date}.md`);
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
}

export function writeTodayDiary(
  diaryDir: string,
  todayKey: string,
  content: string,
  targetDate = todayKey,
): { ok: true; file: string } | { ok: false; error: string } {
  if (!DATE_RE.test(targetDate)) {
    return { ok: false, error: '日期格式必须是 YYYY-MM-DD' };
  }
  const file = join(diaryDir, `${targetDate}.md`);
  const refusal = closedDiaryRefusal(file, diaryDir, todayKey);
  if (refusal) {
    return { ok: false, error: refusal };
  }
  mkdirSync(diaryDir, { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${String(content ?? '').trim()}\n`, 'utf8');
  renameSync(tmp, file);
  return { ok: true, file };
}
