# 纸笺 Git

温暖、轻量的 Windows Git 可视化桌面应用，给文件夹保存每一个版本。羊皮纸风格，中文界面，面向初学者。

> 使用方法见 [docs/使用说明.md](docs/使用说明.md)，性能数据见 [docs/性能报告.md](docs/性能报告.md)。

## 技术栈

| 层 | 选型 |
|---|---|
| 桌面壳 | Tauri 2（Rust），使用系统 WebView2，不打包 Chromium |
| 前端 | React 19 + TypeScript + Vite，原生 CSS 变量，Lucide 图标（按需引入） |
| Git | 调用本机 Git for Windows（结构化参数、`CREATE_NO_WINDOW`、超时与取消、输出上限） |
| 文件监听 | `notify`，仅监听当前项目，650ms 防抖 |
| 字体 | 内置 Source Serif 4 与 JetBrains Mono 的拉丁子集；中文使用系统字体 |

## 目录

```
src/                 前端（App.tsx 主界面；panes.tsx 分支/暂存/同步/各类弹窗；help.tsx 说明与帮助；ui.tsx 虚拟列表与差异视图）
src-tauri/           Rust 后端（src/git.rs 全部 Git 操作与单元测试；src/main.rs 窗口、单实例、文件监听）
src-tauri/installer-hooks.nsh   安装包钩子：写入/清理资源管理器右键菜单「Git 代码仓库」（仅当前用户 HKCU）
tests/               端到端测试与性能测量脚本（见下）
docs/                使用说明、性能报告
app-icon.svg         应用图标源文件（`npx tauri icon app-icon.svg -o src-tauri/icons` 生成全套）
```

## 开发与构建

前置：Rust（rustup）、Node.js 20+、Visual Studio C++ 生成工具、Git for Windows；Windows 11 自带 WebView2。

```bash
npm install
npx tauri dev          # 开发运行
npx tauri build        # 生成 src-tauri/target/release/paper-git.exe 与 NSIS 安装包
cargo test --release --manifest-path src-tauri/Cargo.toml   # Rust 单元测试（使用临时仓库）
```

## 测试

- **Rust 单元测试**（12 项）：路径安全、状态解析、暂存/提交分离、二进制与首个提交、代码块暂存/取消、追溯、暂存修改（含未跟踪文件）、撤销首个提交、游离 HEAD、远程上传/获取/拉取/被拒绝/领先落后、冲突分类、网址与分支名校验。
- **端到端测试**（`tests/e2e.mjs`、`tests/e2e2.mjs`）：驱动真实 Release 程序（通过 WebView2 调试端口，**仅测试时开启**），并用 `git` 命令独立核对结果。全部使用系统临时目录里的测试仓库，不触碰真实项目。

  ```bash
  node tests/e2e.mjs     # 本地版本管理主流程
  node tests/e2e2.mjs    # 分支/暂存/远程/冲突/Amend/标签/追溯/搜索/克隆
  ```
- **性能测量**：`node tests/perf.mjs`（冷启动、空闲内存、大仓库峰值、连续切换、最小化 CPU）。

## 设计要点

- 所有 Git 操作在 Rust 端执行；参数以数组传入，不拼接 shell；每个仓库的写操作串行排队。
- 提交前用“暂存内容指纹”校验：界面展示的已准备文件与实际提交的文件必须一致，已有暂存内容不会被静默提交。
- 永不强制上传；不保存密码/令牌（网址含凭据会被拒绝，登录交给 Git 凭据管理器）。
- 会丢失内容的操作都有确认；`stash` 类命令不使用 `--literal-pathspecs`（否则会悄悄漏掉未跟踪文件）。
- 低内存：文件/历史列表虚拟滚动，历史每页 50 条，差异按选中文件加载并限制大小，不轮询，空闲不调用 Git；发布版关闭 GPU 合成（`--disable-gpu`），实测私有工作集明显下降。
- Tauri 权限最小化：仅事件、窗口最小化/最大化/关闭/拖动、文件夹选择与保存对话框。
