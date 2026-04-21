# OpenClaw Runtime Installer

This directory contains the standalone Windows installer shell used to package and launch the local OpenClaw runtime for HumanClaw.

## What It Is

This is **not** the full upstream OpenClaw source repository.

It is the packaging layer that:

- bundles the prepared OpenClaw runtime payload
- bundles the required Node / vendor runtime
- exposes a Windows installer and portable launcher
- starts the local Gateway expected by HumanClaw

## Main Files

- `main.cjs` - Electron entry for the installer shell
- `preload.cjs` - IPC bridge for the installer UI
- `renderer.js` - installer UI logic
- `supervisor.cjs` - runtime bootstrap / health-check orchestration
- `index.html` - installer UI

## How The Bundle Is Prepared

From the repository root:

```bash
pnpm openclaw:prepare-runtime
pnpm openclaw:package-installer
```

The build configuration lives in [`../openclaw-installer-builder.cjs`](../openclaw-installer-builder.cjs).

The packaging flow pulls in:

- `build-cache/openclaw-runtime`
- `build-cache/openclaw-runtime/node_modules`
- `build-cache/openclaw-vendor`

and emits Windows artifacts such as:

- `OpenClaw-Runtime-Setup-<version>-win-x64.exe`
- `OpenClaw-Runtime-Portable-<version>-win-x64.exe`

## Relationship To HumanClaw

HumanClaw can run in two ways:

1. companion mode, without OpenClaw
2. assistant mode, connected to a local OpenClaw Gateway

This installer exists to support the second path by packaging the local runtime expected by the desktop bridge.

## Scope Boundary

This folder is responsible for:

- packaging
- launching
- bootstrap checks
- runtime health checks

This folder is not responsible for:

- the full upstream OpenClaw source tree
- replacing OpenClaw's own core architecture
- changing the product boundary between HumanClaw and OpenClaw
