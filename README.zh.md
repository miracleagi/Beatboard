# Atlas — AI 媒体节点编辑器

用节点图的方式串联 AI 图像 / 视频生成工作流。基于 Tauri + React 构建的 macOS 桌面应用，使用 PixVerse CLI 在本地直接调用 AI 生成能力。

---

## Mac 安装

### 第一步：安装依赖

在终端运行安装脚本，自动完成以下工作：

- 检测并安装 Node.js（通过 Homebrew）
- 检测并安装 ffmpeg
- 安装 PixVerse CLI（`npm install -g pixverse`）
- 引导完成 PixVerse 账号登录

```bash
bash Install-PixVerse.sh
```

> 如果提示"operation not permitted"，请先给脚本赋权：
> ```bash
> chmod +x Install-PixVerse.sh && ./Install-PixVerse.sh
> ```

安装过程中系统可能弹出密码框，输入 Mac 登录密码即可（Homebrew 安装需要）。

---

### 第二步：打开 Atlas

安装完成后，双击 **`Atlas.app`** 启动，或从 DMG 拖入 Applications 文件夹后打开。

> 首次打开如果系统提示"无法验证开发者"，请前往  
> **系统设置 → 隐私与安全性 → 仍要打开**

---

## 节点类型

### 输入节点
| 节点 | 说明 |
|------|------|
| **Prompt** | 文本提示词输入 |
| **Asset** | 图片 / 视频素材（支持从本地磁盘选择，或从 Library 中选取） |

### PixVerse 生成节点
| 节点 | 说明 |
|------|------|
| **Image** | 文生图 / 图生图 |
| **Video** | 文生视频 / 图生视频 |
| **Transition** | 两张图之间的过渡视频 |
| **Reference** | 多图 / 多视频参考生成 |
| **Motion Control** | 用参考视频控制运动轨迹 |
| **Extend** | 延长已有视频 |
| **Upscale** | 视频超分辨率 |
| **Speech** | 为视频添加 TTS 语音 |

### 工具节点
| 节点 | 说明 |
|------|------|
| **Pick** | 从多个候选结果中手动选一张 |
| **ffmpeg** | 本地视频拼接 / 剪辑 |
| **Output** | 将结果保存到本地目录 |

---

## 基本用法

1. 顶部 `+` 新建项目（支持模板）
2. 从左侧面板拖入节点到画布
3. 拖动右侧端口连接到下一个节点的左侧端口（自动类型校验）
4. 右键节点 → **Run from here** 从当前节点开始运行
5. 点击右上角 **Run** 运行整张图
6. 运行中可点击 **Stop** 中断

**快捷操作：**
- `Backspace / Delete` — 删除选中节点或连线
- 右键节点 — 运行 / 复制 / 删除
- 拖拽空白区域 — 平移画布
- 点击空白区域 — 取消选中

---

## 配置

点击右上角 **⚙ Config** 打开配置面板：

- **PixVerse CLI 路径**：通常自动检测，如安装在非标准路径可手动填写
- **ffmpeg 路径**：同上
- **项目默认输出目录**：Output 节点保存文件的默认位置

---

## Library

运行结果可以点击节点上的 **☆ 收藏** 按钮保存到 Library。  
Library 中的素材可以跨项目复用，直接拖到画布上或在 Asset 节点的 Inspector 中选取。

---

## 项目结构

```
Atlas.app                    ← 桌面应用（Tauri 打包）
Install-PixVerse.sh              ← 一键安装依赖脚本
dev.command                  ← 开发模式启动（需要 Rust 环境）
src/                         ← 前端源码（JSX，不需要编译步骤）
  shared.jsx                 ← 设计 token、图标、通用组件
  state.jsx                  ← 状态管理、节点模板、Executor 接口
  editor.jsx                 ← 画布：拖拽、连线、运行器
  editor-node.jsx            ← 单个节点组件
  editor-panels.jsx          ← 顶栏、左侧面板、右侧 Inspector
  editor-app.jsx             ← 应用根组件、自动保存
  graph.jsx                  ← 连线路径、端口
  scenarios.jsx              ← 项目模板
src-tauri/                   ← Rust 后端
  src/main.rs                ← Tauri invoke 处理器
  src/pixverse.rs            ← PixVerse CLI 参数解析与执行
  src/ffmpeg.rs              ← ffmpeg 节点执行
  src/thumbs.rs              ← 运行结果解析与缩略图下载
  src/storage.rs             ← 项目文件持久化
  src/utils.rs               ← 工具函数
web/                         ← Tauri 静态资源目录（由 src/ 自动同步）
```

---

## 开发模式

需要先安装 [Rust](https://rustup.rs/) 工具链。

```bash
./dev.command
```

脚本会自动将 `src/` 同步到 `web/src/`，然后启动 `cargo tauri dev`（热重载）。

### 发布构建

```bash
cd src-tauri
cargo tauri build
```

产物在 `src-tauri/target/release/bundle/macos/`。

---

## 数据持久化

所有项目数据保存在 macOS 应用数据目录（`~/Library/Application Support/com.atlas.app/`）。

数据格式：

```jsonc
{
  "config": { "binPaths": { "pixverse": "", "ffmpeg": "" }, ... },
  "projects": [
    {
      "id": "...", "name": "...", "color": "#...",
      "graph": { "nodes": [...], "edges": [...] },
      "runResults": { "<nodeId>": { "thumbs": [...] } },
      "outputDir": "/Users/..."
    }
  ]
}
```

顶部菜单 `+` → **Export** 可将单个项目导出为 `.atlas.json` 文件，随时可重新导入。
