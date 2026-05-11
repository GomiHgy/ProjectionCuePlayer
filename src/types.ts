export type CueState = "no-video" | "idle" | "delay" | "playing" | "ended" | "error";

export type ObjectFitMode = "contain" | "cover";

export type WaitDisplayMode = "black" | "first-frame";

export type AppSettings = {
  delaySeconds: number;
  mirror: boolean;
  objectFit: ObjectFitMode;
  showStageOverlay: boolean;
  waitDisplayMode: WaitDisplayMode;
  showCountdown: boolean;
  offlineVoskEnabled: boolean;
  voiceEnabled: boolean;
  wakeWords: string[];
};

export type LogLevel = "info" | "warning" | "error" | "success";

export type AppLog = {
  id: string;
  time: string;
  level: LogLevel;
  message: string;
};
