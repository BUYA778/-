export interface AlarmRecord {
  id: string;
  at: string;
  note: string;
  source: 'plan';
  createdAt: string;
  nudged?: boolean;
}

const MIN_ALARM_MS = 60_000;
export const EARLY_STOP_MS = 5 * 60_000;

export function resolveAlarmTime(input: { at?: string; after_minutes?: number }, now: Date): Date {
  if ((input.at === undefined) === (input.after_minutes === undefined)) {
    throw new Error('请只提供 at 或 after_minutes 其中一个参数');
  }
  let target: Date;
  if (input.at !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/.test(input.at)) {
      throw new Error('at 必须是带时区的 ISO 时间，例如 2026-11-13T21:00:00+08:00');
    }
    target = new Date(input.at);
  } else {
    const mins = Number(input.after_minutes);
    if (!Number.isFinite(mins) || mins <= 0) {
      throw new Error('after_minutes 必须是正数');
    }
    target = new Date(now.getTime() + mins * 60_000);
  }
  if (!Number.isFinite(target.getTime())) {
    throw new Error('无法解析闹钟时间');
  }
  if (target.getTime() - now.getTime() < MIN_ALARM_MS) {
    throw new Error('闹钟至少要定在 1 分钟之后');
  }
  return target;
}

export function createAlarmManager() {
  let current: AlarmRecord | undefined;

  function planNext(input: { at?: string; after_minutes?: number }, note: string, now = new Date()): AlarmRecord {
    const cleanNote = String(note ?? '').trim();
    if (!cleanNote) throw new Error('闹钟便条 note 不能为空');
    const target = resolveAlarmTime(input, now);
    current = {
      id: `alarm_${target.getTime()}`,
      at: target.toISOString(),
      note: cleanNote,
      source: 'plan',
      createdAt: now.toISOString(),
    };
    return current;
  }

  function checkAlarm(): AlarmRecord | undefined {
    return current;
  }

  function cancelAlarm(): boolean {
    if (!current) return false;
    current = undefined;
    return true;
  }

  function popDueAlarm(now = new Date()): AlarmRecord | undefined {
    if (!current) return undefined;
    if (Date.parse(current.at) > now.getTime()) return undefined;
    const due = current;
    current = undefined;
    return due;
  }

  function shouldNudgeEarlyStop(completed: boolean, partnerSpoke: boolean, ownTurn: boolean, now = new Date()): boolean {
    if (!completed || partnerSpoke || ownTurn || !current || current.nudged) return false;
    const remaining = Date.parse(current.at) - now.getTime();
    if (remaining > EARLY_STOP_MS) {
      current.nudged = true;
      return true;
    }
    return false;
  }

  return { planNext, checkAlarm, cancelAlarm, popDueAlarm, shouldNudgeEarlyStop };
}
