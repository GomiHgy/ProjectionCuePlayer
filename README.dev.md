# Projection Cue Player 開発者向けREADME

このファイルは開発者向けのセットアップ、構成、デプロイ、ロードマップをまとめたものです。一般ユーザー向けの使い方は [README.md](README.md) を見てください。

## 使用技術

- Vite
- React
- TypeScript
- Web Fullscreen API
- File API / URL.createObjectURL
- localStorage
- Web App Manifest
- Service Worker
- vosk-browser

## セットアップ

```bash
npm install
npm run dev
```

本番用の静的ファイルを作る場合:

```bash
npm run build
```

生成された `dist/` を GitHub Pages / Cloudflare Pages / Vercel / Netlify などに配置すれば動きます。

## ディレクトリ構成

```text
.
├── .github/
│   └── workflows/
│       └── pages.yml
├── public/
│   ├── icons/
│   ├── vosk/
│   ├── manifest.webmanifest
│   └── sw.js
├── src/
│   ├── services/
│   │   └── voiceTrigger.ts
│   ├── App.tsx
│   ├── main.tsx
│   ├── styles.css
│   └── types.ts
├── index.html
├── package.json
├── README.md
├── README.dev.md
├── tsconfig*.json
└── vite.config.ts
```

## 主要コンポーネント

- `src/App.tsx`: 動画選択、状態管理、再生トリガー、撮影モード、設定保存、ログ表示
- `src/services/voiceTrigger.ts`: Vosk優先、Web Speech APIフォールバックの音声トリガーサービス
- `public/sw.js`: アプリ本体とVoskモデルキャッシュのService Worker
- `public/manifest.webmanifest`: PWAインストール用Manifest
- `.github/workflows/pages.yml`: GitHub Pagesデプロイ用Workflow

## 状態管理

動画キューの状態は以下に集約しています。

- `no-video`: 動画未選択
- `idle`: 動画の最初の画面で待機中
- `delay`: 再生遅延カウント中
- `playing`: 再生中
- `ended`: 再生終了後、先頭に戻って待機中
- `error`: エラー表示中

ボタン、Space、Enter、クリック、タップ、音声入力は、同じ `triggerPlayback()` を通る構造です。再生中または遅延中の追加トリガーは無視します。

待機中の動画は内部的には常に先頭へ戻します。表示だけを黒背景または動画の最初の画面に切り替えるため、再生開始時の挙動は同じです。

## Vosk日本語モデル

Voskを使う場合は、以下のファイルを配置してください。

```text
public/vosk/vosk-model-small-ja-0.22.tar.gz
```

このリポジトリでは、ブラウザ用に `model/` ルートの `.tar.gz` として配置します。アプリはユーザーが「オフライン準備」を押して許可した場合だけ、このモデルをCache Storageへ保存します。

モデルファイルがない場合、対応ブラウザではWeb Speech APIへフォールバックします。動画ファイルはService Workerでキャッシュしません。

## GitHub Pagesデプロイ

このリポジトリには `.github/workflows/pages.yml` を追加済みです。

1. GitHubの `Settings` → `Pages` を開きます。
2. `Build and deployment` の `Source` を `GitHub Actions` にします。
3. `main` ブランチへpushします。
4. `Actions` タブで `Deploy to GitHub Pages` が成功することを確認します。
5. `https://<ユーザー名>.github.io/<リポジトリ名>/` で公開ページを確認します。

Workflowでは次の処理を行います。

- `npm ci`
- `npm run build`
- `dist/` をPages artifactとしてアップロード
- GitHub Pagesへデプロイ

`vite.config.ts` は `base: "./"` のため、GitHub Pagesのサブパス公開でも動く構成です。

## その他のデプロイ

### Cloudflare Pages

- Build command: `npm run build`
- Build output directory: `dist`

### Vercel

- Framework Preset: Vite
- Build Command: `npm run build`
- Output Directory: `dist`

### Netlify

- Build command: `npm run build`
- Publish directory: `dist`

## ロードマップ

### Phase 1: Web MVP

- [x] 動画1本読み込み
- [x] 動画の最初の画面で待機
- [x] トリガー再生
- [x] 終了後リセット
- [x] 遅延再生
- [x] 左右反転
- [x] 撮影モード
- [x] キーボード操作
- [x] 投影画面の情報の表示/非表示
- [x] 待機中表示の黒背景/動画の最初の画面切り替え
- [x] 遅延カウントの表示/非表示
- [x] 簡易ログ
- [x] localStorage設定保存

### Phase 2: PWA化

- [x] Web App Manifest
- [x] アプリとしてインストールできる構成
- [x] Service Worker
- [x] アプリ本体の再訪時キャッシュ
- [x] PWA用PNGアイコンの追加

### Phase 3: Vosk日本語音声トリガー

- [x] 声で再生ON/OFFの設定保存
- [x] ウェイクワード設定値の保存
- [x] VoiceTriggerServiceインターフェース
- [x] Voskブラウザ実装
- [x] Web Speech APIフォールバック
- [x] `public/vosk/vosk-model-small-ja-0.22.tar.gz` 配置
- [x] 認識結果ログ
- [x] ウェイクワード一致時の再生連携
- [x] マイク権限エラー表示
- [x] ユーザー許可後のオフライン音声認識データ保存
- [x] オフラインVoskモデルのCache Storage利用

後回しにすること:

- 英語モデル対応
- 中国語モデル対応
- 複数言語同時対応
- モデル自動切り替え
- 複雑な自然言語認識
- 高精度な発話区間検出

### Phase 4: デスクトップ版・常設運用

- [ ] Tauri版
- [ ] Electron版
- [ ] Windows向けインストーラー
- [ ] Mac向けアプリ配布
- [ ] オフライン常設モード
- [ ] スタジオ向けプリセット管理
- [ ] 複数動画キュー対応
- [ ] プロジェクター別設定
- [ ] MIDI / OSC / Stream Deck / Bluetoothリモコン対応
- [ ] Chrome拡張化

## バージョンと開発者

- Version: v0.1.0
- Developer: 五味 [@GomiHgy](https://x.com/GomiHgy)
