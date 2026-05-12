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

async function clearVoskModelCaches(): Promise<void> {
  navigator.serviceWorker?.controller?.postMessage({ type: "CLEAR_VOSK_CACHE" });
  const absoluteVoskModelUrl = new URL(VOSK_MODEL_URL, window.location.href).href;

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
  const [logs, setLogs] = useState<AppLog[]>(() => [
    {
      id: makeLogId(),
      time: new Date().toLocaleTimeString("ja-JP", { hour12: false }),
      level: "info",
      message: "動画を選択すると、1コマ目で待機します。",
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

  const addLog = useCallback((message: string, level: AppLog["level"] = "info") => {
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
            `${reasonLabel}後に音声認識を再開できませんでした: ${
              error instanceof Error ? error.message : String(error)
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
        `再生前に音声認識を一時停止できませんでした: ${
          error instanceof Error ? error.message : String(error)
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
      setErrorMessage("フルスクリーンを開始できませんでした。ブラウザの許可や表示先を確認してください。");
      addLog("フルスクリーン開始に失敗しました。", "error");
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
  }, []);

  const handleVideoLoaded = useCallback(() => {
    resetVideoToFirstFrame();
    setCueState("idle");
    setErrorMessage(null);
    addLog("動画は1コマ目で待機しています。", "success");
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

    const cache = await caches.open(VOSK_MODEL_CACHE_NAME);
    const cachedResponse =
      (await cache.match(VOSK_MODEL_URL)) ??
      (await cache.match(new URL(VOSK_MODEL_URL, window.location.href).href));
    if (!cachedResponse) {
      setVoskCacheStatus("not-cached");
      setVoskDownloadProgress(null);
      return;
    }

    setVoskCacheStatus("cached");
    setVoskDownloadProgress("Voskモデルはオフライン用に保存済みです。");
  }, []);

  const cacheVoskModelForOffline = useCallback(async () => {
    if (!("caches" in window)) {
      setVoskCacheStatus("error");
      setVoskDownloadProgress("このブラウザではオフライン保存を利用できません。");
      addLog("ブラウザがCache Storageに対応していないため、Voskモデルを保存できません。", "warning");
      return;
    }

    const confirmed = window.confirm(
      `Vosk日本語モデルをこのブラウザに保存します。大きなファイル(${VOSK_MODEL_SIZE_LABEL})をダウンロードします。オフライン音声認識のために保存しますか？`,
    );
    if (!confirmed) {
      addLog("Voskモデルのオフライン保存をキャンセルしました。", "info");
      return;
    }

    setVoskCacheStatus("downloading");
    setVoskDownloadProgress("Voskモデルをダウンロード中です。");
    addLog("ユーザーの許可を受けて、Voskモデルのオフライン保存を開始しました。", "info");

    try {
      await clearVoskModelCaches();

      const cache = await caches.open(VOSK_MODEL_CACHE_NAME);
      const downloadUrl = `${VOSK_MODEL_URL}?download=${Date.now()}`;
      const response = await fetch(downloadUrl, { cache: "reload" });
      if (!response.ok) {
        throw new Error(`モデルを取得できませんでした (${response.status})。`);
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/html")) {
        throw new Error("VoskモデルではなくHTMLが返されました。公開ファイルの配置を確認してください。");
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
            `Voskモデルをダウンロード中です。${percent}% (${formatBytes(receivedBytes)} / ${formatBytes(
              headerBytes,
            )})`,
          );
        } else {
          setVoskDownloadProgress(`Voskモデルをダウンロード中です。${formatBytes(receivedBytes)}`);
        }
      }

      const modelBlob = new Blob(chunks, {
        type: response.headers.get("content-type") || "application/gzip",
      });
      await cache.put(
        new URL(VOSK_MODEL_URL, window.location.href).href,
        new Response(modelBlob, {
          headers: {
            "content-type": modelBlob.type,
            "content-length": String(modelBlob.size),
          },
        }),
      );
      setVoskCacheStatus("cached");
      setVoskDownloadProgress("Voskモデルはオフライン用に保存済みです。");
      updateSetting("offlineVoskEnabled", true);
      addLog("Voskモデルをオフライン用に保存しました。", "success");
    } catch (error) {
      setVoskCacheStatus("error");
      const message = error instanceof Error ? error.message : String(error);
      setVoskDownloadProgress(`Voskモデルを保存できませんでした: ${message}`);
      addLog(`Voskモデルを保存できませんでした: ${message}`, "error");
    }
  }, [addLog, updateSetting]);

  const selectedFileSummary = useMemo(() => {
    if (!selectedFile) {
      return "未選択";
    }

    return `${selectedFile.name} / ${formatFileSize(selectedFile.size)} / ${formatDuration(videoDuration)}`;
  }, [selectedFile, videoDuration]);

  useEffect(() => {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    checkVoskModelCache().catch((error: unknown) => {
      setVoskCacheStatus("error");
      setVoskDownloadProgress(
        `Voskモデルの保存状態を確認できませんでした: ${error instanceof Error ? error.message : String(error)}`,
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
              triggerPlayback("音声トリガー");
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
          <p className="eyebrow">Projector Video Cue</p>
          <h1>Projection Cue Player</h1>
          <p className="lead">
            動画を選んで、フルスクリーンにして、Space / Enter / クリックで再生する撮影現場向けキュー再生アプリです。
          </p>
        </div>
        <div className={`statusBadge status-${cueState}`} aria-live="polite">
          <span>現在状態</span>
          <strong>{statusLabel}</strong>
        </div>
      </header>

      <main className="workspace">
        <section className="controlPanel" aria-label="操作パネル">
          <div
            className={`dropZone ${isDragActive ? "isDragActive" : ""}`}
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
            <label className="fileButton" htmlFor="video-file">
              動画ファイルを選択
            </label>
            <p>またはここへドラッグ&ドロップ</p>
            <small>選択した動画はアップロードされません。ブラウザ上でローカル再生します。</small>
          </div>

          <div className="fileSummary">
            <span>選択中</span>
            <strong>{selectedFileSummary}</strong>
          </div>

          <button className="primaryButton" type="button" onClick={() => triggerPlayback("再生ボタン")}>
            再生
          </button>

          <div className="buttonRow">
            <button className="secondaryButton" type="button" onClick={() => void toggleFullscreen()}>
              {isFullscreen ? "フルスクリーン解除" : "フルスクリーン開始"}
            </button>
            <button
              className="secondaryButton"
              type="button"
              onClick={() =>
                cueStateRef.current === "delay" ? cancelDelay() : stopAndReturnToIdle("停止して先頭へ戻しました。")
              }
            >
              停止して先頭へ
            </button>
          </div>

          <div className="settingsGrid">
            <label className="settingItem">
              <span>再生遅延（秒）</span>
              <input
                type="number"
                min="0"
                max="10"
                step="0.1"
                value={settings.delaySeconds}
                onChange={(event) => handleDelayInput(event.currentTarget.value)}
              />
            </label>

            <label className="toggleItem">
              <input
                type="checkbox"
                checked={settings.mirror}
                onChange={(event) => updateSetting("mirror", event.currentTarget.checked)}
              />
              <span>左右反転</span>
            </label>

            <fieldset className="segmentedControl">
              <legend>表示方法</legend>
              {(["contain", "cover"] satisfies ObjectFitMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={settings.objectFit === mode ? "isSelected" : ""}
                  onClick={() => updateSetting("objectFit", mode)}
                >
                  {mode}
                </button>
              ))}
            </fieldset>

            <fieldset className="segmentedControl">
              <legend>待機画面</legend>
              {(
                [
                  ["black", "黒背景"],
                  ["first-frame", "1コマ目"],
                ] satisfies Array<[WaitDisplayMode, string]>
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  className={settings.waitDisplayMode === mode ? "isSelected" : ""}
                  onClick={() => updateSetting("waitDisplayMode", mode)}
                >
                  {label}
                </button>
              ))}
            </fieldset>

            <label className="toggleItem">
              <input
                type="checkbox"
                checked={settings.showStageOverlay}
                onChange={(event) => updateSetting("showStageOverlay", event.currentTarget.checked)}
              />
              <span>画面下部情報を表示</span>
            </label>

            <label className="toggleItem">
              <input
                type="checkbox"
                checked={settings.showCountdown}
                onChange={(event) => updateSetting("showCountdown", event.currentTarget.checked)}
              />
              <span>遅延カウントを表示</span>
            </label>
          </div>

          <details className="futurePanel">
            <summary>音声トリガー設定</summary>
            <label className="toggleItem">
              <input
                type="checkbox"
                checked={settings.voiceEnabled}
                onChange={(event) => updateSetting("voiceEnabled", event.currentTarget.checked)}
              />
              <span>音声認識ON/OFF</span>
            </label>
            <p className="voiceHint">Voskモデルがある場合はVosk、ない場合は対応ブラウザの音声認識に切り替えます。</p>
            <div className="voskOfflinePanel">
              <div>
                <strong>オフライン音声認識</strong>
                <span>
                  {voskCacheStatus === "cached"
                    ? "Voskモデル保存済み"
                    : voskCacheStatus === "downloading"
                      ? "保存中"
                      : voskCacheStatus === "checking"
                        ? "確認中"
                        : "Voskモデル未保存"}
                </span>
              </div>
              <button
                type="button"
                disabled={voskCacheStatus === "downloading" || voskCacheStatus === "checking"}
                onClick={() => void cacheVoskModelForOffline()}
              >
                {voskCacheStatus === "cached" ? "再保存" : "Voskモデルを保存"}
              </button>
            </div>
            {voskDownloadProgress ? <p className="voiceHint">{voskDownloadProgress}</p> : null}
            <div className="wakeWordEditor">
              <input
                type="text"
                value={wakeWordDraft}
                placeholder="ウェイクワード"
                onChange={(event) => setWakeWordDraft(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addWakeWord();
                  }
                }}
              />
              <button type="button" onClick={addWakeWord}>
                追加
              </button>
            </div>
            <div className="wakeWordList">
              {settings.wakeWords.map((word) => (
                <button key={word} type="button" onClick={() => removeWakeWord(word)}>
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
          onClick={(event) => {
            if (isEditableElement(event.target)) {
              return;
            }

            triggerPlayback("クリック/タップ");
          }}
        >
          <div
            className={`videoFrame ${
              videoUrl && cueState !== "playing" && settings.waitDisplayMode === "black" ? "isBlackWaiting" : ""
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
                <span>{settings.objectFit}</span>
              </div>
            ) : null}

            {showFullscreenHint ? (
              <div className="fullscreenHint" aria-live="polite">
                Escキーでフルスクリーンを解除できます
              </div>
            ) : null}
          </div>
        </section>
      </main>

      {errorMessage ? <div className="errorBanner">{errorMessage}</div> : null}

      <section className="logPanel" aria-label="簡易ログ">
        <div className="sectionHeader">
          <h2>簡易ログ</h2>
          <button type="button" onClick={() => setLogs([])}>
            クリア
          </button>
        </div>
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
      </section>
    </div>
  );
}

export default App;
