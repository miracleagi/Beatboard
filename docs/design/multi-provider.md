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
| **P1 声明驱动（✅ 已完成，见第 14 节）** | manifest 与 `list_providers`；`<TaskInspector>` 取代各 PV Inspector；MCP 增加别名、`describe_capabilities` 和动态 schema；Config 面板改为 Providers 列表；删除 `config.apiKeys` 等遗留字段 | 调色板按能力分组；Inspector 统一样式 | `editor-panels.jsx` 净减少约 600 行以上；MCP 旧客户端调用全部兼容（加回归测试） |
| **P2 第二个供应商（✅ 已完成，见第 15 节）** | Keychain 密钥存储；`jobs.rs`；fal 供应商（先做 `image.generate` 和 `video.generate`，再扩展）；本地文件上传；跨供应商使用媒体时的 ref 与上传回退 | 同一张图里可以混用 PixVerse 和 fal 节点 | 端到端测试：fal 生图 → PixVerse 图生视频 → ffmpeg 拼接 |
| **P3 跨供应商能力（✅ 已完成，见第 16、17 节）** | "一键对比"（把一个节点复制到 N 个供应商或模型，结果汇入 Pick）；运行前成本估算与预算上限；任务 job_id 持久化，重启后可恢复轮询；ComfyUI 本地供应商 | 对比、成本、恢复 | — |

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

1. **迁移函数还没有接到 `HYDRATE` 上。** Inspector 和 MCP 仍然直接编辑 `cli.args`，现在迁移会让节点无法编辑。等 P1 的 `<TaskInspector>` 完成后再启用自动迁移。P0 期间 Rust 端两条路径都支持，`kind:'task'` 节点已经可以运行。（P1 已启用，见第 14 节。）
2. **取消只作用于本地进程。** PixVerse CLI 1.2.10 只有 `task status` / `task wait`，没有取消任务的命令。点 Stop 会立即结束本地 CLI 进程和下载，UI 也不再等待；但已经提交到 PixVerse 云端的任务可能会继续执行并扣费。等 CLI 或 API 提供取消能力后再补上。
3. **`RunCtx` 暂时不带 `CancelToken`。** 目前通过在路由层丢弃 future、配合 `kill_on_drop` 统一实现取消。HTTP 轮询型供应商（P2）加入时再把 token 传进 `RunCtx`。
4. **`image` 子命令用 `--image` 还是 `--images`**，由节点上 `images` 槽位的端口数决定（只有 1 个端口时用 `--image`）。这样内置场景（单图端口）和调色板模板（双图端口）都能逐字节复现。
5. **旧 gen/motion 节点在缺少提示词时的行为变了。** 旧代码会在本地直接报错，task 节点则交给 CLI 去报错。这个差异只出现在报错路径上。
6. **~~Pick 节点下游拿到的不是用户选中的候选~~（已修复）**：Rust 端的输入解析（`inputs.rs` 中的 `dep_thumb_lists`，旧路径 `legacy.rs` 和 ffmpeg 共用这个函数）现在只把 Pick 节点里被选中的那一个候选传给下游。选择结果优先取本次运行的结果，因为运行过程中传给下游的节点数据是运行开始时的快照，其中的选择可能还停留在上一次。前端的 `state.jsx` 和 `tauri-bridge.js` 按同一规则处理。黄金测试新增了"重新运行后选择已变"的用例，并断言被放弃的候选不会出现在 argv 中。

## 14. P1 实施记录

### 交付内容

| 模块 | 文件 |
|---|---|
| 能力注册表：端口、槽位、输出类型、旧类型别名 | `src/providers/capabilities.json` |
| PixVerse 声明文件：模型、参数定义（控件类型、选项、默认值、分组）、新节点初始值、说明文字 | `src/providers/pixverse.json` |
| Rust 端读取声明、校验参数、生成 `describe_capabilities` 的内容 | `src-tauri/src/providers/catalog.rs` |
| 前端读取声明，以及新建节点、改参数、切换供应商/模型、处理 MCP 参数 | `src/task-model.jsx` |
| 由声明驱动的 `TaskInspector`（替代 11 个按子命令写死的面板） | `src/editor-panels.jsx` |
| 预览将要执行的命令（`preview_task` 命令） | `src-tauri/src/providers/mod.rs`、`main.rs` |
| MCP：`describe_capabilities`；`add_node` 的类型列表由注册表生成；旧类型名和旧参数名继续可用；参数按声明校验 | `src-tauri/src/mcp.rs`、`src/mcp-bridge.jsx` |
| 加载时自动迁移：`normalizeGraphPorts` 把旧 PixVerse 节点转成 task 节点；`HYDRATE` 清掉 `apiKeys` 等遗留配置 | `src/state.jsx` |
| 调色板按能力分组（Image / Video / Audio / Effects） | `src/state.jsx`（`paletteTemplates`） |

`editor-panels.jsx` 从 2869 行减到 1826 行（删 1277 行，加 234 行），超过"净减 600 行"的目标。

### 测试

- **Rust**：共 26 个测试。
  - 黄金测试增加到 550 个用例，其中 110 个是"新建节点"用例：调色板现在新建的每种节点，与 P1 之前的模板生成的 argv 逐字节一致。旧模板已冻结在 `scripts/fixtures/legacy-pixverse-templates.json`。
  - 所有迁移后的节点和新建节点都必须通过声明校验。
  - `catalog.rs` 自带测试，检查声明与注册表是否一致、各能力的初始值是否合法，以及校验规则是否正确。
- **端到端**：`scripts/e2e/ui-mcp-smoke.mjs`，共 20 项检查。在无头 Chromium 里加载一份 P1 之前的保存数据，Tauri 后端用桩代替，覆盖：
  - 迁移结果和清理后的配置；
  - 旧 MCP 调用：短类型名 `video`、旧参数名 `quality` / `duration`、按旧端口名连线；
  - 参数校验报错；
  - Inspector 编辑、"原样保留命令"的节点重置；
  - 调色板新建节点；
  - 页面没有脚本报错。

### 与原方案的差异

1. **没有做 `list_providers` 命令。** 两份 JSON 放在 `src/providers/`，前端启动时直接 fetch（dev 和 release 构建都会把 `src/` 复制进 web 根目录），Rust 端用 `include_str!` 编译进去，生成测试夹具的脚本也直接读取。这样三方读的是同一份文件，也省掉一次 IPC。应用在声明加载完成后才开始渲染。
2. **校验只检查参数名和值的类型，不检查取值范围。** 旧项目和旧的 MCP 调用里可能有选项列表以外的值（例如手写的模型名或分辨率）。目前这些值会原样传给 CLI；Inspector 会把列表外的模型标成"(custom)"。
3. **没有做"未登录 / 缺 key 时拦截运行"。** PixVerse 的状态仍由 Config 里的运行时面板显示。等 P2 有了需要 key 的供应商，再把状态接到节点上。
4. **"原样保留命令"的节点不能在 Inspector 里改参数。** 这类节点（`_raw_args`）会显示原始命令，并提供"Reset to standard settings"按钮；MCP 修改它们的参数时会报错并说明原因。
5. **内置示例项目（`scenarios.jsx`）仍是旧格式。** 它们在加载时被迁移，正好一直覆盖迁移路径。
6. **旧的非 PixVerse `gen` / `motion` 原型节点不再有参数面板。** 它们只能走模拟执行，也从没出现在调色板里。

## 15. P2 实施记录

### 协议依据

实现时，本机网络策略屏蔽了 fal.ai 的文档站（`docs.fal.ai`、`fal.ai`）。因此协议细节取自 fal 官方 JS 客户端的源码：[fal-ai/fal-js](https://github.com/fal-ai/fal-js)，提交 `cf73f62`（2026-09-24）。各模型的输入输出字段，取自同一仓库里自动生成的 `libs/client/src/types/endpoints.ts`。

| 用途 | 请求 |
|---|---|
| 提交任务 | `POST https://queue.fal.run/{endpoint}` → `{ request_id, status_url, response_url, cancel_url }` |
| 查询状态 | `GET {status_url}` → `IN_QUEUE` / `IN_PROGRESS` / `COMPLETED`。注意：`COMPLETED` 也包括失败 |
| 取结果 | `GET {response_url}` → 模型输出。失败时返回非 2xx 状态码，422 会带字段级的 `detail` |
| 取消 | `PUT {cancel_url}` |
| 上传 | `POST https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3` → `{ upload_url, file_url }`，再用 `PUT upload_url` 上传文件内容。超过 90 MB 的文件 fal 客户端改用分片上传，这里暂不支持，会直接报错说明 |
| 鉴权 | 所有 fal 接口都带 `Authorization: Key <key>` |

### 交付内容

| 模块 | 文件 |
|---|---|
| fal 声明：6 个模型、参数、按模型的约束（`model_params`）；各模型的 endpoint（纯文本生成 / 带参考图两种）、字段映射和输出位置（`endpoints`） | `src/providers/fal.json` |
| fal 供应商 | `src-tauri/src/providers/fal/mod.rs`，分为两部分：`plan()` 是纯函数，把节点设置转成 endpoint 和请求体；`FalClient` 负责上传、提交、轮询、取结果和下载 |
| API key 存储：macOS 用钥匙串，其他平台用进程内存；前端只能查到"是否已设置" | `src-tauri/src/providers/secrets.rs`，命令 `provider_secret_status` / `set_provider_secret` / `clear_provider_secret` |
| 按模型约束参数：`param_specs(…, model)`；`strict` 声明额外校验模型名、选项值和数值范围 | `src-tauri/src/providers/catalog.rs`、`src/task-model.jsx`（`nodeParamSpecs`、`reconcileTaskParams`） |
| UI | `src/editor-panels.jsx`：Config 新增"Provider API keys"；Inspector 显示缺 key 提示；切换模型或供应商时，会自动调整不再适用的参数，并逐项提示改了什么 |

首批模型（全部来自 fal-js 的生成类型）：

- **图像**：FLUX.1 [dev]（纯文本生成 / 以图生图）、FLUX.1 [schnell]（只支持纯文本）、Nano Banana（纯文本生成 / 可接多张参考图的编辑模式）。
- **视频**：Kling 2.5 Turbo Pro、Veo 3.1 Fast、Hailuo-02 Standard，都分文生视频和图生视频两种。

### 与原方案的差异

1. **没有单独的 `jobs.rs`。** 目前只有 fal 一个供应商用队列，轮询逻辑写在 `FalClient::run` 里。等出现第二个异步供应商时再抽出通用部分。
2. **取消会同时通知 fal。** 路由层丢弃运行任务的同时，`CancelOnDrop` 会发送 `PUT cancel_url`。已经完成或已经失败的任务不会再发取消请求。
3. **fal 的输出不写入 `Thumb.id`。** 旧数据把 `id` 一律当作 PixVerse 的云端 ID，写进去会被误用。fal 的结果下载到 `runs/fal/{request_id}-{i}.{ext}`；下游节点（包括 PixVerse）读取这个本地文件。
4. **fal 采用严格校验，PixVerse 仍然宽松。** fal 服务端本来就会拒绝列表外的值，所以前端和 Rust 端都提前拦截，并给出可选值。PixVerse 的旧项目里有手写的值，保持 P1 的宽松策略。
5. **节点上不做运行前拦截。** 缺 key 时，Inspector 会提示；运行时 Rust 端返回"去 Config 添加 key"的错误。

### 测试

- **Rust**：共 43 个测试，其中 fal 相关 15 个。
  - 声明检查：每个模型的每个参数都有字段映射；各能力的初始值合法。
  - 各模型的 endpoint 选择和字段转换，例如 Kling 的时长是 `"10"`，Veo 是 `"6s"`；以及"只在纯文本生成 / 只在图生视频时生效"的字段。
  - 严格校验、错误信息的可读性、输出解析。
  - 用 `tiny_http` 模拟 fal 服务端，跑通完整协议：上传 → 提交 → 3 次轮询 → 取结果 → 下载。同时检查 Authorization 头、请求体、进度只增不减；失败任务返回可读错误且不会被取消；运行中被丢弃时会发送取消请求（已验证：去掉取消逻辑后这个测试会失败）。
  - 跨供应商：fal 生成的图作为 PixVerse 图生视频的 `--image`；PixVerse 的输出作为 fal 输入时走本地文件上传，不使用 PixVerse 的云端 ID。
- **端到端**：`scripts/e2e/ui-mcp-smoke.mjs` 从 20 项增加到 31 项，新增：
  - 把节点切换到 fal，保留仍然适用的参数并提示调整了哪些；
  - 缺 key 提示 → 在 Config 保存 key → 提示消失；
  - 切换到 Veo 时，时长 5 自动调整为 8；
  - MCP 调用 fal 时的严格校验。
  - 设置 `SCREENSHOT_DIR` 环境变量可以同时保存截图。

### 未验证 / 已知限制

- **没有用真实的 fal 账号跑过。** 本机访问不了 fal，也没有 key。协议和模型字段依据的是官方客户端源码，完整流程只在模拟服务端上验证过。首次在 Mac 上真实运行时，请留意 422 错误里的字段名。
- **只支持单次上传，最大 90 MB**，没有实现分片上传。
- **进度是估算的。** fal 不返回百分比，进度条在排队时停在 10%，运行中逐渐逼近 85%，完成后跳到 100%。
- **API key 在 macOS 钥匙串中的读写没有在 Mac 上验证过。** 这里只确认了相关代码能编译，测试走的是内存存储。

## 16. P3 实施记录（第一部分）

### 一键对比

- **用法**：在 Inspector 的"Compare"区选择其他供应商或模型；AI agent 可以调用 MCP 工具 `compare_node`。
- **生成的图**（`state.jsx` 中的 `buildComparison`，纯函数）：
  - 为每个选中的组合复制一份节点，输入连线与原节点相同。
  - 参数按目标模型自动调整，调整了哪些会列出来（沿用 P2 的 `reconcileTaskParams`）。
  - 原节点和所有副本都连到一个新的 Pick 节点；原节点原来的下游连线改为从 Pick 引出，所以用户选中的结果会继续往下传。
- **Pick 的等待规则改了**（`dependencyReadiness`）：
  - 所有输入都不再运行中，并且至少一个产出了结果，Pick 就可以继续；只把成功的输入作为候选。
  - 以前任何一个输入失败，Pick 就会被阻塞。对比时某个模型失败（例如被安全审核拦下）不应该拖住其他结果。失败的节点仍会出现在本次运行的错误汇总里。
  - 这个改动适用于所有 Pick 节点。

### 花费控制

**实施时的发现**：
- PixVerse CLI 的 `--json` 输出里有 `cost_credits`，但这是运行**之后**实际扣掉的积分，不是运行前的报价。
- fal 的返回结果里没有任何费用信息，本机也访问不了 fal 的价格页面。

因此没有做原方案里的"运行前成本估算"——没有可靠的价格数据，不编造数字。改为下面三件事：

1. **记录实际花费**：从 PixVerse 输出中读取 `cost_credits`，写进运行结果的 `cost` 字段。Inspector 显示每个节点被扣的积分，空白 Inspector 汇总"reported spend"，MCP 的 `get_node_result` 也会返回。
2. **按次数设上限**：运行前统计本次要提交的付费生成次数，按供应商分组，并列出节点数和输出数。超过用户设置的上限（默认 3，在 Config → Spending 修改；设为 0 表示每次都询问；也可以选"never ask"）时，先弹窗确认才开始运行。
3. **MCP 行为**：`run_node` 的返回会带上 `paid_generations`；超过上限时额外返回 `needs_user_confirmation`。等待确认期间，`get_node_result` 返回 `waiting_for_confirmation`，agent 需要等用户在界面上确认。

### 中断后恢复

- **记录**：fal 一接受请求，Rust 就通过 `job:<run_id>` 事件把请求的 id 和 URL 发给前端，前端立即写进该节点的运行结果并保存到磁盘。
  - 为此把 `FalClient::run` 拆成了 `submit` 和 `wait` 两步。
  - 用户点 Stop 时会清掉这条记录——请求已经在 fal 取消了，没有东西可恢复。
- **重启后**：加载项目时，保存时还在运行中且有记录的节点，会显示为 `interrupted`；只是在排队、还没提交的节点直接丢弃。
- **恢复**：在 Inspector 点 Resume，调用 `resume_task` 继续轮询同一个 fal 请求并下载结果，不会重新提交，也就不会重复扣费。有测试专门确认只提交了一次。
- **PixVerse 暂不支持恢复**：CLI 要等整个任务完成才会输出任务 id，运行中途拿不到可以保存的东西。以后要支持，需要改成先用 `--no-wait` 提交、再用 `task wait <id>` 等待。但这会改变我们执行 CLI 的方式，得有真实账号验证输出格式后才能动。

### 测试

- **Rust**：共 46 个。新增：从 PixVerse 输出中读取 `cost_credits`；fal 请求被接受后会先报告 job；用保存下来的 job 在一个全新的客户端里恢复，并确认只提交了一次。
- **端到端**：从 31 项增加到 47 项，新增：
  - 中断状态的加载和 Resume；
  - `compare_node` 的连线和参数调整；
  - 超过上限时弹窗确认、确认前不会发起任何运行；
  - 对比中 Veo 失败时，Pick 仍用其余 2 个候选继续；
  - PixVerse 积分的记录与汇总；
  - 从 Inspector 发起对比。
- **验证测试有效**：把 Pick 等待规则临时改回旧版后，端到端测试中有 2 项失败，证明这些检查确实在起作用。

### 尚未做

- **运行前的价格估算**：理由见上文"花费控制"。

## 17. P3 实施记录（第二部分）：ComfyUI 本地供应商

### 产品方案

用户导入**自己的**工作流，而不是由 Beatboard 内置工作流模板。理由：ComfyUI 用户手里本来就有调好的工作流，模型文件、自定义节点都因人而异，内置模板很难在别人的机器上直接跑通。

- **新能力 `comfyui.workflow`**（调色板分组"Local"），只有 `comfyui` 一个供应商。没有挂到 `image.generate` / `video.generate` 下面，因为 ComfyUI 节点的端口由工作流决定，和这些能力的固定端口对不上；切换供应商或"一键对比"会把端口弄乱。
- **导入**：ComfyUI 中选 Workflow → Export (API)，在 Inspector 里选文件或粘贴 JSON。导入的是编辑器格式（有 `nodes` 和 `links`）时，会提示改用 Export (API)。
- **绑定**（自动建议，可在 Inspector 修改）：
  - 提示词、反向提示词：沿 KSampler 一类节点的 `positive` / `negative` 连线找到文本输入；找不到时按节点标题猜。
  - 种子：所有 `seed` / `noise_seed` 数值输入。
  - 输入：LoadImage、LoadVideo、VHS_LoadVideo、LoadAudio 等加载节点，每个对应一个输入端口（slot 为 `in@<节点 id>`）。
  - 结果：第一个 Save 类节点；也可以选"every saved file"。
- **未连接的输入沿用工作流里保存的值**（例如原来的参考图、原来的提示词文字）。
- **参数**：`seed`（留空则每次随机）、`count`（排队 N 个提示，种子依次加 1）、`negative_prompt`。这三个参数标了 `needs_binding`，工作流里没有对应输入时不显示，也不接受。
- **服务器地址**：Config → ComfyUI server，默认 `http://127.0.0.1:8188`；"Test" 调用 `/system_stats`。
- **不计入付费次数**：清单里 `local: true`，花费确认弹窗不统计它。

### 实现

- **前端**：`src/comfyui-workflow.jsx`（纯 JS，同 `task-model.jsx` 的写法）负责解析、建议绑定、生成端口；工作流存在节点的 `workflow` 字段里（`{ name, graph, bindings, output_kind }`），随项目一起保存。重新绑定会重建端口，`replaceNodeKeepingEdges` 按 slot 保留仍然有效的连线，其余删除。
- **Rust**（`src-tauri/src/providers/comfyui/`）：
  - `build_request` 把节点的 `workflow` 作为内部参数 `_workflow` 传给 `plan`；`plan` 是纯函数，检查绑定是否指向存在、且没有被连线占用的输入，然后填入提示词、种子和上传后的文件名。
  - 协议：`POST /upload/image`（文件按内容哈希命名，同一文件只存一份）、`POST /prompt`、轮询 `GET /history/{id}` 和 `GET /queue`、`GET /view` 下载结果。
  - **Stop**：从队列删除还没开始的提示（`POST /queue {delete}`）；只有我们的提示正在运行时才调用 `POST /interrupt`，不会打断共享服务器上别人的任务。
  - **恢复**：提交后通过 `job:` 事件记录服务器地址和 prompt id，重启后可用 Resume 取回，不会重新提交。服务器重启、任务丢失时会报错，而不是一直等待。
  - 错误信息：`/prompt` 被拒时列出每个节点的错误（例如缺少模型文件）；运行失败时给出出错的节点和异常信息；结果为空时提示可能是 ComfyUI 用了缓存（种子固定且输入没变）。
- **MCP**：`add_node` / `set_params` 接受 `workflow`（API 格式 JSON）、`workflow_name` 和 `bindings`；返回值里有绑定摘要。`describe_capabilities` 标明 `local` 和 `workflow`。

### 测试

- **Rust**：新增 15 个，共 61 个。用 tiny_http 模拟 ComfyUI 服务器，覆盖：上传、每个种子一个提示、等待与下载；失败节点的错误信息；Stop 只打断自己的提示；用保存的 job 在新客户端中恢复且只提交一次；任务丢失；服务器连不上时的提示；从任务节点到 plan 的完整路径（上游 fal 图片接入 LoadImage）；Inspector 预览。
- **端到端**：从 47 项增加到 64 项，覆盖 MCP 导入、编辑器格式的提示、非法绑定、重新绑定后端口和连线的变化、运行不计入付费次数、工作流随运行传到 Rust、Inspector 粘贴导入与改绑定、项目保存、Config 中的服务器地址。
- **验证测试有效**：分别把"本地供应商不计入付费"、"重新绑定时删除失效连线"、"只打断自己的提示"、"把工作流传给 plan"改坏，对应测试都会失败。

### 实施中的发现

- **前端各文件共用同一个全局作用域**：页面用浏览器端的 Babel 转译每个 `text/babel` 脚本，`const { a, ...rest } = obj` 会被转成顶层的 `var _excluded = ["a"]`，而后加载的文件会覆盖先加载文件的 `_excluded`。结果是 `rest` 去掉的是别的文件的键。这个问题在本次之前就存在（影响 `executionNodeSignature` 等），单独修复，见下一个提交。

### 局限

- **没有连接真实的 ComfyUI 服务器测试过**（这里无法运行 ComfyUI）。协议按 ComfyUI 的 `server.py` 实现，用模拟服务器验证；新版 ComfyUI 的 `/interrupt` 支持按 prompt id 打断，旧版会忽略这个参数，所以只在确认是我们的提示在运行时才调用。
- ~~没有逐步进度~~：已补上，见下面"逐步进度"。
- ~~不能和云端模型"一键对比"~~：已补上，见下面"一键对比"。
- 只支持无需登录的 ComfyUI 服务器。

### 逐步进度（websocket）

- **为什么每次运行用自己的 client id**：ComfyUI 只把执行事件发给提交这个提示的 client id。所以每次运行生成一个 `beatboard-…` id，先连上 `/ws?clientId=<id>`，再用同一个 id 提交，这样不会漏掉开头的事件。id 和节点标题一起存进 job，Resume 时用同一个 id 重新连接，继续收到进度。
- **怎么算进度**（`comfyui/progress.rs`，纯函数，可单独测试）：
  - 一个提示的进度 =（已完成或命中缓存的节点数 + 当前节点的步数比例）÷ 工作流节点数；
  - 多个提示（`count`）平均；
  - 只前进，不后退。
- **状态行**：例如 `#3 KSampler 12/20`，多个提示时加上 `2/3 · ` 前缀；排队时显示 "waiting in ComfyUI's queue"，下载时显示 "downloading results"。
  - Rust 通过新的 `status:<run_id>` 事件发出；
  - 节点卡片底部、底部日志栏、恢复按钮旁边都会显示；
  - MCP `get_node_result` 在运行中返回 `detail`。
- **仍以 `/history` 为准**：websocket 只用来显示进度和提早发现"已经跑完"；是否完成、结果是什么，仍然读 `/history`。连不上 websocket（例如 `https://` 服务器——这个版本没有启用 TLS）、或者中途断开时，退回到原来的估算方式，运行本身不受影响。
- 同时兼容旧版的 `progress` 消息（没有 prompt id）和新版的 `progress_state` 消息；别人的提示、预览图（二进制帧）、`status` 消息都会忽略。
- **新依赖**：`tokio-tungstenite` 0.21（只开 `connect`，不含 TLS）、`futures-util`；tokio 增加 `net` 特性。

**测试**：
- Rust 从 61 个增加到 68 个。模拟服务器真正完成 websocket 握手，逐条发送事件（包括缓存、采样步数、别人的提示、二进制预览），并且只有事件发完之后 `/history` 才会显示完成。覆盖：
  - 先连接、后提交，两边的 client id 一致；
  - 采样步数逐步推进进度条；
  - Resume 用 job 里的 client id 重新连接；
  - 旧版本保存的、没有 client id 的 job 仍能恢复；
  - 没有 websocket 时的状态行。
- 端到端从 66 项增加到 68 项：运行中节点卡片、日志栏和 MCP 都显示 `#3 KSampler 12/20`，完成后恢复正常。
- **验证测试有效**：让 websocket 永远连不上时，两个 websocket 测试在 10 秒内失败；去掉前端的 `status:` 监听时，端到端测试失败。
- 调试中发现的测试陷阱：tiny_http 对 upgrade 请求返回的 body reader 就是原始 socket，模拟服务器如果先把 body 读完就会卡死。

### 一键对比

ComfyUI 节点可以和云端模型对比（Inspector 的 Compare 区，或 MCP `compare_node`）。

- **按输出类型对比**：输出图片的工作流对比 `image.generate` 的模型，输出视频的对比 `video.generate` 的模型；输出音频的暂不支持。ComfyUI 本身不会出现在可选项里，因为副本没有工作流可以运行。
- **每个副本是一个普通生成节点**：用目标模型的默认设置，再带上 ComfyUI 节点的 `seed`、`count`、`negative_prompt`；目标模型不支持的会列出来，超出范围的会调到上限（例如 count 6 → 4）。
- **输入重新接线**：ComfyUI 节点的每条输入连线，按端口顺序接到副本上第一个同类型的空端口（提示词接 prompt，图片接 img 1、img 2……）；接不上的列在调整说明里。
- **提示词**：ComfyUI 节点没有连接提示词时，用工作流里保存的提示词文字，这样对比的是同一句话；这一点也会列在调整说明里。
- **Pick 和下游**：与普通对比相同。原节点和副本都接到新的 Pick 节点，原来的下游改为从 Pick 接出。ComfyUI 节点这次运行仍然免费，只有云端副本计入付费次数。
- 顺带修改：给 Pick 接线时，改为用每个节点自己的输出端口（副本的端口布局和原节点不同）。实际上保存时 `normalizeGraphPorts` 本来就会把 task 节点的出边改到输出端口，所以旧代码在这里并没有出错，这只是让 `buildComparison` 返回的图本身就是正确的。

**测试**：端到端从 68 项增加到 80 项，覆盖：
- ComfyUI 不能作为对比目标；还没导入工作流的节点不能对比；
- 副本的提供商和模型；设置的沿用与调整（count 6 → 4、negative_prompt 不支持）；
- 使用工作流里的提示词；输入接到 img 1；
- Pick 有 3 个输入，下游改为从 Pick 接出；
- 运行时只有 2 次付费；Pick 提供 3 个候选，选中 ComfyUI 的结果后继续往下传；
- Inspector 里的选项和说明文字。

验证测试有效：去掉"使用工作流里的提示词"之后，有 2 项失败。
