export type VoiceTriggerResult = {
  text: string;
  matchedWakeWord?: string;
  isFinal: boolean;
  engine: string;
};

export type VoiceTriggerCallbacks = {
  onStatus: (message: string) => void;
  onResult: (result: VoiceTriggerResult) => void;
  onError: (message: string) => void;
};

export type VoiceTriggerConfig = {
  wakeWords: string[];
};

export interface VoiceTriggerService {
  readonly name: string;
  isSupported(): boolean;
  start(config: VoiceTriggerConfig, callbacks: VoiceTriggerCallbacks): Promise<void>;
  pause(): Promise<void>;
  recover(): Promise<void>;
  stop(): Promise<void>;
}

export const DEFAULT_WAKE_WORDS = ["再生", "スタート", "start", "play"];
export const VOSK_MODEL_URL = "vosk/vosk-model-small-ja-0.22.tar.gz";
export const VOSK_MODEL_SIZE_BYTES = 49_636_074;
export const VOSK_MODEL_SIZE_LABEL = "100MB弱";
export const VOSK_MODEL_CACHE_NAME = "projection-cue-player-vosk-v2";
const MATCH_COOLDOWN_MS = 1500;

type SpeechRecognitionAlternative = {
  transcript: string;
};

type SpeechRecognitionResult = {
  readonly isFinal: boolean;
  readonly length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
};

type SpeechRecognitionResultList = {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
};

type SpeechRecognitionResultEvent = Event & {
  resultIndex: number;
  results: SpeechRecognitionResultList;
};

type SpeechRecognitionErrorEvent = Event & {
  error?: string;
  message?: string;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance;

type SpeechRecognitionInstance = EventTarget & {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionResultEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
};

type WindowWithSpeechRecognition = Window & {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
};

type AudioContextConstructor = new (options?: AudioContextOptions) => AudioContext;

type WindowWithAudioContext = Window & {
  webkitAudioContext?: AudioContextConstructor;
};

type VoskModule = typeof import("vosk-browser");
type VoskModel = InstanceType<VoskModule["Model"]>;
type VoskRecognizer = InstanceType<VoskModel["KaldiRecognizer"]>;

function normalizeForWakeWord(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/g, "").trim();
}

function findWakeWord(text: string, wakeWords: string[]): string | undefined {
  const normalizedText = normalizeForWakeWord(text);
  if (!normalizedText) {
    return undefined;
  }

  return wakeWords.find((word) => {
    const normalizedWord = normalizeForWakeWord(word);
    return normalizedWord.length > 0 && normalizedText.includes(normalizedWord);
  });
}

function buildVoskGrammar(wakeWords: string[]): string | undefined {
  const words = Array.from(new Set(wakeWords.map((word) => word.trim()).filter(Boolean)));
  if (words.length === 0) {
    return undefined;
  }

  return JSON.stringify([...words, "[unk]"]);
}

function resolveModelUrl(modelUrl: string): string {
  if (typeof window === "undefined") {
    return modelUrl;
  }

  return new URL(modelUrl, window.location.href).href;
}

function getAudioContextConstructor(): AudioContextConstructor | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  return window.AudioContext ?? (window as WindowWithAudioContext).webkitAudioContext;
}

function getSpeechRecognitionConstructor(): SpeechRecognitionConstructor | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  const speechWindow = window as WindowWithSpeechRecognition;
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
}

function stopMediaStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return String(error);
}

async function assertVoskModelAvailable(modelUrl: string): Promise<void> {
  const response = await fetch(resolveModelUrl(modelUrl));
  if (!response.ok) {
    throw new Error(`オフライン音声認識データが見つかりません (${response.status})。`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) {
    throw new Error("音声認識データではなくHTMLが返されました。公開ファイルの配置を確認してください。");
  }

  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > 0 && contentLength < 1024 * 1024) {
    throw new Error("音声認識データが小さすぎます。公開ファイルの配置を確認してください。");
  }

  await response.body?.cancel().catch(() => undefined);
}

async function loadVoskModel(
  ModelClass: VoskModule["Model"],
  modelUrl: string,
  callbacks: VoiceTriggerCallbacks,
): Promise<VoskModel> {
  return new Promise((resolve, reject) => {
    const pendingModel = new ModelClass(resolveModelUrl(modelUrl), -1);
    const timeoutId = window.setTimeout(() => {
      pendingModel.terminate();
      reject(new Error("オフライン音声認識の読み込みに時間がかかりすぎています。ブラウザを再読み込みしてもう一度試してください。"));
    }, 60_000);

    pendingModel.on("load", (message) => {
      window.clearTimeout(timeoutId);
      if ("result" in message && message.result) {
        resolve(pendingModel);
        return;
      }

      pendingModel.terminate();
      reject(new Error("オフライン音声認識の読み込みに失敗しました。"));
    });

    pendingModel.on("error", (message) => {
      window.clearTimeout(timeoutId);
      pendingModel.terminate();
      const errorMessage = "error" in message ? message.error : JSON.stringify(message);
      callbacks.onError(`オフライン音声認識の処理でエラーが発生しました: ${errorMessage}`);
      reject(new Error(errorMessage));
    });
  });
}

class WakeWordEmitter {
  private lastMatchAt = 0;

  resetCooldown(): void {
    this.lastMatchAt = 0;
  }

  emit(
    text: string,
    isFinal: boolean,
    engine: string,
    wakeWords: string[],
    callbacks: VoiceTriggerCallbacks,
  ): void {
    const trimmedText = text.trim();
    if (!trimmedText) {
      return;
    }

    const matchedWakeWord = findWakeWord(trimmedText, wakeWords);
    const now = Date.now();
    const canTrigger = matchedWakeWord && now - this.lastMatchAt > MATCH_COOLDOWN_MS;

    if (canTrigger) {
      this.lastMatchAt = now;
    }

    if (isFinal || canTrigger) {
      callbacks.onResult({
        text: trimmedText,
        matchedWakeWord: canTrigger ? matchedWakeWord : undefined,
        isFinal,
        engine,
      });
    }
  }
}

class VoskVoiceTriggerService implements VoiceTriggerService {
  readonly name = "Vosk";

  private runId = 0;
  private active = false;
  private model: VoskModel | null = null;
  private recognizer: VoskRecognizer | null = null;
  private mediaStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private muteNode: GainNode | null = null;
  private lastConfig: VoiceTriggerConfig | null = null;
  private lastCallbacks: VoiceTriggerCallbacks | null = null;
  private paused = false;
  private readonly emitter = new WakeWordEmitter();

  isSupported(): boolean {
    return (
      typeof navigator !== "undefined" &&
      Boolean(navigator.mediaDevices?.getUserMedia) &&
      Boolean(getAudioContextConstructor())
    );
  }

  async start(config: VoiceTriggerConfig, callbacks: VoiceTriggerCallbacks): Promise<void> {
    await this.stop();

    if (!this.isSupported()) {
      throw new Error("このブラウザではオフライン音声認識用のマイク入力を開始できません。");
    }

    const AudioContextClass = getAudioContextConstructor();
    if (!AudioContextClass) {
      throw new Error("AudioContextを開始できません。");
    }

    const runId = ++this.runId;
    this.active = true;
    this.paused = false;
    this.lastConfig = config;
    this.lastCallbacks = callbacks;

    callbacks.onStatus("オフライン音声認識データを確認しています。");
    await assertVoskModelAvailable(VOSK_MODEL_URL);

    callbacks.onStatus("マイク権限を確認しています。");
    const mediaStream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        sampleRate: 16000,
      },
    });

    if (!this.isCurrentRun(runId)) {
      stopMediaStream(mediaStream);
      return;
    }

    this.mediaStream = mediaStream;
    callbacks.onStatus("オフライン音声認識を読み込んでいます。");

    const { Model } = await import("vosk-browser");
    const model = await loadVoskModel(Model, VOSK_MODEL_URL, callbacks);

    if (!this.isCurrentRun(runId)) {
      model.terminate();
      return;
    }

    this.model = model;
    const audioContext = new AudioContextClass();
    await audioContext.resume();

    if (!this.isCurrentRun(runId)) {
      await audioContext.close();
      return;
    }

    this.audioContext = audioContext;
    this.createRecognizer(config, callbacks, audioContext.sampleRate);

    const sourceNode = audioContext.createMediaStreamSource(mediaStream);
    const processorNode = audioContext.createScriptProcessor(4096, 1, 1);
    const muteNode = audioContext.createGain();
    muteNode.gain.value = 0;

    processorNode.onaudioprocess = (event) => {
      if (!this.active || this.paused || !this.recognizer) {
        return;
      }

      try {
        const channelData = new Float32Array(event.inputBuffer.getChannelData(0));
        this.recognizer.acceptWaveformFloat(channelData, event.inputBuffer.sampleRate);
      } catch (error) {
        callbacks.onError(`音声入力の処理に失敗しました: ${describeError(error)}`);
      }
    };

    sourceNode.connect(processorNode);
    processorNode.connect(muteNode);
    muteNode.connect(audioContext.destination);

    this.sourceNode = sourceNode;
    this.processorNode = processorNode;
    this.muteNode = muteNode;
    callbacks.onStatus("声で再生を開始しました。");
  }

  async pause(): Promise<void> {
    if (!this.active) {
      return;
    }

    this.paused = true;
    this.emitter.resetCooldown();
    this.recognizer?.remove();
    this.recognizer = null;
  }

  async recover(): Promise<void> {
    if (!this.active || !this.lastConfig || !this.lastCallbacks) {
      return;
    }

    const hasLiveTrack =
      this.mediaStream?.getAudioTracks().some((track) => track.readyState === "live" && track.enabled) ?? false;

    if (!hasLiveTrack || !this.model || !this.audioContext) {
      await this.start(this.lastConfig, this.lastCallbacks);
      return;
    }

    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }

    this.paused = false;
    this.emitter.resetCooldown();
    this.createRecognizer(this.lastConfig, this.lastCallbacks, this.audioContext.sampleRate);
    this.lastCallbacks.onStatus("声で再生を再開しました。");
  }

  async stop(): Promise<void> {
    this.active = false;
    this.paused = false;
    this.runId += 1;

    if (this.processorNode) {
      this.processorNode.onaudioprocess = null;
      this.processorNode.disconnect();
      this.processorNode = null;
    }

    this.sourceNode?.disconnect();
    this.sourceNode = null;
    this.muteNode?.disconnect();
    this.muteNode = null;

    this.recognizer?.remove();
    this.recognizer = null;

    stopMediaStream(this.mediaStream);
    this.mediaStream = null;

    if (this.audioContext && this.audioContext.state !== "closed") {
      await this.audioContext.close().catch(() => undefined);
    }
    this.audioContext = null;

    this.model?.terminate();
    this.model = null;
  }

  private isCurrentRun(runId: number): boolean {
    return this.active && this.runId === runId;
  }

  private createRecognizer(
    config: VoiceTriggerConfig,
    callbacks: VoiceTriggerCallbacks,
    sampleRate: number,
  ): void {
    if (!this.model) {
      throw new Error("オフライン音声認識がまだ読み込まれていません。");
    }

    this.recognizer?.remove();

    const recognizer = new this.model.KaldiRecognizer(sampleRate, buildVoskGrammar(config.wakeWords));
    recognizer.setWords(false);
    this.recognizer = recognizer;

    recognizer.on("partialresult", (message) => {
      if (message.event === "partialresult") {
        this.emitter.emit(message.result.partial, false, this.name, config.wakeWords, callbacks);
      }
    });

    recognizer.on("result", (message) => {
      if (message.event === "result") {
        this.emitter.emit(message.result.text, true, this.name, config.wakeWords, callbacks);
      }
    });

    recognizer.on("error", (message) => {
      if (message.event === "error") {
        callbacks.onError(`オフライン音声認識エラー: ${message.error}`);
      }
    });
  }
}

class WebSpeechVoiceTriggerService implements VoiceTriggerService {
  readonly name = "Web Speech API";

  private active = false;
  private recognition: SpeechRecognitionInstance | null = null;
  private restartTimer: number | null = null;
  private lastConfig: VoiceTriggerConfig | null = null;
  private lastCallbacks: VoiceTriggerCallbacks | null = null;
  private paused = false;
  private readonly emitter = new WakeWordEmitter();

  isSupported(): boolean {
    return Boolean(getSpeechRecognitionConstructor());
  }

  async start(config: VoiceTriggerConfig, callbacks: VoiceTriggerCallbacks): Promise<void> {
    await this.stop();

    const SpeechRecognitionClass = getSpeechRecognitionConstructor();
    if (!SpeechRecognitionClass) {
      throw new Error("このブラウザではWeb Speech APIを利用できません。");
    }

    this.active = true;
    this.paused = false;
    this.lastConfig = config;
    this.lastCallbacks = callbacks;
    const recognition = new SpeechRecognitionClass();
    recognition.lang = "ja-JP";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = result[0]?.transcript ?? "";
        this.emitter.emit(transcript, result.isFinal, this.name, config.wakeWords, callbacks);
      }
    };

    recognition.onerror = (event) => {
      callbacks.onError(`音声認識エラー: ${event.error ?? event.message ?? "原因不明"}`);
    };

    recognition.onend = () => {
      if (!this.active || this.paused) {
        return;
      }

      this.restartTimer = window.setTimeout(() => {
        try {
          recognition.start();
        } catch (error) {
          callbacks.onError(`音声認識の再開に失敗しました: ${describeError(error)}`);
        }
      }, 500);
    };

    this.recognition = recognition;
    recognition.start();
    callbacks.onStatus("ブラウザの音声認識で声で再生を開始しました。");
  }

  async pause(): Promise<void> {
    if (!this.active) {
      return;
    }

    this.paused = true;
    this.emitter.resetCooldown();
    if (this.restartTimer !== null) {
      window.clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (this.recognition) {
      this.recognition.onresult = null;
      this.recognition.onerror = null;
      this.recognition.onend = null;
      try {
        this.recognition.abort();
      } catch {
        try {
          this.recognition.stop();
        } catch {
          // Some browsers throw when recognition is already stopped.
        }
      }
      this.recognition = null;
    }
  }

  async recover(): Promise<void> {
    if (!this.active || !this.lastConfig || !this.lastCallbacks) {
      return;
    }

    const config = this.lastConfig;
    const callbacks = this.lastCallbacks;
    await this.stop();
    await this.start(config, callbacks);
    callbacks.onStatus("声で再生を再開しました。");
  }

  async stop(): Promise<void> {
    this.active = false;
    this.paused = false;

    if (this.restartTimer !== null) {
      window.clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (this.recognition) {
      this.recognition.onresult = null;
      this.recognition.onerror = null;
      this.recognition.onend = null;
      try {
        this.recognition.abort();
      } catch {
        try {
          this.recognition.stop();
        } catch {
          // Some browsers throw when recognition is already stopped.
        }
      }
      this.recognition = null;
    }
  }
}

class HybridVoiceTriggerService implements VoiceTriggerService {
  readonly name = "Vosk / Web Speech";

  private runId = 0;

  isSupported(): boolean {
    return this.vosk.isSupported() || this.webSpeech.isSupported();
  }

  private readonly vosk = new VoskVoiceTriggerService();
  private readonly webSpeech = new WebSpeechVoiceTriggerService();
  private activeService: VoiceTriggerService | null = null;
  private lastConfig: VoiceTriggerConfig | null = null;
  private lastCallbacks: VoiceTriggerCallbacks | null = null;

  async start(config: VoiceTriggerConfig, callbacks: VoiceTriggerCallbacks): Promise<void> {
    await this.stop();
    const runId = ++this.runId;
    this.lastConfig = config;
    this.lastCallbacks = callbacks;

    if (this.vosk.isSupported()) {
      try {
        await this.vosk.start(config, callbacks);
        if (!this.isCurrentRun(runId)) {
          await this.vosk.stop();
          return;
        }
        this.activeService = this.vosk;
        return;
      } catch (error) {
        callbacks.onError(`オフライン音声認識を開始できませんでした: ${describeError(error)}`);
        await this.vosk.stop();
      }
    }

    if (this.webSpeech.isSupported()) {
      callbacks.onStatus("ブラウザの音声認識へ切り替えます。");
      await this.webSpeech.start(config, callbacks);
      if (!this.isCurrentRun(runId)) {
        await this.webSpeech.stop();
        return;
      }
      this.activeService = this.webSpeech;
      return;
    }

    callbacks.onError("このブラウザでは音声認識を開始できません。Space / Enter / クリックで操作してください。");
  }

  async recover(): Promise<void> {
    if (!this.lastConfig || !this.lastCallbacks) {
      return;
    }

    try {
      await this.activeService?.recover();
    } catch (error) {
      this.lastCallbacks.onError(`音声認識の復旧に失敗しました: ${describeError(error)}`);
      await this.start(this.lastConfig, this.lastCallbacks);
    }
  }

  async pause(): Promise<void> {
    await this.activeService?.pause();
  }

  async stop(): Promise<void> {
    this.runId += 1;
    await this.activeService?.stop();
    await this.vosk.stop();
    await this.webSpeech.stop();
    this.activeService = null;
  }

  private isCurrentRun(runId: number): boolean {
    return this.runId === runId;
  }
}

export function createVoiceTriggerService(): VoiceTriggerService {
  return new HybridVoiceTriggerService();
}
