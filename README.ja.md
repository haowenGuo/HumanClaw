<div align="center">
  <h1>HumanClaw</h1>
  <p><strong>AIGril のデスクトップ系ランタイムから独立した、3D VRM デスクトップペット兼 OpenClaw フロントエンドです。</strong></p>
  <p>
    <a href="README.md">English</a> ·
    <a href="README.zh-CN.md">简体中文</a> ·
    <a href="README.ja.md">日本語</a>
  </p>
</div>

---

## 概要

HumanClaw は、以前の AIGril プロジェクトから切り出したデスクトップ向けリポジトリです。

このリポジトリには、VRM アバター実行系、Electron デスクトップペット、チャットウィンドウ、そして OpenClaw Gateway へのブリッジがまとめられています。

現在は次の 2 つの使い方を想定しています。

- コンパニオンモード: ローカルで動く 3D VRM デスクトップペット
- アシスタントモード: 同じフロントエンドを OpenClaw に接続し、セッションやツール実行は OpenClaw 側に任せる構成

## OpenClaw との役割分担

- HumanClaw は OpenClaw の Gateway や Agent runtime の代替ではありません。
- HumanClaw はアバター描画、デスクトップ操作、トレイ表示、UI 表現を担当します。
- OpenClaw はセッション、イベントストリーム、ツール実行、タスク制御を担当します。

## ローカル実行

```bash
pnpm install
pnpm desktop:start
```

OpenClaw と接続する場合:

```bash
openclaw gateway --profile source-dev
set AIGRIL_OPENCLAW_GATEWAY_URL=ws://127.0.0.1:19011
pnpm exec electron .
```

互換性のため、既存の `AIGRIL_*` 環境変数と `aigril:*` IPC チャネル名は当面そのまま維持しています。
