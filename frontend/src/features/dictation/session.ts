/** The production recording path, also used by the hardware test harness. */
export type Phase = 'idle' | 'asking' | 'recording' | 'transcribing';
export type DictationState = { phase: Phase; error: string | null };
const RATE = 16000;
export const MAX_SECONDS = 60;
let activeCancel: (() => void) | null = null;

/** An append uses the latest draft, including edits made during transcription. */
export function appendTranscript(draft: string, text: string, limit: number): string {
  const next = draft + (draft && !/\s$/.test(draft) ? ' ' : '') + text.trim();
  if (next.length > limit) throw new Error('too_long');
  return next;
}

export function pcmWav(samples: Float32Array): Blob {
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  const word = (offset: number, text: string) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  word(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); word(8, 'WAVE'); word(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, RATE, true); view.setUint32(28, RATE * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); word(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => { const x = Math.max(-1, Math.min(1, sample)); view.setInt16(44 + i * 2, Math.round(x * (x < 0 ? 32768 : 32767)), true); });
  return new Blob([bytes], { type: 'audio/wav' });
}

export async function wavFromRecording(blob: Blob): Promise<Blob> {
  const context = new OfflineAudioContext(1, 1, RATE);
  const audio = await context.decodeAudioData(await blob.arrayBuffer());
  if (!audio.length || audio.duration > MAX_SECONDS + 0.25) throw new Error('invalid_audio');
  const mono = new Float32Array(Math.min(audio.length, MAX_SECONDS * RATE));
  for (let channel = 0; channel < audio.numberOfChannels; channel++) {
    const samples = audio.getChannelData(channel);
    for (let i = 0; i < mono.length; i++) mono[i] += samples[i] / audio.numberOfChannels;
  }
  return pcmWav(mono);
}

export class DictationSession {
  private generation = 0;
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private request: AbortController | null = null;
  private state: DictationState = { phase: 'idle', error: null };
  // Content-free evidence; the optional local blob belongs to the caller of
  // onRecording, never to telemetry or persistent application storage.
  diagnostics: { mime: string; bytes: number; tracksEnded: boolean; requestId?: string } = { mime: '', bytes: 0, tracksEnded: true };
  constructor(private callbacks: { onState: (state: DictationState) => void; onText: (text: string) => void; onRecording?: (blob: Blob) => void }) {}
  private publish(phase: Phase, error: string | null = null) { this.state = { phase, error }; this.callbacks.onState(this.state); }
  private release() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const stream = this.stream;
    this.stream = null;
    for (const track of stream?.getTracks() || []) { track.onended = null; track.stop(); }
    this.diagnostics.tracksEnded = !stream || stream.getTracks().every((track) => track.readyState === 'ended');
  }
  cancel = () => {
    this.generation++;
    this.request?.abort(); this.request = null;
    if (this.recorder) {
      this.recorder.onstop = null; this.recorder.ondataavailable = null; this.recorder.onerror = null;
      if (this.recorder.state !== 'inactive') this.recorder.stop();
      this.recorder = null;
    }
    this.release();
    if (activeCancel === this.cancel) activeCancel = null;
    this.publish('idle');
  };
  stop = () => { if (this.recorder?.state === 'recording') this.recorder.stop(); };
  async start() {
    activeCancel?.(); this.cancel();
    activeCancel = this.cancel;
    const generation = ++this.generation;
    const live = () => generation === this.generation;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined' || typeof OfflineAudioContext === 'undefined') {
      this.cancel(); this.publish('idle', 'unsupported'); return;
    }
    this.publish('asking');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Permission can arrive after Cancel, navigation, or another recorder.
      if (!live()) { stream.getTracks().forEach((track) => track.stop()); return; }
      this.stream = stream;
      stream.getTracks().forEach((track) => { track.onended = () => { this.cancel(); this.publish('idle', 'interrupted'); }; });
      const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      this.recorder = recorder;
      this.diagnostics = { mime: recorder.mimeType, bytes: 0, tracksEnded: false };
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (!live()) return;
        chunks.push(event.data); this.diagnostics.bytes += event.data.size;
        if (this.diagnostics.bytes > 8 * 1024 * 1024) { this.cancel(); this.publish('idle', 'invalid_audio'); }
      };
      recorder.onerror = () => { if (live()) { this.cancel(); this.publish('idle', 'interrupted'); } };
      recorder.onstop = async () => {
        this.recorder = null; this.release();
        if (!live()) return;
        this.publish('transcribing');
        const request = new AbortController(); this.request = request;
        this.timer = setTimeout(() => request.abort(), 50000);
        try {
          const recording = await wavFromRecording(new Blob(chunks, { type: recorder.mimeType }));
          if (!live()) return;
          this.callbacks.onRecording?.(recording);
          const response = await fetch('/api/dictation/transcribe', { method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'audio/wav' }, body: recording, signal: request.signal });
          const body = await response.json();
          if (!live()) return;
          this.diagnostics.requestId = body.requestId;
          if (!response.ok) throw new Error(body.code || 'transcription_failed');
          if (typeof body.text !== 'string' || !body.text.trim()) throw new Error('no_speech');
          this.callbacks.onText(body.text);
          this.cancel();
        } catch (error) {
          if (!live()) return;
          const code = request.signal.aborted ? 'timeout' : error instanceof Error ? error.message : 'transcription_failed';
          this.cancel(); this.publish('idle', code);
        }
      };
      recorder.start(250);
      this.publish('recording');
      this.timer = setTimeout(this.stop, MAX_SECONDS * 1000);
    } catch (error) {
      if (!live()) return;
      const denied = error instanceof DOMException && ['NotAllowedError', 'SecurityError'].includes(error.name);
      this.cancel(); this.publish('idle', denied ? 'permission_denied' : 'unavailable');
    }
  }
}
