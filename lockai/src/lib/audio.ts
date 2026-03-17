const TARGET_SAMPLE_RATE = 16000;
const LIVE_CHUNK_DURATION_MS = 200;
const LIVE_CHUNK_SAMPLES = (TARGET_SAMPLE_RATE * LIVE_CHUNK_DURATION_MS) / 1000;

type AudioContextConstructor = typeof AudioContext;

export interface LiveVoiceStreamSession {
  stop: () => Promise<{ durationMs: number }>;
  cancel: () => void;
}

function getAudioContextConstructor(): AudioContextConstructor | null {
  if (typeof window === 'undefined') return null;
  const extendedWindow = window as Window & typeof globalThis & {
    webkitAudioContext?: AudioContextConstructor;
  };
  return window.AudioContext || extendedWindow.webkitAudioContext || null;
}

function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop());
}

function resamplePcm(input: Float32Array, sourceRate: number, targetRate: number): Float32Array {
  if (sourceRate === targetRate) {
    return input;
  }

  const ratio = sourceRate / targetRate;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(outputLength);

  for (let index = 0; index < outputLength; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(input.length, Math.floor((index + 1) * ratio));

    let sum = 0;
    let count = 0;
    for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
      sum += input[sampleIndex];
      count += 1;
    }

    if (count > 0) {
      output[index] = sum / count;
      continue;
    }

    const fallbackIndex = Math.min(input.length - 1, Math.round(index * ratio));
    output[index] = input[fallbackIndex] || 0;
  }

  return output;
}

function floatToInt16Sample(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample));
  return clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
}

function encodePcmChunk(samples: Int16Array): ArrayBuffer {
  const bytes = new Uint8Array(samples.byteLength);
  bytes.set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
  return bytes.buffer;
}

function mapRecordingError(error: unknown): Error {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError') {
      return new Error('没有麦克风权限，请允许浏览器访问麦克风');
    }
    if (error.name === 'NotFoundError') {
      return new Error('没有检测到可用麦克风');
    }
    if (error.name === 'NotReadableError') {
      return new Error('麦克风正被其他应用占用，请稍后重试');
    }
  }
  return error instanceof Error ? error : new Error('启动录音失败，请重试');
}

export function isLiveVoiceInputSupported(): boolean {
  return (
    typeof window !== 'undefined'
    && typeof navigator !== 'undefined'
    && typeof navigator.mediaDevices?.getUserMedia === 'function'
    && getAudioContextConstructor() !== null
  );
}

export async function startLiveVoiceStream(options: {
  onChunk: (chunk: ArrayBuffer) => Promise<void> | void;
}): Promise<LiveVoiceStreamSession> {
  if (!isLiveVoiceInputSupported()) {
    throw new Error('当前浏览器不支持实时语音输入');
  }

  let stream: MediaStream | null = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (error) {
    throw mapRecordingError(error);
  }

  const AudioContextCtor = getAudioContextConstructor();
  if (!AudioContextCtor) {
    stopStream(stream);
    throw new Error('当前浏览器不支持实时语音输入');
  }

  const audioContext = new AudioContextCtor();
  await audioContext.resume().catch(() => undefined);

  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const muteGain = audioContext.createGain();
  muteGain.gain.value = 0;

  source.connect(processor);
  processor.connect(muteGain);
  muteGain.connect(audioContext.destination);

  const queuedSamples: number[] = [];
  const startedAt = Date.now();
  let active = true;
  let sendChain = Promise.resolve();
  let sendError: Error | null = null;

  const enqueueChunk = (chunk: Int16Array) => {
    const payload = encodePcmChunk(chunk);
    sendChain = sendChain
      .catch(() => undefined)
      .then(async () => {
        if (sendError) return;
        await options.onChunk(payload);
      })
      .catch((error) => {
        sendError = error instanceof Error ? error : new Error('上传语音分片失败，请重试');
      });
  };

  processor.onaudioprocess = (event) => {
    if (!active || sendError) return;

    const input = event.inputBuffer.getChannelData(0);
    const resampled = resamplePcm(new Float32Array(input), event.inputBuffer.sampleRate, TARGET_SAMPLE_RATE);
    for (let index = 0; index < resampled.length; index += 1) {
      queuedSamples.push(floatToInt16Sample(resampled[index]));
    }

    while (queuedSamples.length >= LIVE_CHUNK_SAMPLES) {
      const chunk = Int16Array.from(queuedSamples.splice(0, LIVE_CHUNK_SAMPLES));
      enqueueChunk(chunk);
    }
  };

  const teardown = async () => {
    if (!active) return;
    active = false;
    processor.onaudioprocess = null;
    try {
      source.disconnect();
    } catch {}
    try {
      processor.disconnect();
    } catch {}
    try {
      muteGain.disconnect();
    } catch {}
    stopStream(stream);
    stream = null;
    await audioContext.close().catch(() => undefined);
  };

  return {
    stop: async () => {
      await teardown();
      if (queuedSamples.length > 0) {
        enqueueChunk(Int16Array.from(queuedSamples.splice(0, queuedSamples.length)));
      }
      await sendChain;
      if (sendError) {
        throw sendError;
      }
      return { durationMs: Math.max(0, Date.now() - startedAt) };
    },
    cancel: () => {
      void teardown();
      queuedSamples.length = 0;
    },
  };
}
