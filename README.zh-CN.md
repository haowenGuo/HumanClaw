<div align="center">
  <h1>HumanClaw</h1>
  <p><strong>一个从 AIGril 桌宠运行时中独立出来的 3D VRM 桌面助手前端项目，目标是接入 OpenClaw，演进成真正可工作的助手型桌宠。</strong></p>
  <p>
    <a href="README.md">English</a> ·
    <a href="README.zh-CN.md">简体中文</a> ·
    <a href="README.ja.md">日本語</a>
  </p>
</div>

---

## 项目简介

HumanClaw 是从原来的 AIGril 项目里拆出来的桌面端分支。

这个仓库保留了 3D 虚拟人运行时、Electron 桌宠外壳、聊天窗口，以及对 OpenClaw Gateway 的桥接能力，后续会以独立产品的方式继续演进。

当前可以理解成两种模式：

- 陪伴模式：本地 3D VRM 桌宠，负责人物展示、聊天和动作表情联动
- 助手模式：同一个桌宠前端接入 OpenClaw，由 OpenClaw 负责 session、Agent、工具调用和后台任务

## 与 OpenClaw 的关系

- HumanClaw 是 OpenClaw 的桌面前端，不是它的替代品。
- HumanClaw 负责人物渲染、桌面交互、托盘形态和助手呈现。
- OpenClaw 负责会话、事件流、工具执行和任务编排。

## 当前能力范围

- 无边框透明桌宠窗口
- 与桌宠同步的独立聊天窗口
- 基于 Three.js 和 `@pixiv/three-vrm` 的 VRM 虚拟人渲染
- 可选接入 OpenClaw Gateway 的 Electron 主进程桥接
- 仍保留本地 FastAPI 后端，方便继续做陪伴模式和独立联调

## 本地启动

### 网页版

```bash
pnpm install
pnpm dev
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy backend\.env.example backend\.env
python -m uvicorn backend.main:app --reload
```

### 桌宠版

```bash
pnpm install
pnpm desktop:start
```

### 桌宠版 + OpenClaw

```bash
openclaw gateway --profile source-dev
set AIGRIL_OPENCLAW_GATEWAY_URL=ws://127.0.0.1:19011
pnpm exec electron .
```

### 桌宠开发模式

```bash
pnpm desktop:dev
```

至少需要配置：

```env
LLM_API_KEY=your_llm_api_key
```

可选助手桥接环境变量：

```env
AIGRIL_OPENCLAW_GATEWAY_URL=ws://127.0.0.1:19011
AIGRIL_OPENCLAW_HOME=C:\Users\<you>\.openclaw-source-dev
AIGRIL_OPENCLAW_REPO=F:\HumanClaw\OPENCLAW_Lobster
```

兼容性说明：仓库拆分阶段，现有 `AIGRIL_*` 环境变量和 `aigril:*` IPC 通道暂时保留，避免把现有桥接链路一起改坏。

## 打包

生成最新版 Windows 桌宠安装包与便携版：

```bash
pnpm desktop:package
```

产物会输出到 `release/` 目录，包括：

- `HumanClaw-Setup-<version>-win-x64.exe`
- `HumanClaw-Portable-<version>-win-x64.exe`
- `release/win-unpacked/HumanClaw.exe`

## 项目结构

```text
backend/   FastAPI 接口、记忆逻辑、部署配置
electron/  Electron 主进程、预加载桥接、桌宠状态管理
src/       VRM 数字人、聊天运行时、桌面端渲染入口
Resources/ VRM 模型与 VRMA 动作资源
scripts/   静态构建辅助脚本
examples/  独立开发示例
```

## 后续产品方向

HumanClaw 的目标是成为 OpenClaw 之上的桌面助手层：前台保留虚拟人、桌宠和陪伴体验，后台把工具调用、长任务执行和工程工作流交给 OpenClaw。
