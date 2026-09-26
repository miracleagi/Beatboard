# 设计方案：多供应商抽象（Multi-Provider）

> 状态：草案 · 目标版本：0.10 – 0.12 · 范围：执行层、节点模型、Inspector、MCP、持久化迁移

## 1. 背景与目标

Beatboard 目前把 PixVerse CLI 当作唯一的生成后端，而且这种耦合一直延伸到了数据模型：节点参数直接以 CLI argv 的形式保存。
本方案要把"做什么"（能力）、"用哪个模型"（模型）和"由谁执行、谁计费"（供应商）拆成三个维度，让一张图可以按节点选择不同的供应商，同时保证现有项目和 MCP 客户端都不受影响。

**目标**

1. 新增一个供应商时，只需要实现一个 Rust 模块并写一份声明（manifest），不改前端，也不改 MCP 代码。
2. Inspector 表单、MCP 工具的 schema、参数校验都来自同一份声明，只维护一处。
3. 现有项目（`.beatboard.json`）自动迁移。未改动过的模板节点，迁移后生成的 argv 必须与迁移前**逐字节一致**；用户改过参数的节点允许 flag 顺序不同（PixVerse CLI 不关心顺序），但 flag 和取值必须完全相同。
4. 顺手补上两处现有缺陷：Stop 无法中止生成任务；API key 明文写在项目状态里。

**非目标**

- 不在这一轮升级 Tauri 2，也不做跨平台（Windows/Linux）适配，这两件事单独立项。
- 不追求"所有供应商参数取最小公共集"。通用参数统一处理，供应商特有的参数放在明确的扩展区。

### 一个关键观察

PixVerse 本身已经是一个聚合器：`create video` 的模型列表里就有 `kling-3.0-pro`、`veo-3.1-*`、`sora-2*`、`seedance-2.0-*` 等（见 `src/editor-panels.jsx` 中的 `PIXVERSE_CREATE_SPECS`）。
所以多供应商的价值**不在于"能用上更多模型"**，而在于：

- **计费和账号渠道**：同一个模型可以走 PixVerse 积分，也可以走 fal、Replicate 或厂商官方 API。
- **PixVerse 没有的模型和能力**：例如 Flux、开源 LoRA、本地 ComfyUI 工作流。
- **可用性与对比**：一家限流或下线时可以切换，同一个提示词也能在不同渠道上 A/B 比较。

因此数据模型里**模型和供应商必须是两个独立字段**。同一个 `kling-3.0-pro` 可以挂在多个供应商下面。

## 2. 现状：耦合点清单

| 层 | 位置 | 耦合方式 |
|---|---|---|
| 节点数据 | `src/state.jsx` `NODE_TEMPLATES` | `kind:'cli'`、`cli.bin:'pixverse'`，参数就是 `cli.args` 这个 argv 数组；节点"类型"要靠 `args[1]`（子命令）反推 |
| 路由 | `src-tauri/src/main.rs` `run_node` / `cli_bin_name` | 按二进制名分发，只认 `pixverse` 和 `ffmpeg` |
| 输入解析 | `src-tauri/src/pixverse.rs` `resolve_pixverse_args` | 对 `{prompt}`、`{images}`、`{video_id}` 等占位符做替换，缺值时回删前一个 `--flag`；这套逻辑本身是通用的，却写在 PixVerse 模块里 |
| 输出解析 | `src-tauri/src/thumbs.rs` | 按 PixVerse JSON 的输出格式抽取 URL/ID，再下载到 `runs/pixverse/` |
| 云端 ID | `first_video_id` → `Thumb.id` | extend、upscale、modify 依赖 PixVerse 的云端 ID，但 `Thumb.id` 没有记录这个 ID 属于哪个供应商 |
| Inspector | `src/editor-panels.jsx` `PIXVERSE_CREATE_SPECS`、`pixVerseCliPatchFor`，以及每个子命令各自的 Inspector 组件 | 模型列表、可用参数、默认值、footer 文案都写死在这里；直接编辑 argv |
| 前端执行器 | `web/tauri-bridge.js` `shouldUseTauri` | 只有 pixverse/ffmpeg 节点才会调用 Rust，其他节点走 mock |
| MCP | `src/mcp-bridge.jsx` `MCP_NODE_TYPES`、`MCP_CLI_FLAGS`、`MCP_CLI_TOGGLES`；`src-tauri/src/mcp.rs` 的工具描述 | 类型名映射到 PixVerse 模板标题；参数通过改写 argv 生效；工具描述硬编码 PixVerse 的模型名 |
| 运行时 | `src-tauri/src/runtime.rs` | 私有 Node + PixVerse CLI 的安装和登录流程，这部分合理，应归入 PixVerse 供应商 |
| 历史遗留 | `state.jsx` 的 `config.apiKeys` {openai, google, piapi, replicate, fal}、`defaultModel:'flux.1-dev'`、`binPaths.real-esrgan/rife`；`kind:'gen'/'motion'` + `provider` | 没有接入任何执行路径；`apiKeys` 会随状态一起被 `save_graph` **明文持久化** |

### 顺带发现的两个缺陷（本方案会一并修复）

1. **Stop 中止不了生成任务。** `editor.jsx` 的 runner 只在 JS 侧设置 `abortRef`，Rust 端没有任何 kill 或取消逻辑。PixVerse 子进程会继续运行到结束，任务也照常计费。
2. **API key 的存放位置不对。** 一旦接入需要 key 的供应商，key 会进入 `graph.json`，也可能随导出的 `.beatboard.json` 被分享出去。

## 3. 核心概念

```
Capability（能力，做什么）      e.g. video.generate
   └─ 输入槽位（slot）、输出类型、通用参数 schema
Provider（供应商，谁执行/计费）  e.g. pixverse, fal, replicate, comfyui-local
   └─ Model（模型）             e.g. kling-3.0-pro
        └─ 该模型在该供应商下支持的能力、参数约束（枚举值、区间）、价格提示
```

### 3.1 能力清单（首批，与现有 PixVerse 子命令一一对应）

| capability | 输入槽位 | 输出 | 原 PixVerse 子命令 |
|---|---|---|---|
| `image.generate` | `prompt`（text，必填），`images`（image，0..N） | image×count | `create image` |
| `video.generate` | `prompt`（text），`image`（image，0..1） | video | `create video` |
| `video.transition` | `frames`（image，2..N，有序），`prompt`（可选） | video | `create transition` |
| `video.reference` | `images`、`videos`、`audios`（各 0..N），`prompt` | video | `create reference` |
| `video.motion_control` | `character`（image，1），`motion`（video，1） | video | `create motion-control` |
| `video.extend` | `video`（video，1），`prompt` | video | `create extend` |
| `video.upscale` | `video`（video，1） | video | `create upscale` |
| `video.modify` | `video`（1），`images`（0..N），`prompt` | video | `create modify` |
| `audio.speech` | `text`（text，1） | audio | `create voice` |
| `audio.music` | `prompt`，`image`（0..1） | audio | `create music` |
| `provider.template` | 由供应商定义 | image 或 video | `create template`（PixVerse 特有） |

ffmpeg 暂时保持现状（`kind:'cli'`），第 3 阶段再考虑是否作为 `local` 供应商的 `video.concat` 能力纳入。

### 3.2 通用参数（能力层定义，供应商映射）

`model`、`count`、`seed`、`aspect_ratio`、`resolution`（取代 `quality`，取值如 `720p`/`1080p`/`2160p`）、`duration_s`、`audio`（bool）、`negative_prompt`。
每个模型在 manifest 里声明自己支持其中哪些参数，以及合法取值。
供应商特有的参数（如 PixVerse 的 `off_peak`、`idempotency_key`，ElevenLabs 类的 `stability`）放进 `provider_params`，schema 同样由 manifest 声明。

## 4. 目标数据模型

### 4.1 新节点形态

```jsonc
{
  "id": "n3", "kind": "task",               // 新 kind，不复用遗留的 gen/motion
  "capability": "video.generate",
  "provider": "pixverse",
  "model": "kling-3.0-pro",
  "params": { "duration_s": 5, "resolution": "720p", "aspect_ratio": "16:9", "count": 1 },
  "provider_params": { "off_peak": true },
  "prompt": "",                              // 可选：节点内联提示词，与现有 first_prompt 语义一致
  "ports": [ { "kind": "image", "side": "left", "slot": "image", "label": "src" }, ... ],
  // x/y/w/title/badge/footer/thumbs 与现状相同
}
```

- 端口新增 `slot` 字段，输入解析**按槽位名**进行，不再依赖端口序号和媒体类型去猜。
- `executionNodeSignature`（`state.jsx`）会把 layout 以外的所有字段都序列化，所以改 provider、model 或 params 会自动让该节点及其下游的缓存失效，这部分不需要改动。

### 4.2 媒体引用（取代现在的 Thumb.id）

```jsonc
{
  "type": "video",
  "path": "/…/runs/pixverse/abc.mp4",        // 本地副本，始终存在
  "url": "https://…",                        // 远程原始地址（可能过期）
  "refs": { "pixverse": "vid_123" },         // 各供应商的云端 ID，按供应商命名空间区分
  "origin": { "provider": "pixverse", "model": "v6", "job_id": "…" }
}
```

旧的 `Thumb.id` 在读取时视为 `refs.pixverse`。
extend、upscale 这类需要云端 ID 的能力，优先用同一供应商的 ref；没有时由供应商自己上传本地文件。

## 5. Rust 侧架构

```
src-tauri/src/
  providers/
    mod.rs          // Provider trait、Registry、ProviderManifest 类型
    inputs.rs       // deps → 槽位（Slot）解析；从 pixverse.rs 抽出通用部分
    media.rs        // MediaRef、下载/落盘、类型推断（thumbs.rs 的通用部分）
    jobs.rs         // HTTP 型供应商的 submit → poll 辅助：退避、进度、取消
    secrets.rs      // Keychain 读写
    pixverse/       // mod.rs（Provider 实现）、args.rs（原 resolve_pixverse_args）、
                    // output.rs（原 thumbs.rs 中 PixVerse 专属解析）、manifest.json
    fal/            // 第 2 阶段
  runtime.rs        // 保留，作为 pixverse 供应商的依赖
```

### 5.1 接口

```rust
#[async_trait]
pub trait Provider: Send + Sync {
    fn id(&self) -> &'static str;
    fn manifest(&self) -> &ProviderManifest;           // 能力、模型、参数 schema、鉴权方式
    async fn status(&self, ctx: &AppCtx) -> ProviderStatus; // 已安装/已登录/缺 key/不可用
    async fn run(&self, req: TaskRequest, ctx: RunCtx) -> Result<TaskOutput, ProviderError>;
}

pub struct TaskRequest {
    pub capability: Capability,
    pub model: String,
    pub prompt: Option<String>,
    pub inputs: BTreeMap<String /*slot*/, Vec<MediaRef>>,  // 已按端口顺序排好
    pub params: Map<String, Value>,          // 已按 manifest 校验并补齐默认值
    pub provider_params: Map<String, Value>,
}

pub struct RunCtx {
    pub progress: ProgressSink,              // 封装 window.emit("progress:{run_id}")
    pub cancel: CancellationToken,           // 见 5.3
    pub work_dir: PathBuf,                   // runs/<provider>/
    pub http: reqwest::Client,
    pub secrets: SecretStore,
}

pub struct TaskOutput {
    pub media: Vec<MediaRef>,                // 已下载到 work_dir
    pub raw: Value,                          // 原始响应，调试用（对应现在的 "pixverse" 字段）
    pub cost: Option<Cost>,                  // 可选：积分/美元
}

pub enum ProviderError { Auth(String), InvalidParams(String), Quota(String), Cancelled, Remote(String), Io(String) }
```

`ProviderError` 分类后，前端错误弹窗可以给出针对性的操作按钮，比如"去登录"、"去填 key"。MCP 也能返回机器可读的错误码。

### 5.2 路由

`main.rs::run_node`：

```rust
match node["kind"].as_str() {
    Some("task") => providers::run_task(&registry, node, deps, run_id, ...).await,
    _ => /* 旧路径：cli_bin_name → pixverse / ffmpeg，保留一个版本周期 */,
}
```

新增 Tauri 命令：

- `list_providers`：返回所有 manifest 和 status，前端启动时加载。
- `set_provider_secret` / `clear_provider_secret`：写入或清除 Keychain 中的 key。
- `cancel_run(run_id)`：取消一次运行。

### 5.3 取消

- `run_node` 按 `run_id` 把一个 `CancellationToken` 登记到全局表里；`cancel_run(run_id)` 触发取消。
- CLI 型供应商（PixVerse）：用 `tokio::select!` 同时等待子进程和取消信号；收到取消后 `child.kill()`。如果 CLI 有对应的取消子命令，再尽量调用一次。
- HTTP 型供应商：`jobs.rs` 的轮询循环检查取消信号，调用供应商的 cancel 接口（如果有）。
- `tauri-bridge.js`：当 `ctx.abortRef` 被置位时调用 `invoke('cancel_run', { runId })`。

### 5.4 密钥

- 用 macOS Keychain 保存（`security-framework` 或 `keyring` crate），service 为 `com.beatboard.app`，account 为 `provider:<id>`。
- 前端只拿到"已配置 / 未配置"这个状态，永远拿不到明文 key。
- 从状态中**删除** `config.apiKeys`（HYDRATE 时丢弃），确保项目 JSON 和导出文件里不含任何 key。

## 6. Manifest：唯一信息源

每个供应商附带一份 `manifest.json`，编译时通过 `include_str!` 嵌入：

```jsonc
{
  "id": "pixverse", "name": "PixVerse", "auth": "cli-login",
  "models": [
    {
      "id": "kling-3.0-pro", "label": "Kling 3.0 Pro",
      "capabilities": {
        "video.generate": {
          "params": {
            "resolution": { "enum": ["540p", "720p", "1080p"], "default": "720p" },
            "duration_s": { "enum": [5, 10], "default": 5 },
            "aspect_ratio": { "enum": ["16:9", "9:16", "1:1"], "default": "16:9" },
            "count": { "min": 1, "max": 4, "default": 1 },
            "audio": { "type": "boolean", "default": false }
          },
          "slots": { "image": { "max": 1 } }
        }
      }
    }
  ],
  "provider_params": {
    "off_peak": { "type": "boolean", "label": "Off-peak (cheaper, slower)" },
    "idempotency_key": { "type": "string", "advanced": true }
  }
}
```

同一份 manifest 驱动三个消费方：

1. **Inspector**：根据 schema 自动生成表单（enum → select，boolean → toggle，min/max → number），供应商参数折叠在 "Advanced" 下。
2. **MCP**：`add_node` / `set_params` 的参数 schema，以及新工具 `describe_capabilities` 的返回内容。
3. **Rust 校验**：`run_task` 在调用 `Provider::run` 之前统一做校验并补默认值。

PixVerse 的第一版 manifest 由现有的 `PIXVERSE_CREATE_SPECS` 和 `NODE_TEMPLATES` 中的默认值机械转换得到。
（开放问题：PixVerse CLI 如果提供模型列表命令，可以改为运行时拉取，避免在客户端里写死不断变化的模型列表。）

## 7. 前端改动

| 模块 | 改动 |
|---|---|
| `state.jsx` `NODE_TEMPLATES` | 生成类模板**按能力分组**（"Image · generate"、"Video · generate"……），`spawn()` 产出 `kind:'task'`，默认 provider 为 `pixverse`、默认模型取 manifest 的 default。调色板不再有 "PixVerse" 分组 |
| `editor-panels.jsx` | 新增 `<TaskInspector>`：顶部是 Provider 和 Model 选择器，下方是 schema 驱动的参数表单。替换掉各子命令的 PV Inspector 和 `PIXVERSE_CREATE_SPECS`（约 800 行），footer 和 title 由 capability、model、params 统一生成 |
| 切换供应商/模型 | 保留目标模型也支持的通用参数，超出范围的值夹到默认值，丢弃不支持的 `provider_params`，并用 toast 说明改了哪些。端口按槽位约束重新校验，已有连线尽量保留，超出上限的连线标红，不自动删除 |
| 状态提示 | 节点角标显示供应商；供应商状态为"未登录"或"缺 key"时，节点显示警告，运行前拦截 |
| `tauri-bridge.js` | `shouldUseTauri` 增加 `node.kind === 'task'`；中止时调用 `cancel_run` |
| Config 面板 | "Managed runtimes" 改为 "Providers" 列表，每个供应商一行，显示状态、登录或填 key 的入口，以及启用开关 |

## 8. MCP 改动（向后兼容）

- `add_node.type`：新增能力名（`image.generate` …），**旧名字继续可用**，作为别名：`image` → `image.generate`，`motion_control` → `video.motion_control`，`voice` → `audio.speech`，以此类推。
- `params` 新增 `provider` 和 `model`，其余键优先使用通用参数名。旧键（`quality`、`duration`、`duration_seconds`）继续接受，内部映射。
- 新工具 `describe_capabilities(capability?, provider?)`：返回可用的供应商、模型、参数 schema 和状态。工具描述里不再硬编码模型名，agent 自己查询。
- `get_node_result` 的输出增加 `provider`、`model`，以及可选的 `cost`。
- `mcp.rs` 的 `params_schema` 改成根据 manifest 动态生成。现有测试 `tool_registry_and_definitions_stay_in_sync` 保持不变。

## 9. 数据迁移

- 项目状态加 `schemaVersion: 2`。在 `HYDRATE` 和 `IMPORT_PROJECT` 中执行 `migrateProjectV1toV2`。
- 转换规则：
  - `kind:'cli'` 且 bin 为 pixverse：按子命令确定 capability，再把 argv 反解成 params 和 provider_params。反解用的就是 `MCP_CLI_FLAGS` / `MCP_CLI_TOGGLES` 的逆映射，这两张表已经存在。
  - 无法识别的 flag 原样放进 `provider_params._raw_args`，PixVerse 供应商负责把它们拼回 argv，**保证不丢任何信息**。
  - `kind:'gen'/'motion'` 且 `provider:'pixverse'`：按同样规则迁移。
  - 端口：按现有端口的顺序和 label 补上 `slot`，**不改变端口序号**，已有的边无需改动。
  - `Thumb.id` 转成 `refs.pixverse`。
- 迁移不会丢弃 `runResults`。缓存是否仍然有效，由迁移前后是否能生成相同的 argv 来保证。
- **安全网（第 0 阶段的验收标准）**：在 Rust 侧加黄金测试，覆盖所有 `NODE_TEMPLATES` 和 `scenarios.jsx` 里的 PixVerse 节点，以及现有测试中的依赖组合，断言以下两条路径生成的 argv 完全相同：
  - 旧路径：`resolve_pixverse_args(旧节点)`
  - 新路径：`PixVerseProvider::build_args(migrate(旧节点))`

  为此需要把迁移函数的测试夹具导出成 JSON，供 Rust 测试读取；也可以在 Rust 中再实现一份迁移函数，前后端用同一批夹具交叉验证。

## 10. 第二个供应商的选型

建议首选 **fal.ai**，理由如下：

- 一个 API key、一套统一的队列式 HTTP 接口（submit → status → result），覆盖大量图像、视频、音频模型，包括 Flux 系列、Kling、Veo、Seedance 等。写一个适配器就能解锁很多模型。
- 能直接验证第 5 节中 `jobs.rs`（异步任务、轮询、取消）和"本地文件上传后得到 URL"这两条路径，而 PixVerse 覆盖不到这两条。
- 实现时需要以当时的官方文档为准，核对各模型的端点名、参数名、上传方式和价格接口。本文不预设具体端点。

备选方案：

- **Replicate**：接口形态与 fal 相似。
- **本地 ComfyUI（HTTP API）**：零云端成本，并且能把 ComfyUI 生态当作 Beatboard 的一个后端来用，而不是和它竞争，战略上很有吸引力。放到第 3 阶段。

## 11. 分阶段计划

| 阶段 | 内容 | 用户可见变化 | 验收标准 |
|---|---|---|---|
| **P0 重构（✅ 已完成，见第 13 节）** | `providers/` 骨架、`Provider` trait；把 PixVerse 实现迁到 trait 之后；`inputs.rs` 和 `media.rs` 抽离；`kind:'task'` 与迁移函数；取消机制（`cancel_run`） | Stop 真正能中止任务；除此之外没有其他变化 | 黄金测试全部通过；现有 6 个 Rust 测试通过；3 个内置场景手动跑通 |
| **P1 声明驱动（约 1 周）** | manifest 与 `list_providers`；`<TaskInspector>` 取代各 PV Inspector；MCP 增加别名、`describe_capabilities` 和动态 schema；Config 面板改为 Providers 列表；删除 `config.apiKeys` 等遗留字段 | 调色板按能力分组；Inspector 统一样式 | `editor-panels.jsx` 净减少约 600 行以上；MCP 旧客户端调用全部兼容（加回归测试） |
| **P2 第二个供应商（约 1–1.5 周）** | Keychain 密钥存储；`jobs.rs`；fal 供应商（先做 `image.generate` 和 `video.generate`，再扩展）；本地文件上传；跨供应商使用媒体时的 ref 与上传回退 | 同一张图里可以混用 PixVerse 和 fal 节点 | 端到端测试：fal 生图 → PixVerse 图生视频 → ffmpeg 拼接 |
| **P3 跨供应商能力** | "一键对比"（把一个节点复制到 N 个供应商或模型，结果汇入 Pick）；运行前成本估算与预算上限；任务 job_id 持久化，重启后可恢复轮询；ComfyUI 本地供应商 | 对比、成本、恢复 | — |

各阶段都能独立发布。P0 完成后不引入任何新依赖，只修复了中止问题，风险最低。

## 12. 风险与开放问题

1. **参数语义不一致**：各家的"分辨率"、时长取值集合、比例支持各不相同。对策是按模型在 manifest 里声明约束，切换时显式夹值并提示用户，不做静默转换。
2. **跨供应商的云端 ID**：extend 或 upscale 的上游如果来自其他供应商，就必须上传本地文件，可能更慢，也可能不被支持。manifest 需要声明每个槽位接受 `local | url | ref:<provider>` 中的哪几种，UI 在连线时就给出提示。
3. **模型列表更新快**：写死在 manifest 里容易过时。可以考虑让 manifest 支持运行时覆盖（从供应商接口拉取，或随应用更新下发一个 JSON）。这一点留作开放问题。
4. **迁移风险**：旧项目中用户手工改过的 argv 可能无法完全反解。`_raw_args` 兜底方案 + 黄金测试可以覆盖这类情况；另外保留旧路径一个版本周期，发现问题时可以回退。
5. **成本透明**：接入多家付费 API 后，用户可能在不知情的情况下产生费用。P2 至少要在节点上显示"按次计费"的提示，P3 再做估算和预算。
6. **许可证**：仓库使用 MIT Non-Commercial 许可证，与各供应商的 ToS 本身不冲突，但接入前要确认 fal、Replicate 等是否允许在第三方桌面客户端中使用用户自己的 key。实现时核对。

## 13. P0 实施记录

### 交付内容

| 模块 | 文件 |
|---|---|
| Provider trait、`TaskRequest`、`run_task` 路由 | `src-tauri/src/providers/mod.rs` |
| 与供应商无关的输入解析（按槽位分组的 `MediaRef`，云端 ID 按供应商命名空间区分） | `src-tauri/src/providers/inputs.rs` |
| 按 run 取消（`cancel_run` 命令，`until_cancelled`） | `src-tauri/src/providers/cancel.rs`、`main.rs`、`runtime.rs`（`kill_on_drop`）、`web/tauri-bridge.js` |
| PixVerse 供应商：TaskRequest → argv；执行与输出下载 | `src-tauri/src/providers/pixverse/{mod,args}.rs` |
| 旧的占位符解析（`kind:'cli'` 节点，以及 `_raw_args` 兜底） | `src-tauri/src/providers/pixverse/legacy.rs`（原 `pixverse.rs`） |
| 前端迁移函数：`cli` / `gen` / `motion` 转为 `task` 节点 | `src/task-model.jsx` |
| 黄金测试 | `scripts/gen-pixverse-fixtures.mjs` → `src-tauri/tests/fixtures/pixverse_task_migration.json` → `src-tauri/src/providers/pixverse/golden.rs` |

### 黄金测试

- 测试覆盖：
  - 44 个源节点：全部调色板模板、全部内置场景中的 PixVerse 节点、每个模板改参数后的版本、4 个会走兜底的模板，以及 4 个旧的 gen/motion 节点。
  - 每个源节点配 9 种上游依赖形态，共 396 个用例：全连、只连第一个、不连、只连文本、只连媒体、不带云端 ID、只有节点缓存、经过 Pick 节点、边的顺序颠倒。
- 判定标准：未改动的模板和走 `_raw_args` 兜底的节点要求**逐字节一致**；改过参数的节点按 flag 分组后比较，与顺序无关。
- 验证了测试确实能发现问题：人为注入三类错误（调整参数顺序、忽略云端 ID、丢掉 `--no-audio`），分别有 88、36、54 个用例失败。
- 修改 `task-model.jsx` 或模板后，运行 `node scripts/gen-pixverse-fixtures.mjs` 重新生成夹具；加 `--check` 参数可以检查夹具是否过期。

### 与原方案的差异和已知限制

1. **迁移函数还没有接到 `HYDRATE` 上。** Inspector 和 MCP 仍然直接编辑 `cli.args`，现在迁移会让节点无法编辑。等 P1 的 `<TaskInspector>` 完成后再启用自动迁移。P0 期间 Rust 端两条路径都支持，`kind:'task'` 节点已经可以运行。
2. **取消只作用于本地进程。** PixVerse CLI 1.2.10 只有 `task status` / `task wait`，没有取消任务的命令。点 Stop 会立即结束本地 CLI 进程和下载，UI 也不再等待；但已经提交到 PixVerse 云端的任务可能会继续执行并扣费。等 CLI 或 API 提供取消能力后再补上。
3. **`RunCtx` 暂时不带 `CancelToken`。** 目前通过在路由层丢弃 future、配合 `kill_on_drop` 统一实现取消。HTTP 轮询型供应商（P2）加入时再把 token 传进 `RunCtx`。
4. **`image` 子命令用 `--image` 还是 `--images`**，由节点上 `images` 槽位的端口数决定（只有 1 个端口时用 `--image`）。这样内置场景（单图端口）和调色板模板（双图端口）都能逐字节复现。
5. **旧 gen/motion 节点在缺少提示词时的行为变了。** 旧代码会在本地直接报错，task 节点则交给 CLI 去报错。这个差异只出现在报错路径上。
6. **保留了现有的一个行为（可能是缺陷）**：Pick 节点下游取的是 `result.thumbs` 中第一个匹配类型的缩略图，而不是用户选中的那一个。P0 按原样保留，已作为独立问题另行跟踪。
