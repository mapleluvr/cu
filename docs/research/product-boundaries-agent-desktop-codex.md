# cu、agent-desktop 与 Codex Computer Use：差异化分野

调研日期：2026-11-09。本文是产品分析与建议，不修改现有执行合同。

## 结论先行

三者有交集，但不在完全相同的层次竞争：

- **agent-desktop + agent-browser：模型中立的语义自动化工具链。** 原生应用
  走 AX/UIA/AT-SPI；网页和可重新启动的 Electron 应用内容走浏览器工具。
  价值是少猜坐标、按需读取树、利用控件操作和条件等待。
- **Codex Computer Use：集成在 OpenAI 工作环境中的任务能力。** 它把模型、
  浏览器、桌面控制、应用许可、代码修改和任务延续组合成使用体验。它不仅是
  一个截图点击 API，也不只是纯视觉操作。
- **cu：模型中立、图像证据绑定的有限输入执行器。** 更具体的分野是当前观察
  的单次使用权限、确定性 checkpoint、输入意图持久化和不确定效果恢复。
  它适合没有可靠语义操作通道、需要看渲染结果或必须使用物理输入的界面。

因此，cu 不宜把“CLI、开源、无内置模型、截图、安全、无需必需 daemon”
单独当作壁垒：agent-desktop 已覆盖其中多项，且有认真设计的身份和重试规则。
更有意义的定位是：

> 给任意 agent 提供可核查的视觉输入执行合同，补齐语义工具无法可靠覆盖的
> 桌面操作与渲染状态验证，而不是再造一套通用浏览器或完整 AI 工作台。

这是建议，不是已经决定的永久 Non-Goal。若真实任务显示纯视觉执行器价值
不足，应据此重新讨论范围，而不是用“底层工具”来回避能力缺口。

## 1. 本次证据与边界

### 1.1 已实际取得的材料

- 浏览器读取 agent-desktop 官方介绍、Windows 能力表、refs、headed、batch、
  recovery 和 Chromium/Electron 文档。[A1]–[A7]
- 从官方仓库页面确定源码提交
  `17467da5142d471b1e3a6b24828a5d3ad4d8c547`，取得固定提交下的核心源码和
  Windows 解析实现。该提交的 Cargo workspace 版本是 **1.1.0**；示例输出
  中的 `version: "2.6"` 不能当作软件发行版本。[A8]
- 浏览器读取 Codex 官方更新及当前 Computer Use/Browser 文档。旧的
  `developers.openai.com/codex/computer-use` 入口目前重定向到
  `learn.chatgpt.com/docs/computer-use`，文档已经同时描述 ChatGPT Work 和
  Codex；以当前能力说明为准，不把 4 月首发范围当作今天的范围。[C1]–[C3]
- 阅读 DEV Community 文章、评论和 Hacker News 原帖，区分亲自试用、作者
  自述与资料转述。[M1]–[M3]
- 核对 cu 本地提交 `d1b04f05f37233a7d8485a7d4ee4ac0a8510d791` 的
  `observeRegion`、`actRegion`、规范合同和现有 skill。[U1]–[U4]

### 1.2 没有建立的结论

本轮没有安装 agent-desktop 二进制，没有运行 Codex 桌面组件，也没有做同一
模型、同一任务的三方性能对照。源码取样不等于完整安全审计。对于 Codex，
只能说明公开能力与限制，不能推断它内部是否采用与 cu 相同的 journal、
一次性 observation 或恢复协议。

Reddit 两个候选页面分别出现人机挑战和网络封锁，未绕过，未以搜索摘要
代替评论证据。Hacker News 的旧 agent-desktop 原帖是作者说明且没有独立
测试讨论，不能算独立口碑验证。

抓取文本、固定提交源码取样与本轮脚本在本机
`C:/Users/mapleland/ego/cu-product-boundaries-20261109-1638/`。该目录不是
产品发布产物，也不是其他环境续接本文的必要条件；公开链接在文末。

## 2. agent-desktop 的实质：控件身份与语义操作

### 2.1 它为何通常能省掉视觉推理

它读取操作系统无障碍树，为控件分配 `@<snapshot_id>:eN`。调用者可以直接
表达 `set-value`、`check`、`expand`、`select`，而不是先用截图辨认控件，再
移动鼠标、选中文字和逐个键入。[A1]、[A2]

大窗口先 `snapshot --skeleton`，再对某个 ref `snapshot --root`，配合
`-i`、`--compact`、深度限制和 `find` 减少返回量。注意：呈现的树更小，不
等于身份校验完全只读小区域；当前 Windows/Linux ref 的唯一性证明仍针对
原窗口，严格校验本身可能需要更完整的读取。[A3]、[A8]

`headless` 不是一台隔离的虚拟电脑，而是多数 ref 动作调用语义 API，不使用
用户的物理指针。Windows 中，被另一窗口遮住但未最小化的窗口仍可语义操作；
最小化元素通常是 offscreen，需 restore。物理输入和部分焦点操作仍要
`--headed`。无作用的语义路径不会静默切到物理输入。[A2]、[A4]

### 2.2 它并不是“没有截图、不会坐标、没有安全约束”

当前产品有 `screenshot`、`--headed mouse-click --xy`、拖动、键盘输入、
traces 和光标 overlay。其原始坐标点击源码检查策略、能力、坐标和 interaction
lease，但不要求传入截图 observation ID。[A8]

refs 不是永久句柄：每次操作前，检查原进程/窗口与元素身份。Windows/Linux
要求捕获时唯一、当前仍唯一；macOS 可使用元素自身保留的地址。歧义、不完整
身份和失效都有明确错误，不拿一个外观相似的元素凑数。[A3]

它还区分 `not_delivered`、`delivery_uncertain`、`delivered_unverified`、
`delivered_verified`、`unknown`，只有 `not_delivered` 对应 safe retry。
cu 的“不要重复点击可能已执行的动作”不是独有理念。[A5]、[A8]

### 2.3 具体缺口给了 cu 什么机会

1. **无可用语义树的内容。** 自绘 canvas、游戏视图、特殊绘图/编辑器区域
   无法仅靠树解释。它仍能截图和物理点击，但需要外部视觉定位，并没有 cu
   的截图到输入权限合同。
2. **同名同身份的重复控件。** 当前 Windows/Linux 的两个控件若 role、
   native id、name、description 都相同，就没有可用 ref 路径；钻入某行不
   自动解除全窗口的身份歧义。几何位置可由外部视觉判断后走物理输入。[A3]
3. **语义树不反映渲染正确性。** 按钮存在、value 正确，不证明没有遮挡、
   错位、颜色错误、图表渲染缺陷或画布编辑错误。此时需要视觉证据。
4. **不能任意接管已经运行的 Electron 进程的 CDP。** 官方 `launch --cdp`
   要求新启动应用，并拒绝为已有进程偷偷重启；已有应用只能继续语义读取或
   通过用户另行提供的浏览器连接工作。[A7]

这些是可验证的细分场景，不意味着所有 Electron 应用都无法用语义自动化。
官方 Windows 文档还提醒冷启动 Chromium 树可能要 10–25 秒才长完整；这是
特定读取路径的限制，不能外推为每次 snapshot 都慢。[A2]

### 2.4 与 agent-browser 的分工值得借鉴

agent-desktop 自己不实现 CDP 操作。它为新启动的 Chromium/Electron 程序
开并核验 loopback DevTools endpoint，之后由 agent-browser 操作网页内容；
原生菜单、文件对话框、窗口、通知留在 agent-desktop。[A7]

这是一个明确的模块边界，而不是“所有事情必须统一到一个 CLI”。cu 可以
与现有浏览器/语义工具协作，不必为了完整性复制浏览器能力。

## 3. Codex Computer Use 的实质：集成与人机协作

### 3.1 当前公开能力

官方 Computer Use 文档描述在受支持地区，通过桌面应用给 ChatGPT Work 或
Codex 启用控制能力，并按应用批准访问，可保存 Always allow。系统权限与
应用批准分开，组织管理员还可以限制访问。[C1]

- macOS 支持后台操作；官方 4 月更新还描述多个 agent 与用户并行。
- **Windows 当前是前台操作**，目标应用必须在活动桌面可见，用户不应同时
  在同一桌面抢用键鼠。官方建议使用第二台设备或 VM。
- macOS 的 locked use 是另外启用的受控能力；Windows 仍是前台，不把它
  等同为普通远程解锁功能，也不把这个设计移植为 cu 的绕锁目标。
- 用户可以停止或接管。终端应用、ChatGPT 自身、管理员认证和系统安全许可
  提示不在可自动化范围内。[C1]

Codex 的 Computer Use 并不是“闭源版本的 cu”。它的价值还来自看界面、
复现问题、修改代码、重新运行界面流程都处在同一个任务中，以及应用许可、
浏览器标注、任务记忆和长期自动化的组合。[C2]

### 3.2 它也在走混合通道

当前 Browser 文档明确区分内置浏览器与普通浏览器的 profile；需要已有浏览器
会话时用扩展。Developer mode 可在明确批准后使用完整 CDP 来看 DOM、样式、
性能和网络。Computer Use 文档也建议：有专用 plugin/MCP 时，对数据与重复
操作优先使用结构化通道，视觉能力用于必要的界面操作。[C1]、[C3]

因此不要建立“agent-desktop 语义、Codex/cu 完全纯视觉”的假二分。
Codex 是多通道产品，cu 目前只是其中一种执行通道的独立实现。

### 3.3 与 cu 的分野

cu 可以交给 Pi、其他 agent 或脚本，模型与上层任务循环不固定；OpenAI 的
桌面能力依赖其安装组件、权限管理与产品生态。这是相对于 Codex 的差异，
却不是相对于 agent-desktop 的差异。

本轮未确认 Codex 提供可供任意 agent 替换模型使用的独立桌面执行合同，也
未验证它在 CLI 内的所有调用路径。不能从 Codex CLI 开源推导桌面组件也开源，
也不能仅凭未找到独立接口，断言 Computer Use 绝不可能由任何 CLI 调用。

若用户要的是“帮我把任务做完”，Codex 的集成完成度比一个有限输入 CLI 更
贴近需求。cu 若要面向这种用户，必须增加上层产品；现有安全记录不能替代
任务规划、可视化接管和业务结果验证。

## 4. 对照表

| 维度 | cu 当前实现 | agent-desktop + agent-browser | Codex Computer Use 公开能力 |
| --- | --- | --- | --- |
| 产品层 | 独立有限输入执行器 | 独立语义自动化工具链 | 集成任务能力与工作环境 |
| 模型 | 不内置；调用者选择 | 不内置；调用者选择 | 与 OpenAI 产品/模型体验组合 |
| 桌面观察 | 实际像素、图像与映射元数据 | OS 无障碍树；另有截图 | 视觉观察；配合应用和浏览器通道 |
| 操作目标 | 最新 observation 中的归一化坐标 | 当前能严格重识别的 ref；另有物理坐标 | 用户许可的应用与任务目标 |
| 证据生命周期 | 当前观察、TTL、单次消费；历史不可用于输入 | snapshot-qualified ref，每次重新识别；不是 cu 的单次消费协议 | 内部生命周期未公开核实 |
| 多步执行 | D2 有限前缀；视觉边界返回 checkpoint，丢弃尾部 | 同进程 batch、逐项结果、可等待；不是事务，默认错误后仍继续 | 内部任务循环；细节未核实 |
| 失败重试 | 持久 journal 未解决时挡住后续 act；partial/indeterminate 不重放 | disposition 指示是否 safe retry，严格 ref 与 actionability 检查 | 有接管/批准流程；内部效果恢复合同未知 |
| 背景操作 | Windows 物理前台输入，不提供隔离桌面 | 支持的语义动作可不抢指针；不是隔离 VM | macOS 后台，Windows 前台 |
| 平台 | Windows | macOS、Windows、Linux，具体动作不同 | 当前 Any App 文档列 macOS、Windows |
| 验证 | 调用者看最终像素/其他结果；输入成功不等于业务成功 | 属性、状态、等待及截图；语义验证不等于视觉正确 | 产品内看页面、复现、改代码、复验 |
| 集成 | CLI/skill；Pi 可按需 codemode 送图 | CLI、内置版本匹配 skill、C ABI、MCP、CDP 配套 | 应用许可、浏览器扩展、标注、plugins、长期任务 |

## 5. cu 真正能守住的边界，以及不能夸大的部分

### 5.1 已有的具体执行合同

cu 的 `actRegion` 在输入前检查当前观察与环境、持有 run lock、确认无未解决
效果状态，再写 durable intent。只有完成清理且计数一致才完成；需要视觉
决策时发布新 observation，失败保留效果状态。`observeRegion` 只有在新证据
发布后才可解决旧的未确定效果。[U1]、[U2]

这个组合比泛泛的“截图后点一下”具体：调用者知道哪张图支撑这一段输入、
哪些输入被发出、为何停止、下一张图是什么、旧观察为什么不能再用。
它可以作为视觉 fallback 的可靠边界和执行诊断基础。

### 5.2 必须承认的限制

- observation 有效不证明界面像素在执行前完全没变；TTL 和环境检查不是
  控件身份验证，也不是每次动作前重新做全图一致性断言。
- 图片来源与坐标映射可信，不保证模型选对目标，更不保证指令语义安全。
- 当前正常操作不以 foreground target identity 为输入门槛，也没有 Codex
  那样的应用许可产品界面。
- run lock 是 run 范围；不同 run/workspace 不是不同物理桌面。需要上层
  协调，不能把“可起多个 run”宣传成安全多 agent 并发。
- journal 解决的是输入效果与恢复，不证明外部业务操作 exactly-once。
- 清理和元数据脱敏不使截图本身不含隐私。远程模型收到图片后也不能称为
  整个链路“数据不离开本机”。
- cu 不是提示注入检测器、授权服务或沙箱。[U3]

因此，不应宣称“cu 比它们更安全”。更准确的是执行合同的重点不同；是否
对某类失败更可靠，要用故障注入与真实任务证明。

## 6. 效率：值得做什么，不值得复制什么

### 6.1 第一优先级：把当前视觉路径做好

1. 验证新版 skill 是否让模型默认把 `observe → read → image` 和
   `act → checkpoint image` 合在各自的一次 codemode 调用中。
2. 分阶段计时 capture、helper、PNG 验证、事务发布与 input，不只统计工具
   调用数。前一轮本机 400×300 小图 observe 中位数约 4.60 秒；PNG 文件读取
   约 0.40–2.32 毫秒，未包含视觉编码和模型推理。[U4]
3. 把物理交互类型与文本微批次用好，不添加无用的 move-then-click、不再
   采集已有 checkpoint。不要为了减少步骤自动放宽 D2 或续跑未知尾部。
4. 提升第一次定位和最终验收的图像可用性；按需局部观察、预览缩放与坐标
   映射可以研究，但不能靠盲目裁剪来隐藏定位证据。

cu 当前成本不仅是图片 token，还有输入与截图 helper 的启动、环境/记录检查
和发布。agent-desktop 的原生 Rust 与同进程 batch/C ABI 减少了某些进程边界；
这构成需要比较的实现方向，不构成它在所有应用上更快的现成数字。

agent-desktop 的 batch 会预先检查输入，再按顺序运行，但不是事务。默认某项
失败后后续项仍会运行，顶层 `ok: true` 也不意味着每项成功；依赖前一步的
固定序列需要 `--stop-on-error` 并逐项读取 disposition。它不自动重试，也不能
预先引用同一 batch 中尚未生成的 snapshot ref。[A6]

### 6.2 第二优先级：工具分流，而不是先复制 60 个命令

建议上层按实际能力选择：

```text
明确、稳定的数据/API操作       → 专用工具
网页有可用 DOM/CDP            → browser 工具
原生控件有可靠语义操作          → agent-desktop 或其他语义工具
必须看像素、特殊控件、真实拖动    → cu 的新观察 + 有限输入
```

这是任务级选择，不是遇错自动升级权限。失败后先确认是否已执行；需要进入
物理路径时重新观察并重新计划，不把 ref bounds 偷偷转换成已获授权的 cu
坐标。数据操作成功也不免除用户要求的视觉验收。

cu 的 skill 可以加入何时适合使用 cu、何时已有工具更合适的说明。若将来增加
UIA，只应以真实覆盖不足为依据，并为语义身份另建合同，不能让旧 observation
ID 混用两种信任模型。本轮不修改 skill 的任务路由，留待定位讨论。

### 6.3 第三优先级：借鉴可观测性与协作

值得研究版本匹配的内置指南、动作边界上的产物、只用于呈现的光标 overlay、
有界等待及明确的接管流程。像 Codex 那样的应用权限和人工接管，则属于上层
产品治理，不是加一个 CLI flag 就能等价获得。

暂不以复制常驻 agent、记忆系统、计划任务、内置浏览器或 macOS 解锁为 cu
本轮优化目标。这些需要独立的产品决定，不是由竞品功能列表自动导出的需求。

## 7. 用什么测试决定这条分野是否成立

建议用用户自己的任务，并加入可精确核验的受控故障用例。相同模型、相同
初始状态、相同输入策略；分别记录成功率、模型 usage、观察量、总耗时、
错误恢复次数和人工介入。下面的预期是待验证假设，不是测试结果。

| 用例 | 为什么有辨别力 | 核验方式 |
| --- | --- | --- |
| 标准原生表单，包含中文输入与复选框 | 语义 set-value/check 可能比视觉输入更省步骤 | 实际字段读回、事件与最终界面 |
| 无语义标识的自绘区域/图表编辑 | 检验视觉路径是否真正覆盖语义工具缺口 | 应用状态和目标像素共同核验 |
| 每行完全同身份的重复按钮 | 检验 ref 歧义与视觉定位差异 | 精确目标行事件，其他行无效应 |
| 可新启动及不可重启的 Electron 应用 | 区分 CDP 快路径、UIA 冷树和已有会话成本 | 会话是否保留、实际页面结果 |
| 已点击但回执丢失；输入后截图发布失败 | 检验是否重复执行、是否保留不确定状态 | 目标/诱饵事件日志、状态记录 |
| 覆盖窗口、缩放与显示拓扑改变 | 检验物理目标、映射与拒绝边界 | 目标/诱饵事件与截图映射 |
| 相同业务状态但渲染错误 | 检验语义读回是否足够，视觉验收是否有效 | 预先定义的渲染缺陷和界面检查 |

Codex 不能固定到完全相同的独立执行层时，应拆成“工具层机制测试”和
“完整产品任务测试”。不要把不同模型的成功率差异全算在桌面工具头上。

## 8. 社区材料应如何解读

DEV 文章把 273 vs 3,811 tokens、模拟 52 步的 198k vs 31k 等数字明确列为
项目作者自述，文章作者说没有亲自运行；本文不采用这些数字预测 cu 收益。
它的“失败后改 headed”建议与当前官方禁止自行升级 headed 的规则冲突，应
以当前官方 skill 和实现为准。[M1]

旧 HN 作者帖给出 Obsidian 的 CDP/无障碍读取时长，也是作者样本，且早于本轮
提交。帖中关于身份字段的说法不能覆盖当前严格身份实现。[M2]

Codex 大型 HN 讨论中，用户 `cjbarber` 的试用反馈认为许可流程顺畅、后台
浏览器测试方便，但也遇到少量焦点被占用、功能入口难找到等问题。这说明
集成与可发现性有价值，仍不意味着后台能力在每个平台、每个动作都无干扰。
它是个人体验，不是当前版本的对照测试。[M3]

可得出的产品启发：用户不仅要“模型能点”，还要低打扰、能知道发生了什么、
能方便启动正确能力、能在出错时接管。不能从点赞、星数或自报 token 节约
推出生产任务成功率。

## 来源

[A1]: https://agent-browser.dev/desktop
[A2]: https://agent-browser.dev/desktop/platforms/windows
[A3]: https://agent-browser.dev/desktop/snapshots-and-refs
[A4]: https://agent-browser.dev/desktop/guides/headed-mode
[A5]: https://agent-browser.dev/desktop/errors-and-recovery
[A6]: https://agent-browser.dev/desktop/guides/batch
[A7]: https://agent-browser.dev/desktop/guides/chromium-and-electron
[A8]: https://github.com/vercel-labs/agent-desktop/tree/17467da5142d471b1e3a6b24828a5d3ad4d8c547
[C1]: https://learn.chatgpt.com/docs/computer-use
[C2]: https://openai.com/index/codex-for-almost-everything/
[C3]: https://learn.chatgpt.com/docs/browser
[M1]: https://dev.to/gabrielanhaia/vercels-agent-desktop-lets-coding-agents-click-native-apps-without-moving-your-mouse-38p1
[M2]: https://news.ycombinator.com/item?id=49307819
[M3]: https://news.ycombinator.com/item?id=47796469
[U1]: ../specification/v1/contracts/action-and-evidence.md
[U2]: ../../src/act.ts
[U3]: ../../SECURITY.md
[U4]: efficiency-and-pi-image-delivery.md

agent-desktop 源码核对点：`crates/core/src/refs/resolve_saved_ref.rs`、
`refs/refs_store.rs`、`ref_action/mod.rs`、`actions/delivery_semantics.rs`、
`commands/mouse_click.rs`、`commands/screenshot.rs`、`src/batch/mod.rs`、
`crates/windows/src/tree/resolve/resolve_search.rs` 和
`skills/agent-desktop/SKILL.md`。源码中相关行为与本文的官方文档比较对应；
没有据此声称全部分支已在本机运行。
