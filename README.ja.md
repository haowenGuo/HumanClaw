<div align="center">
  <h1>HumanClaw</h1>
  <p><strong>デスクトップペットの前面 UI + OpenClaw のアシスタント橋渡し層。</strong></p>
  <p>HumanClaw は VRM アバター、トレイ、チャット、デスクトップ操作を担当し、OpenClaw はセッション、Agent 実行、ツール呼び出し、長時間タスクを担当します。</p>
  <p>
    <a href="README.md">English</a> ·
    <a href="README.zh-CN.md">简体中文</a> ·
    <a href="README.ja.md">日本語</a>
  </p>
</div>

---

## このリポジトリに含まれるもの

このリポジトリには、現在 2 つの成果物があります。

1. **HumanClaw デスクトップアプリ**
   - 透明なデスクトップペット
   - 独立したチャットウィンドウ
   - コントロールパネルと初回セットアップ
   - companion backend と local OpenClaw の切り替え

2. **OpenClaw Runtime インストーラ**
   - HumanClaw 用の OpenClaw runtime をまとめた Windows インストーラ / portable パッケージ
   - コードは [`openclaw-installer/`](./openclaw-installer)
   - 上流 OpenClaw の完全なソースツリーは同梱していません

## 役割分担

- **HumanClaw**: アバター描画、トレイ、チャット UI、音声まわり、デスクトップ体験
- **OpenClaw**: Gateway、session、Agent runtime、tool 実行、タスク制御

## 実行モード

- **`companion-service`**
  - companion backend を利用
  - 軽い会話と companion 体験向け

- **`openclaw-local`**
  - ローカル OpenClaw Gateway に接続
  - session / tools / background work は OpenClaw 側が担当

## クイックスタート

```bash
pnpm install
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
pnpm desktop:dev
```

ローカル OpenClaw と接続する場合:

```bash
openclaw gateway --profile source-dev
set AIGRIL_OPENCLAW_GATEWAY_URL=ws://127.0.0.1:19011
pnpm exec electron .
```

Windows パッケージ:

```bash
pnpm desktop:package
pnpm openclaw:prepare-runtime
pnpm openclaw:package-installer
```

## リポジトリ構成

```text
backend/             FastAPI companion backend
electron/            Electron main / preload / OpenClaw bridge
openclaw-installer/  OpenClaw Runtime installer shell
src/                 avatar runtime / chat runtime / control UI
Resources/           VRM model and motion assets
scripts/             packaging helpers
```

## 補足

互換性のため、既存の `AIGRIL_*` 環境変数と `aigril:*` IPC 名は当面維持しています。  
OpenClaw 関連の詳細は [`openclaw-installer/README.md`](./openclaw-installer/README.md) を参照してください。
