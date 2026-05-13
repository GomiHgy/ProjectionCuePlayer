import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import type { AppLog, AppSettings, CueState, ObjectFitMode, WaitDisplayMode } from "./types";
import {
  DEFAULT_WAKE_WORDS,
  VOSK_MODEL_CACHE_NAME,
  VOSK_MODEL_SIZE_LABEL,
  VOSK_MODEL_URL,
  createVoiceTriggerService,
  type VoiceTriggerService,
} from "./services/voiceTrigger";

const SETTINGS_KEY = "projection-cue-player.settings.v1";
const APP_VERSION = "v0.1.0";

const DEFAULT_SETTINGS: AppSettings = {
  delaySeconds: 0,
  mirror: false,
  objectFit: "contain",
  showStageOverlay: false,
  waitDisplayMode: "black",
  showCountdown: true,
  offlineVoskEnabled: false,
  voiceEnabled: false,
  wakeWords: DEFAULT_WAKE_WORDS,
};

const STATUS_LABELS: Record<CueState, string> = {
  "no-video": "動画未選択",
  idle: "待機中",
  delay: "遅延中",
  playing: "再生中",
  ended: "終了後待機",
  error: "エラー",
};

const OBJECT_FIT_LABELS: Record<ObjectFitMode, string> = {
  contain: "全体表示",
  cover: "画面いっぱい",
};

const WAIT_DISPLAY_LABELS: Record<WaitDisplayMode, string> = {
  black: "黒背景",
  "first-frame": "最初の画面",
};

const MINIMUM_SPEC_ITEMS = [
  "Chrome / Edge の最新版",
  "CPU: 4コア以上",
  "メモリ: 8GB以上",
  "動画: H.264 MP4 / 1920×1080 / 30fps程度",
  "GPU: H.264などの動画再生支援が使える内蔵GPUまたは外部GPU",
];

const RECOMMENDED_SPEC_ITEMS = [
  "CPU: Intel Core i5 第8世代 / Ryzen 5 3000 相当以上",
  "メモリ: 16GB以上",
  "動画: H.264 MP4 / 1920×1080 30〜60fpsを推奨",
  "4K動画: 6〜8コア以上、16GB以上、4K再生支援のあるGPUを推奨",
  "保存先: SSD上の動画ファイルを推奨",
];

type NavigatorWithDeviceMemory = Navigator & {
  deviceMemory?: number;
};

type VideoDimensions = {
  width: number;
  height: number;
};

type SpecLevel = "ok" | "warning" | "unknown";

type SpecAssessment = {
  level: SpecLevel;
  badgeLabel: string;
  cores: number | null;
  memoryGb: number | null;
  mp4Support: CanPlayTypeResult;
  webmSupport: CanPlayTypeResult;
  selectedVideoLabel: string;
  warnings: string[];
  notes: string[];
};

function loadSettings(): AppSettings {
  try {
    const rawValue = window.localStorage.getItem(SETTINGS_KEY);
    if (!rawValue) {
      return DEFAULT_SETTINGS;
    }

    const parsedValue = JSON.parse(rawValue) as Partial<AppSettings>;
    return {
      delaySeconds: clampDelay(Number(parsedValue.delaySeconds ?? DEFAULT_SETTINGS.delaySeconds)),
      mirror: Boolean(parsedValue.mirror ?? DEFAULT_SETTINGS.mirror),
      objectFit: parsedValue.objectFit === "cover" ? "cover" : "contain",
      showStageOverlay: Boolean(parsedValue.showStageOverlay ?? DEFAULT_SETTINGS.showStageOverlay),
      waitDisplayMode: parsedValue.waitDisplayMode === "first-frame" ? "first-frame" : "black",
      showCountdown: Boolean(parsedValue.showCountdown ?? DEFAULT_SETTINGS.showCountdown),
      offlineVoskEnabled: Boolean(parsedValue.offlineVoskEnabled ?? DEFAULT_SETTINGS.offlineVoskEnabled),
      voiceEnabled: Boolean(parsedValue.voiceEnabled ?? DEFAULT_SETTINGS.voiceEnabled),
      wakeWords: normalizeWakeWords(parsedValue.wakeWords),
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function clampDelay(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(10, Math.max(0, Math.round(value * 10) / 10));
}

function normalizeWakeWords(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return DEFAULT_WAKE_WORDS;
  }

  const words = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);

  return words.length > 0 ? Array.from(new Set(words)) : DEFAULT_WAKE_WORDS;
}

function formatFileSize(size: number): string {
  if (size < 1024 * 1024) {
    return `${Math.max(1, Math.round(size / 1024))} KB`;
  }

  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function formatBytes(size: number): string {
  if (size < 1024 * 1024) {
    return `${Math.max(1, Math.round(size / 1024))} KB`;
  }

  return `${(size / 1000 / 1000).toFixed(1)} MB`;
}

type CachedVoskModel = {
  cacheName: string;
  response: Response;
};

function getVoskModelUrl(): string {
  return new URL(VOSK_MODEL_URL, window.location.href).href;
}

function isVoskModelRequest(request: Request): boolean {
  const modelFileName = VOSK_MODEL_URL.split("/").at(-1);
  if (!modelFileName) {
    return false;
  }

  return new URL(request.url).pathname.endsWith(`/${modelFileName}`);
}

async function findCachedVoskModel(): Promise<CachedVoskModel | null> {
  const absoluteVoskModelUrl = getVoskModelUrl();
  const cacheNames = await caches.keys();
  const orderedCacheNames = [
    VOSK_MODEL_CACHE_NAME,
    ...cacheNames.filter((cacheName) => cacheName !== VOSK_MODEL_CACHE_NAME),
  ];

  for (const cacheName of orderedCacheNames) {
    const cache = await caches.open(cacheName);
    const directMatch =
      (await cache.match(absoluteVoskModelUrl)) ??
      (await cache.match(absoluteVoskModelUrl, { ignoreSearch: true })) ??
      (await cache.match(VOSK_MODEL_URL)) ??
      (await cache.match(VOSK_MODEL_URL, { ignoreSearch: true })) ??
      (await cache.match(`./${VOSK_MODEL_URL}`)) ??
      (await cache.match(`./${VOSK_MODEL_URL}`, { ignoreSearch: true }));

    if (directMatch) {
      return { cacheName, response: directMatch };
    }

    const matchingRequest = (await cache.keys()).find(isVoskModelRequest);
    if (matchingRequest) {
      const response = await cache.match(matchingRequest);
      if (response) {
        return { cacheName, response };
      }
    }
  }

  return null;
}

async function saveVoskModelResponse(response: Response): Promise<void> {
  const cache = await caches.open(VOSK_MODEL_CACHE_NAME);
  await cache.put(getVoskModelUrl(), response);
}

async function clearVoskModelCaches(): Promise<void> {
  navigator.serviceWorker?.controller?.postMessage({ type: "CLEAR_VOSK_CACHE" });
  const absoluteVoskModelUrl = getVoskModelUrl();

  const cacheNames = await caches.keys();
  await Promise.all(
    cacheNames.map(async (cacheName) => {
      const cache = await caches.open(cacheName);
      await cache.delete(VOSK_MODEL_URL);
      await cache.delete(new Request(VOSK_MODEL_URL));
      await cache.delete(absoluteVoskModelUrl);
      await cache.delete(new Request(absoluteVoskModelUrl));

      if (cacheName.includes("vosk")) {
        await caches.delete(cacheName);
      }
    }),
  );
}

function formatDuration(duration: number | null): string {
  if (!duration || !Number.isFinite(duration)) {
    return "--:--";
  }

  const minutes = Math.floor(duration / 60);
  const seconds = Math.floor(duration % 60);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function formatResolution(dimensions: VideoDimensions | null): string {
  if (!dimensions) {
    return "動画選択後に表示";
  }

  return `${dimensions.width}×${dimensions.height}`;
}

function describeCanPlay(value: CanPlayTypeResult): string {
  if (value === "probably") {
    return "対応見込み";
  }

  if (value === "maybe") {
    return "再生できる可能性あり";
  }

  return "未確認";
}

function getDeviceMemoryGb(): number | null {
  const deviceMemory = (navigator as NavigatorWithDeviceMemory).deviceMemory;
  return typeof deviceMemory === "number" && Number.isFinite(deviceMemory) ? deviceMemory : null;
}

function getBrowserCanPlay(type: string): CanPlayTypeResult {
  const video = document.createElement("video");
  return video.canPlayType(type);
}

function assessSpecs(selectedFile: File | null, videoDimensions: VideoDimensions | null): SpecAssessment {
  const cores = Number.isFinite(navigator.hardwareConcurrency) && navigator.hardwareConcurrency > 0
    ? navigator.hardwareConcurrency
    : null;
  const memoryGb = getDeviceMemoryGb();
  const mp4Support =
    getBrowserCanPlay('video/mp4; codecs="avc1.42E01E, mp4a.40.2"') || getBrowserCanPlay("video/mp4");
  const webmSupport =
    getBrowserCanPlay('video/webm; codecs="vp8, vorbis"') || getBrowserCanPlay("video/webm");
  const selectedVideoLabel = selectedFile
    ? `${selectedFile.name} / ${formatFileSize(selectedFile.size)} / ${formatResolution(videoDimensions)}`
    : "未選択";
  const warnings: string[] = [];
  const notes: string[] = [];

  if (cores === null) {
    notes.push("CPUコア数はブラウザから取得できませんでした。");
  } else if (cores < 4) {
    warnings.push("CPUコア数が4未満です。1080p動画でも再生が不安定になる可能性があります。");
  } else if (cores < 6) {
    notes.push("CPUは最低目安を満たしていますが、4K動画や声で再生を同時に使う場合は余裕が少ない可能性があります。");
  }

  if (memoryGb === null) {
    notes.push("メモリ容量はブラウザから取得できませんでした。8GB以上、できれば16GB以上を目安にしてください。");
  } else if (memoryGb < 4) {
    warnings.push("メモリが4GB未満です。動画再生やオフライン音声認識が不安定になる可能性があります。");
  } else if (memoryGb < 8) {
    warnings.push("メモリが8GB未満です。撮影本番では8GB以上、できれば16GB以上を推奨します。");
  }

  if (mp4Support === "" && webmSupport === "") {
    warnings.push("このブラウザでは一般的なmp4/webm動画の再生対応を確認できませんでした。ChromeまたはEdgeを推奨します。");
  }

  if (selectedFile?.type) {
    const selectedTypeSupport = getBrowserCanPlay(selectedFile.type);
    if (selectedFile.type.startsWith("video/") && selectedTypeSupport === "") {
      warnings.push("選択中の動画形式は、このブラウザで再生できない可能性があります。H.264のmp4で書き出すと安定しやすいです。");
    }
  }

  if (selectedFile && selectedFile.size > 2 * 1024 * 1024 * 1024) {
    notes.push("選択中の動画ファイルが2GBを超えています。SSD上に置き、事前に通し再生してください。");
  }

  if (videoDimensions) {
    const is4K = videoDimensions.width >= 3840 || videoDimensions.height >= 2160;
    const isAboveFullHd = videoDimensions.width > 1920 || videoDimensions.height > 1080;

    if (is4K && ((cores !== null && cores < 8) || (memoryGb !== null && memoryGb < 8))) {
      warnings.push("選択中の動画は4K相当です。このPCではコマ落ちする可能性があります。1080p版の動画も用意してください。");
    } else if (isAboveFullHd && ((cores !== null && cores < 6) || (memoryGb !== null && memoryGb < 8))) {
      warnings.push("選択中の動画はフルHDを超えています。このPCでは再生が不安定になる可能性があります。");
    } else if (is4K) {
      notes.push("4K動画はPCやGPUによって差が出ます。撮影前に撮影モードで通し再生してください。");
    }
  }

  const level: SpecLevel = warnings.length > 0 ? "warning" : cores === null || memoryGb === null ? "unknown" : "ok";
  const badgeLabel = level === "warning" ? "注意" : level === "unknown" ? "一部不明" : "目安OK";

  return {
    level,
    badgeLabel,
    cores,
    memoryGb,
    mp4Support,
    webmSupport,
    selectedVideoLabel,
    warnings,
    notes,
  };
}

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const tagName = target.tagName.toLowerCase();
  return (
    target.isContentEditable ||
    tagName === "input" ||
    tagName === "textarea" ||
    tagName === "select" ||
    tagName === "button"
  );
}

function makeLogId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function App() {
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [cueState, setCueStateState] = useState<CueState>("no-video");
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [videoDuration, setVideoDuration] = useState<number | null>(null);
  const [videoDimensions, setVideoDimensions] = useState<VideoDimensions | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [isDragActive, setIsDragActive] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showFullscreenHint, setShowFullscreenHint] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [wakeWordDraft, setWakeWordDraft] = useState("");
  const [voskCacheStatus, setVoskCacheStatus] = useState<"checking" | "not-cached" | "downloading" | "cached" | "error">(
    "checking",
  );
  const [voskDownloadProgress, setVoskDownloadProgress] = useState<string | null>(null);
  const [isLogOpen, setIsLogOpen] = useState(false);
  const [logs, setLogs] = useState<AppLog[]>(() => [
    {
      id: makeLogId(),
      time: new Date().toLocaleTimeString("ja-JP", { hour12: false }),
      level: "info",
      message: "動画を選択すると、最初の画面で待機します。",
    },
  ]);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const cueStateRef = useRef<CueState>("no-video");
  const videoUrlRef = useRef<string | null>(null);
  const delayTimeoutRef = useRef<number | null>(null);
  const delayIntervalRef = useRef<number | null>(null);
  const voiceRecoverTimeoutRef = useRef<number | null>(null);
  const fullscreenHintTimeoutRef = useRef<number | null>(null);
  const voiceServiceRef = useRef<VoiceTriggerService>(createVoiceTriggerService());

  const statusLabel = STATUS_LABELS[cueState];
  const hasErrorLog = logs.some((log) => log.level === "error");

  const addLog = useCallback((message: string, level: AppLog["level"] = "info") => {
    if (level === "error") {
      setIsLogOpen(true);
    }

    setLogs((currentLogs) => [
      {
        id: makeLogId(),
        time: new Date().toLocaleTimeString("ja-JP", { hour12: false }),
        level,
        message,
      },
      ...currentLogs,
    ].slice(0, 80));
  }, []);

  const setCueState = useCallback((nextState: CueState) => {
    cueStateRef.current = nextState;
    setCueStateState(nextState);
  }, []);

  const updateSetting = useCallback(<K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings((currentSettings) => ({
      ...currentSettings,
      [key]: value,
    }));
  }, []);

  const resetVideoToFirstFrame = useCallback(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    video.pause();
    try {
      video.currentTime = 0;
    } catch {
      addLog("動画の先頭へ戻せませんでした。動画を選び直してください。", "warning");
    }
  }, [addLog]);

  const clearDelayTimers = useCallback(() => {
    if (delayTimeoutRef.current !== null) {
      window.clearTimeout(delayTimeoutRef.current);
      delayTimeoutRef.current = null;
    }

    if (delayIntervalRef.current !== null) {
      window.clearInterval(delayIntervalRef.current);
      delayIntervalRef.current = null;
    }

    setCountdown(null);
  }, []);

  const recoverVoiceRecognition = useCallback(
    (reasonLabel: string) => {
      if (!settings.voiceEnabled) {
        return;
      }

      if (voiceRecoverTimeoutRef.current !== null) {
        window.clearTimeout(voiceRecoverTimeoutRef.current);
      }

      voiceRecoverTimeoutRef.current = window.setTimeout(() => {
        voiceRecoverTimeoutRef.current = null;
        voiceServiceRef.current.recover().catch((error: unknown) => {
          addLog(
            `${reasonLabel}後に音声認識を再開できませんでした: ${error instanceof Error ? error.message : String(error)
            }`,
            "warning",
          );
        });
      }, 50);
    },
    [addLog, settings.voiceEnabled],
  );

  const pauseVoiceRecognition = useCallback(() => {
    if (!settings.voiceEnabled) {
      return;
    }

    if (voiceRecoverTimeoutRef.current !== null) {
      window.clearTimeout(voiceRecoverTimeoutRef.current);
      voiceRecoverTimeoutRef.current = null;
    }

    voiceServiceRef.current.pause().catch((error: unknown) => {
      addLog(
        `再生前に音声認識を一時停止できませんでした: ${error instanceof Error ? error.message : String(error)
        }`,
        "warning",
      );
    });
  }, [addLog, settings.voiceEnabled]);

  const startPlayback = useCallback(
    async (sourceLabel: string) => {
      const video = videoRef.current;
      if (!video || !videoUrlRef.current) {
        setCueState("no-video");
        setErrorMessage("先に動画ファイルを選択してください。");
        addLog("動画未選択のため再生できません。", "warning");
        return;
      }

      clearDelayTimers();
      setErrorMessage(null);
      setCueState("playing");
      pauseVoiceRecognition();
      resetVideoToFirstFrame();

      try {
        await video.play();
        addLog(`${sourceLabel}で再生を開始しました。`, "success");
      } catch {
        resetVideoToFirstFrame();
        recoverVoiceRecognition("再生失敗");
        setCueState("error");
        setErrorMessage(
          "動画を再生できませんでした。ブラウザの制限、音声付き動画、または動画形式を確認してください。",
        );
        addLog("再生の開始に失敗しました。動画形式やブラウザ設定を確認してください。", "error");
      }
    },
    [
      addLog,
      clearDelayTimers,
      pauseVoiceRecognition,
      recoverVoiceRecognition,
      resetVideoToFirstFrame,
      setCueState,
    ],
  );

  const triggerPlayback = useCallback(
    (sourceLabel: string) => {
      const currentState = cueStateRef.current;

      if (currentState === "playing" || currentState === "delay") {
        addLog(`${STATUS_LABELS[currentState]}のため、${sourceLabel}のトリガーを無視しました。`, "info");
        return;
      }

      if (!videoUrlRef.current) {
        setCueState("no-video");
        setErrorMessage("先に動画ファイルを選択してください。");
        addLog("動画を選ばずに再生しようとしました。", "warning");
        return;
      }

      resetVideoToFirstFrame();

      if (settings.delaySeconds <= 0) {
        void startPlayback(sourceLabel);
        return;
      }

      const delayMilliseconds = settings.delaySeconds * 1000;
      const targetTime = Date.now() + delayMilliseconds;
      setCueState("delay");
      setErrorMessage(null);
      setCountdown(Math.ceil(settings.delaySeconds));
      addLog(`${sourceLabel}を受け付けました。${settings.delaySeconds}秒後に再生します。`, "info");

      delayIntervalRef.current = window.setInterval(() => {
        const remainingSeconds = Math.max(0, (targetTime - Date.now()) / 1000);
        setCountdown(remainingSeconds > 0 ? Math.ceil(remainingSeconds) : 0);
      }, 100);

      delayTimeoutRef.current = window.setTimeout(() => {
        void startPlayback(sourceLabel);
      }, delayMilliseconds);
    },
    [addLog, resetVideoToFirstFrame, setCueState, settings.delaySeconds, startPlayback],
  );

  const stopAndReturnToIdle = useCallback(
    (message: string) => {
      clearDelayTimers();
      resetVideoToFirstFrame();
      setCueState(videoUrlRef.current ? "idle" : "no-video");
      setErrorMessage(null);
      addLog(message, "info");
      recoverVoiceRecognition("停止");
    },
    [addLog, clearDelayTimers, recoverVoiceRecognition, resetVideoToFirstFrame, setCueState],
  );

  const cancelDelay = useCallback(() => {
    if (cueStateRef.current !== "delay") {
      return;
    }

    stopAndReturnToIdle("遅延再生をキャンセルしました。");
  }, [stopAndReturnToIdle]);

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        setShowFullscreenHint(false);
        return;
      }

      if (!stageRef.current) {
        throw new Error("Stage element is missing");
      }

      await stageRef.current.requestFullscreen();
      setShowFullscreenHint(true);
      if (fullscreenHintTimeoutRef.current !== null) {
        window.clearTimeout(fullscreenHintTimeoutRef.current);
      }
      fullscreenHintTimeoutRef.current = window.setTimeout(() => {
        fullscreenHintTimeoutRef.current = null;
        setShowFullscreenHint(false);
      }, 2000);
    } catch {
      setCueState("error");
      setErrorMessage("撮影モードを開始できませんでした。ブラウザの許可や表示先を確認してください。");
      addLog("撮影モードの開始に失敗しました。", "error");
    }
  }, [addLog, setCueState]);

  const handleFiles = useCallback(
    (fileList: FileList | null) => {
      const file = fileList?.[0];
      if (!file) {
        return;
      }

      const canCheckType = file.type.trim().length > 0;
      if (canCheckType && !file.type.startsWith("video/")) {
        addLog("動画ではない可能性があるファイルです。再生できない場合はmp4やwebmを選んでください。", "warning");
      }

      if (canCheckType) {
        const testVideo = document.createElement("video");
        if (testVideo.canPlayType(file.type) === "") {
          addLog("この動画形式はブラウザで再生できない可能性があります。", "warning");
        }
      }

      if (videoUrlRef.current) {
        URL.revokeObjectURL(videoUrlRef.current);
      }

      clearDelayTimers();
      const nextUrl = URL.createObjectURL(file);
      videoUrlRef.current = nextUrl;
      setVideoUrl(nextUrl);
      setSelectedFile(file);
      setVideoDuration(null);
      setVideoDimensions(null);
      setErrorMessage(null);
      setCueState("idle");
      setCountdown(null);
      addLog(`動画を読み込みました: ${file.name}`, "success");
    },
    [addLog, clearDelayTimers, setCueState],
  );

  const handleVideoMetadata = useCallback(() => {
    const video = videoRef.current;
    setVideoDuration(video?.duration ?? null);
    setVideoDimensions(
      video && video.videoWidth > 0 && video.videoHeight > 0
        ? {
          width: video.videoWidth,
          height: video.videoHeight,
        }
        : null,
    );
  }, []);

  const handleVideoLoaded = useCallback(() => {
    resetVideoToFirstFrame();
    setCueState("idle");
    setErrorMessage(null);
    addLog("動画は最初の画面で待機しています。", "success");
  }, [addLog, resetVideoToFirstFrame, setCueState]);

  const handleVideoError = useCallback(() => {
    setCueState("error");
    setErrorMessage("動画を読み込めませんでした。別のmp4またはwebmファイルで試してください。");
    addLog("動画読み込みエラーが発生しました。", "error");
  }, [addLog, setCueState]);

  const handleVideoEnded = useCallback(() => {
    resetVideoToFirstFrame();
    setCueState("ended");
    setCountdown(null);
    addLog("再生が終了しました。動画は先頭に戻って待機しています。", "success");
    recoverVoiceRecognition("再生終了");
  }, [addLog, recoverVoiceRecognition, resetVideoToFirstFrame, setCueState]);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      setIsDragActive(false);
      handleFiles(event.dataTransfer.files);
    },
    [handleFiles],
  );

  const handleDragOver = useCallback((event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setIsDragActive(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragActive(false);
  }, []);

  const handleDelayInput = useCallback(
    (value: string) => {
      updateSetting("delaySeconds", clampDelay(Number(value)));
    },
    [updateSetting],
  );

  const addWakeWord = useCallback(() => {
    const nextWord = wakeWordDraft.trim();
    if (!nextWord) {
      return;
    }

    if (settings.wakeWords.includes(nextWord)) {
      setWakeWordDraft("");
      return;
    }

    updateSetting("wakeWords", [...settings.wakeWords, nextWord]);
    setWakeWordDraft("");
  }, [settings.wakeWords, updateSetting, wakeWordDraft]);

  const removeWakeWord = useCallback(
    (word: string) => {
      const nextWords = settings.wakeWords.filter((item) => item !== word);
      updateSetting("wakeWords", nextWords.length > 0 ? nextWords : DEFAULT_WAKE_WORDS);
    },
    [settings.wakeWords, updateSetting],
  );

  const checkVoskModelCache = useCallback(async () => {
    if (!("caches" in window)) {
      setVoskCacheStatus("error");
      setVoskDownloadProgress("このブラウザではオフライン保存を利用できません。");
      return;
    }

    const cachedModel = await findCachedVoskModel();
    if (!cachedModel) {
      setVoskCacheStatus("not-cached");
      setVoskDownloadProgress(null);
      return;
    }

    if (cachedModel.cacheName !== VOSK_MODEL_CACHE_NAME) {
      await saveVoskModelResponse(cachedModel.response.clone());
    }

    setVoskCacheStatus("cached");
    setVoskDownloadProgress("オフライン音声認識は準備済みです。");
  }, []);

  const cacheVoskModelForOffline = useCallback(async () => {
    if (!("caches" in window)) {
      setVoskCacheStatus("error");
      setVoskDownloadProgress("このブラウザではオフライン保存を利用できません。");
      addLog("ブラウザがCache Storageに対応していないため、オフライン音声認識データを保存できません。", "warning");
      return;
    }

    const confirmed = window.confirm(
      `オフライン音声認識に必要な日本語データをこのブラウザに保存します。大きなファイル(${VOSK_MODEL_SIZE_LABEL})をダウンロードします。保存しますか？`,
    );
    if (!confirmed) {
      addLog("オフライン音声認識の準備をキャンセルしました。", "info");
      return;
    }

    setVoskCacheStatus("downloading");
    setVoskDownloadProgress("オフライン音声認識データをダウンロード中です。");
    addLog("ユーザーの許可を受けて、オフライン音声認識の準備を開始しました。", "info");

    try {
      await clearVoskModelCaches();

      const downloadUrl = `${VOSK_MODEL_URL}?download=${Date.now()}`;
      const response = await fetch(downloadUrl, { cache: "reload" });
      if (!response.ok) {
        throw new Error(`モデルを取得できませんでした (${response.status})。`);
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/html")) {
        throw new Error("音声認識データではなくHTMLが返されました。公開ファイルの配置を確認してください。");
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("モデルのダウンロード進捗を読み取れませんでした。");
      }

      const chunks: BlobPart[] = [];
      let receivedBytes = 0;
      const headerBytes = Number(response.headers.get("content-length") ?? 0);
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        chunks.push(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
        receivedBytes += value.byteLength;
        if (headerBytes > 0) {
          const percent = Math.min(100, Math.round((receivedBytes / headerBytes) * 100));
          setVoskDownloadProgress(
            `オフライン音声認識データをダウンロード中です。${percent}% (${formatBytes(receivedBytes)} / ${formatBytes(
              headerBytes,
            )})`,
          );
        } else {
          setVoskDownloadProgress(`オフライン音声認識データをダウンロード中です。${formatBytes(receivedBytes)}`);
        }
      }

      const modelBlob = new Blob(chunks, {
        type: response.headers.get("content-type") || "application/gzip",
      });
      await saveVoskModelResponse(
        new Response(modelBlob, {
          headers: {
            "content-type": modelBlob.type,
            "content-length": String(modelBlob.size),
          },
        }),
      );
      setVoskCacheStatus("cached");
      setVoskDownloadProgress("オフライン音声認識は準備済みです。");
      updateSetting("offlineVoskEnabled", true);
      addLog("オフライン音声認識を準備しました。", "success");
    } catch (error) {
      setVoskCacheStatus("error");
      const message = error instanceof Error ? error.message : String(error);
      setVoskDownloadProgress(`オフライン音声認識を準備できませんでした: ${message}`);
      addLog(`オフライン音声認識を準備できませんでした: ${message}`, "error");
    }
  }, [addLog, updateSetting]);

  const selectedFileSummary = useMemo(() => {
    if (!selectedFile) {
      return "未選択";
    }

    return `${selectedFile.name} / ${formatFileSize(selectedFile.size)} / ${formatDuration(videoDuration)}`;
  }, [selectedFile, videoDuration]);

  const specAssessment = useMemo(
    () => assessSpecs(selectedFile, videoDimensions),
    [selectedFile, videoDimensions],
  );

  useEffect(() => {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    checkVoskModelCache().catch((error: unknown) => {
      setVoskCacheStatus("error");
      setVoskDownloadProgress(
        `オフライン音声認識の準備状態を確認できませんでした: ${error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }, [checkVoskModelCache]);

  useEffect(() => {
    return () => {
      clearDelayTimers();
      if (voiceRecoverTimeoutRef.current !== null) {
        window.clearTimeout(voiceRecoverTimeoutRef.current);
      }
      if (videoUrlRef.current) {
        URL.revokeObjectURL(videoUrlRef.current);
      }
    };
  }, [clearDelayTimers]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      const nextIsFullscreen = Boolean(document.fullscreenElement);
      setIsFullscreen(nextIsFullscreen);
      if (!nextIsFullscreen) {
        setShowFullscreenHint(false);
      }
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      if (fullscreenHintTimeoutRef.current !== null) {
        window.clearTimeout(fullscreenHintTimeoutRef.current);
        fullscreenHintTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const editable = isEditableElement(event.target);

      if ((event.code === "Space" || event.key === "Enter") && editable) {
        return;
      }

      if ((event.key.toLowerCase() === "m" || event.key.toLowerCase() === "f") && editable) {
        return;
      }

      if (event.code === "Space" || event.key === "Enter") {
        event.preventDefault();
        triggerPlayback(event.code === "Space" ? "Spaceキー" : "Enterキー");
        return;
      }

      if (event.key === "Escape") {
        if (cueStateRef.current === "delay") {
          event.preventDefault();
          cancelDelay();
          return;
        }

        if (cueStateRef.current === "playing") {
          event.preventDefault();
          stopAndReturnToIdle("Escキーで停止し、先頭へ戻しました。");
        }

        return;
      }

      if (event.key.toLowerCase() === "m") {
        event.preventDefault();
        updateSetting("mirror", !settings.mirror);
        addLog(!settings.mirror ? "左右反転をONにしました。" : "左右反転をOFFにしました。", "info");
        return;
      }

      if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        void toggleFullscreen();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [
    addLog,
    cancelDelay,
    settings.mirror,
    stopAndReturnToIdle,
    toggleFullscreen,
    triggerPlayback,
    updateSetting,
  ]);

  useEffect(() => {
    const service = voiceServiceRef.current;

    if (!settings.voiceEnabled) {
      if (voiceRecoverTimeoutRef.current !== null) {
        window.clearTimeout(voiceRecoverTimeoutRef.current);
        voiceRecoverTimeoutRef.current = null;
      }
      void service.stop();
      return;
    }

    service
      .start(
        { wakeWords: settings.wakeWords },
        {
          onStatus: (message) => addLog(message, "info"),
          onResult: (result) => {
            const suffix = result.matchedWakeWord ? ` / 一致: ${result.matchedWakeWord}` : "";
            const phase = result.isFinal ? "確定" : "途中";
            addLog(
              `音声認識 (${result.engine} / ${phase}): ${result.text}${suffix}`,
              result.matchedWakeWord ? "success" : "info",
            );
            if (result.matchedWakeWord) {
              triggerPlayback("声で再生");
            }
          },
          onError: (message) => addLog(message, "warning"),
        },
      )
      .catch((error: unknown) => {
        addLog(
          `音声認識を開始できませんでした: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
      });

    return () => {
      void service.stop();
    };
  }, [addLog, settings.voiceEnabled, settings.wakeWords, triggerPlayback]);

  return (
    <div className="appShell">
      <header className="appHeader">
        <div>
          <h2>Projection Cue Player</h2>
          <p className="lead">
            選んだ動画を音声/スペース/エンター/クリックで再生する撮影現場向けキュー再生アプリ
          </p>
        </div>
        <div
          className={`statusBadge status-${cueState}`}
          aria-live="polite"
          title="現在の再生状態です。動画未選択、待機中、遅延中、再生中、終了後待機、エラーを表示します。"
        >
          <span>現在状態</span>
          <strong>{statusLabel}</strong>
        </div>
      </header>

      <main className="workspace">
        <section className="controlPanel" aria-label="操作パネル" title="動画選択、再生、撮影モード、表示設定を行う操作パネルです。">
          <div
            className={`dropZone ${isDragActive ? "isDragActive" : ""}`}
            title="再生したい動画ファイルを選択、またはここへドラッグ&ドロップします。動画はアップロードされません。"
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
          >
            <input
              id="video-file"
              className="fileInput"
              type="file"
              accept="video/mp4,video/webm,video/*"
              onChange={(event) => handleFiles(event.currentTarget.files)}
            />
            <label
              className="fileButton"
              htmlFor="video-file"
              title="PC内の動画ファイルを1本選択します。mp4やwebmなど、ブラウザで再生できる形式を選んでください。"
            >
              動画ファイルを選択
            </label>
            <p>またはここへドラッグ&ドロップ</p>
            <small>選択した動画はアップロードされません。ブラウザ上でローカル再生します。</small>
          </div>

          <div className="fileSummary" title="現在選択されている動画ファイルの名前、容量、長さを表示します。">
            <span>選択中</span>
            <strong>{selectedFileSummary}</strong>
          </div>

          <details
            className={`specPanel spec-${specAssessment.level}`}
            open={specAssessment.level === "warning"}
            title="このPCで動画再生に使える目安情報と、推奨スペックを確認できます。"
          >
            <summary>
              <span>PCスペック目安</span>
              <strong>{specAssessment.badgeLabel}</strong>
            </summary>

            {specAssessment.warnings.length > 0 ? (
              <div className="specWarning" role="alert">
                <strong>このPCでは再生が不安定になる可能性があります。</strong>
                {specAssessment.warnings.map((warning) => (
                  <p key={warning}>{warning}</p>
                ))}
              </div>
            ) : (
              <p className="specOk">
                取得できた範囲では大きな問題は見つかっていません。撮影前に、実際の動画を撮影モードで通し再生してください。
              </p>
            )}

            <div className="specInfoGrid">
              <div>
                <span>CPU</span>
                <strong>{specAssessment.cores === null ? "取得できません" : `${specAssessment.cores} 論理コア`}</strong>
              </div>
              <div>
                <span>メモリ</span>
                <strong>{specAssessment.memoryGb === null ? "取得できません" : `${specAssessment.memoryGb} GB以上`}</strong>
              </div>
              <div>
                <span>mp4</span>
                <strong>{describeCanPlay(specAssessment.mp4Support)}</strong>
              </div>
              <div>
                <span>webm</span>
                <strong>{describeCanPlay(specAssessment.webmSupport)}</strong>
              </div>
              <div className="specInfoWide">
                <span>選択中の動画</span>
                <strong>{specAssessment.selectedVideoLabel}</strong>
              </div>
            </div>

            {specAssessment.notes.length > 0 ? (
              <div className="specNotes">
                {specAssessment.notes.map((note) => (
                  <p key={note}>{note}</p>
                ))}
              </div>
            ) : null}

            <div className="specLists">
              <div>
                <h3>最低目安</h3>
                {MINIMUM_SPEC_ITEMS.map((item) => (
                  <p key={item}>{item}</p>
                ))}
              </div>
              <div>
                <h3>推奨スペック</h3>
                {RECOMMENDED_SPEC_ITEMS.map((item) => (
                  <p key={item}>{item}</p>
                ))}
              </div>
            </div>
          </details>

          <div className="controlGroup controlGroup-live">
            <h2>本番操作</h2>
            <button
              className="primaryButton"
              type="button"
              title="動画を先頭から1回再生します。再生中や遅延中に押しても追加再生はされません。"
              onClick={() => triggerPlayback("再生ボタン")}
            >
              再生
            </button>

            <div className="buttonRow">
              <button
                className="secondaryButton"
                type="button"
                title="動画プレビューを画面いっぱいに表示します。撮影モード中はEscキーで戻れます。"
                onClick={() => void toggleFullscreen()}
              >
                {isFullscreen ? "撮影モード終了" : "撮影モードへ"}
              </button>
              <button
                className="secondaryButton"
                type="button"
                title="再生中の動画や遅延待ちを止めて、動画を先頭に戻します。"
                onClick={() =>
                  cueStateRef.current === "delay" ? cancelDelay() : stopAndReturnToIdle("停止して先頭へ戻しました。")
                }
              >
                停止して先頭へ
              </button>
            </div>
          </div>

          <div className="controlGroup settingsGrid">
            <h2>準備設定</h2>
            <label className="settingItem" title="再生操作を受けてから、実際に動画が始まるまでの待ち時間を秒で指定します。">
              <span>再生遅延（秒）</span>
              <input
                type="number"
                title="0から10秒まで指定できます。0ならすぐ再生します。"
                min="0"
                max="10"
                step="0.1"
                value={settings.delaySeconds}
                onChange={(event) => handleDelayInput(event.currentTarget.value)}
              />
            </label>

            <label className="toggleItem" title="プロジェクターや撮影用途に合わせて、動画を左右反転して表示します。Mキーでも切り替えできます。">
              <input
                type="checkbox"
                checked={settings.mirror}
                onChange={(event) => updateSetting("mirror", event.currentTarget.checked)}
              />
              <span>左右反転</span>
            </label>

            <fieldset className="segmentedControl" title="動画を枠内に収めるか、画面いっぱいに切り抜いて表示するかを選びます。">
              <legend>動画の表示</legend>
              {(["contain", "cover"] satisfies ObjectFitMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  title={
                    mode === "contain"
                      ? "動画全体が見えるように表示します。余白が出る場合があります。"
                      : "画面いっぱいに表示します。動画の端が切れる場合があります。"
                  }
                  className={settings.objectFit === mode ? "isSelected" : ""}
                  onClick={() => updateSetting("objectFit", mode)}
                >
                  {OBJECT_FIT_LABELS[mode]}
                </button>
              ))}
            </fieldset>

            <fieldset className="segmentedControl" title="再生待機中に、黒背景で隠すか動画の最初の画面を見せるかを選びます。">
              <legend>待機中の表示</legend>
              {(["black", "first-frame"] satisfies WaitDisplayMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  title={
                    mode === "black"
                      ? "再生待機中は黒背景にします。初期設定です。"
                      : "再生待機中に動画の最初の画面を表示します。"
                  }
                  className={settings.waitDisplayMode === mode ? "isSelected" : ""}
                  onClick={() => updateSetting("waitDisplayMode", mode)}
                >
                  {WAIT_DISPLAY_LABELS[mode]}
                </button>
              ))}
            </fieldset>

            <label className="toggleItem" title="投影画面下部に、動画選択状況、左右反転、動画の表示設定を表示します。通常はOFFです。">
              <input
                type="checkbox"
                checked={settings.showStageOverlay}
                onChange={(event) => updateSetting("showStageOverlay", event.currentTarget.checked)}
              />
              <span>投影画面の情報</span>
            </label>

            <label className="toggleItem" title="再生遅延があるときに、再生までのカウント数字を表示します。">
              <input
                type="checkbox"
                checked={settings.showCountdown}
                onChange={(event) => updateSetting("showCountdown", event.currentTarget.checked)}
              />
              <span>カウントを表示</span>
            </label>
          </div>

          <details className="futurePanel" title="声で再生するための設定を開きます。">
            <summary title="声で再生するためのON/OFF、オフライン準備、ウェイクワードを設定します。">声で再生</summary>
            <label className="toggleItem" title="マイク入力で再生するかどうかを切り替えます。">
              <input
                type="checkbox"
                checked={settings.voiceEnabled}
                onChange={(event) => updateSetting("voiceEnabled", event.currentTarget.checked)}
              />
              <span>声で再生</span>
            </label>
            <p className="voiceHint" title="オフライン用の音声認識データが使える場合はそれを優先し、使えない場合は対応ブラウザの音声認識へ切り替えます。">
              ウェイクワードを聞き取ると再生します。オフライン準備済みならネットなしでも使えます。
            </p>
            <div className="voskOfflinePanel" title="オフライン用の音声認識データをブラウザに保存すると、ネットがない環境でも声で再生を使いやすくなります。">
              <div>
                <strong>オフライン音声認識</strong>
                <span>
                  {voskCacheStatus === "cached"
                    ? "準備済み"
                    : voskCacheStatus === "downloading"
                      ? "保存中"
                      : voskCacheStatus === "checking"
                        ? "確認中"
                        : "未準備"}
                </span>
              </div>
              <button
                type="button"
                title="オフライン音声認識に必要な日本語データをこのブラウザに保存、または再保存します。"
                disabled={voskCacheStatus === "downloading" || voskCacheStatus === "checking"}
                onClick={() => void cacheVoskModelForOffline()}
              >
                {voskCacheStatus === "cached" ? "再準備" : "オフライン準備"}
              </button>
            </div>
            {voskDownloadProgress ? <p className="voiceHint">{voskDownloadProgress}</p> : null}
            <div className="wakeWordEditor">
              <input
                type="text"
                value={wakeWordDraft}
                placeholder="ウェイクワード"
                title="音声認識で再生トリガーにしたい短い言葉を入力します。"
                onChange={(event) => setWakeWordDraft(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addWakeWord();
                  }
                }}
              />
              <button type="button" title="入力したウェイクワードを一覧に追加します。" onClick={addWakeWord}>
                追加
              </button>
            </div>
            <div className="wakeWordList">
              {settings.wakeWords.map((word) => (
                <button
                  key={word}
                  type="button"
                  title={`ウェイクワード「${word}」を削除します。`}
                  onClick={() => removeWakeWord(word)}
                >
                  {word} ×
                </button>
              ))}
            </div>
          </details>
        </section>

        <section
          ref={stageRef}
          className="previewStage"
          aria-label="動画プレビュー"
          title="動画のプレビュー領域です。クリックまたはタップで再生できます。"
          onClick={(event) => {
            if (isEditableElement(event.target)) {
              return;
            }

            triggerPlayback("クリック/タップ");
          }}
        >
          <div
            className={`videoFrame ${videoUrl && cueState !== "playing" && settings.waitDisplayMode === "black" ? "isBlackWaiting" : ""
              }`}
          >
            {videoUrl ? (
              <video
                ref={videoRef}
                src={videoUrl}
                preload="auto"
                playsInline
                onLoadedData={handleVideoLoaded}
                onLoadedMetadata={handleVideoMetadata}
                onError={handleVideoError}
                onEnded={handleVideoEnded}
                style={{
                  objectFit: settings.objectFit,
                  transform: settings.mirror ? "scaleX(-1)" : undefined,
                }}
              />
            ) : (
              <div className="emptyPreview">
                <strong>動画未選択</strong>
                <span>mp4 / webm など、ブラウザで再生できる動画を選んでください。</span>
              </div>
            )}

            {cueState === "delay" && countdown !== null && settings.showCountdown ? (
              <div className="countdownOverlay" aria-live="assertive">
                <span>再生まで</span>
                <strong>{countdown}</strong>
              </div>
            ) : null}

            {settings.showStageOverlay ? (
              <div className="stageOverlay">
                <span>{selectedFile ? "動画選択済み" : "動画未選択"}</span>
                <span>{settings.mirror ? "左右反転 ON" : "左右反転 OFF"}</span>
                <span>{OBJECT_FIT_LABELS[settings.objectFit]}</span>
              </div>
            ) : null}

            {showFullscreenHint ? (
              <div className="fullscreenHint" aria-live="polite">
                Escキーで撮影モードを終了できます
              </div>
            ) : null}
          </div>
        </section>
      </main>

      {errorMessage ? <div className="errorBanner" title="現在発生しているエラー内容です。">{errorMessage}</div> : null}

      <details
        className="logPanel"
        aria-label="簡易ログ"
        open={isLogOpen}
        title="アプリの操作結果やエラーを確認できます。通常は折りたたまれています。"
        onToggle={(event) => setIsLogOpen(event.currentTarget.open)}
      >
        <summary className="logSummary" title="クリックすると簡易ログを開閉します。">
          <span>簡易ログ</span>
          {hasErrorLog ? <span className="logAlertBadge">エラーあり</span> : null}
          <button
            type="button"
            title="表示されているログを消去します。"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setLogs([]);
            }}
          >
            クリア
          </button>
        </summary>
        <div className="logList" aria-live="polite">
          {logs.length === 0 ? (
            <p className="emptyLog">ログはありません。</p>
          ) : (
            logs.map((log) => (
              <p key={log.id} className={`logItem log-${log.level}`}>
                <time>{log.time}</time>
                <span>{log.message}</span>
              </p>
            ))
          )}
        </div>
      </details>

      <footer className="appFooter">
        <span title="現在のアプリバージョンです。">Projection Cue Player {APP_VERSION}</span>
        <span>
          開発者: 五味[
          <a href="https://x.com/GomiHgy" target="_blank" rel="noreferrer" title="開発者のXプロフィールを開きます。">
            @GomiHgy
          </a>
          ]
        </span>
      </footer>
    </div>
  );
}

export default App;
