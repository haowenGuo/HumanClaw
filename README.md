<div align="center">
  <h1>HumanClaw</h1>
  <p><strong>An independent desktop-pet and 3D VRM frontend built from the AIGril runtime, now focused on becoming an OpenClaw-powered desktop assistant.</strong></p>
  <p>
    <a href="README.md">English</a> ·
    <a href="README.zh-CN.md">简体中文</a> ·
    <a href="README.ja.md">日本語</a>
  </p>
</div>

---

## Overview

HumanClaw is the extracted desktop-facing branch of the earlier AIGril project.

This repository keeps the avatar runtime, Electron desktop-pet shell, chat window, and OpenClaw Gateway bridge together in one place so it can evolve as a dedicated Windows assistant product.

Today the project can work in two modes:

- Companion mode: a local 3D VRM desktop pet with chat and expression playback
- Assistant mode: the same desktop pet connected to OpenClaw, where OpenClaw owns sessions, agent execution, tools, and background work

## Relationship To OpenClaw

- HumanClaw is a frontend shell for OpenClaw, not a replacement for its Gateway or agent runtime.
- HumanClaw handles avatar rendering, desktop interaction, tray behavior, and assistant presentation.
- OpenClaw handles sessions, event streams, tool execution, and task orchestration.

## Current Scope

- Frameless transparent desktop pet window
- Separate chat window synchronized with the pet runtime
- VRM avatar rendering via Three.js and `@pixiv/three-vrm`
- Optional OpenClaw Gateway bridge from the Electron main process
- Local FastAPI backend retained for standalone companion workflows

## Run Locally

### Web

```bash
pnpm install
pnpm dev
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy backend\.env.example backend\.env
python -m uvicorn backend.main:app --reload
```

### Desktop Pet

```bash
pnpm install
pnpm desktop:start
```

### Desktop Pet + OpenClaw

```bash
openclaw gateway --profile source-dev
set AIGRIL_OPENCLAW_GATEWAY_URL=ws://127.0.0.1:19011
pnpm exec electron .
```

### Desktop Development

```bash
pnpm desktop:dev
```

Required environment variable:

```env
LLM_API_KEY=your_llm_api_key
```

Optional assistant bridge variables:

```env
AIGRIL_OPENCLAW_GATEWAY_URL=ws://127.0.0.1:19011
AIGRIL_OPENCLAW_HOME=C:\Users\<you>\.openclaw-source-dev
AIGRIL_OPENCLAW_REPO=F:\HumanClaw\OPENCLAW_Lobster
```

Compatibility note: the existing `AIGRIL_*` environment variables and `aigril:*` IPC channels are intentionally kept for now so the bridge layer stays stable during the repository split.

## Packaging

Build the latest Windows desktop packages with:

```bash
pnpm desktop:package
```

Generated files are written to `release/`, including:

- `HumanClaw-Setup-<version>-win-x64.exe`
- `HumanClaw-Portable-<version>-win-x64.exe`
- `release/win-unpacked/HumanClaw.exe`

## Repository Layout

```text
backend/   FastAPI API, memory logic, deployment config
electron/  Electron main process, preload bridge, desktop state
src/       VRM avatar, chat runtime, desktop render entry points
Resources/ VRM model and VRMA animation assets
scripts/   Static build helpers
examples/  Standalone developer examples
```

## Next Product Direction

HumanClaw is intended to become a desktop assistant layer on top of OpenClaw: keep the VRM companion and desktop presence in the foreground, while delegating tool use, long-running tasks, and engineering workflows to OpenClaw in the background.
