export interface OnlineTtsOptions {
  enabled: boolean;
  onlineEndpoint: string;
  apiKey: string;
  voiceId: string;
  maxChars: number;
  maxPerMinute: number;
}

export interface SynthesizeResult {
  ok: boolean;
  audioBase64?: string;
  mimeType?: string;
  error?: string;
}

export function createOnlineVoiceClient(opts: OnlineTtsOptions) {
  const recentTimestamps: number[] = [];

  function canSendNow(nowMs = Date.now()): { ok: boolean; reason?: string } {
    if (!opts.enabled) return { ok: false, reason: '在线语音开关未开启' };
    if (!opts.onlineEndpoint) return { ok: false, reason: '未配置在线 TTS 接口地址' };
    const cutoff = nowMs - 60_000;
    while (recentTimestamps.length && recentTimestamps[0] < cutoff) {
      recentTimestamps.shift();
    }
    if (recentTimestamps.length >= opts.maxPerMinute) {
      return { ok: false, reason: `已触发每分钟最多 ${opts.maxPerMinute} 条语音频控` };
    }
    return { ok: true };
  }

  async function synthesize(text: string, nowMs = Date.now()): Promise<SynthesizeResult> {
    const gate = canSendNow(nowMs);
    if (!gate.ok) return { ok: false, error: gate.reason };

    const chars = Array.from(String(text ?? '').trim());
    if (!chars.length) return { ok: false, error: '合成文本为空' };
    if (chars.length > opts.maxChars) {
      return { ok: false, error: `单条语音文本超过 ${opts.maxChars} 字限制` };
    }

    const res = await fetch(opts.onlineEndpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
      },
      body: JSON.stringify({
        text: chars.join(''),
        voice: opts.voiceId,
        format: 'mp3',
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      return { ok: false, error: `在线 TTS 接口返回 HTTP ${res.status}` };
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.byteLength) {
      return { ok: false, error: '在线 TTS 返回空音频流' };
    }

    recentTimestamps.push(nowMs);
    return {
      ok: true,
      audioBase64: buf.toString('base64'),
      mimeType: res.headers.get('content-type') || 'audio/mpeg',
    };
  }

  return { canSendNow, synthesize };
}
