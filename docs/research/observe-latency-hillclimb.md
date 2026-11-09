# Observe 时间效率 Hill Climb

## 结论与范围

2026-11-09，按“定位热点 → 小改动 → 交错对照 → 保留或丢弃”优化 Windows
`observe`。本轮保留一项改动：capture helper 不再逐次调用 C# 编译器，而在
当前 PowerShell 5.1 的 CLR 中用 Reflection.Emit 生成等价 P/Invoke 方法。

完整 CLI 的最终对照结果约省 **155–160 毫秒/次**，总体中位数降幅约 **9%**。
没有减少桌面状态检查、文件系统身份检查、PNG 验证或事务发布步骤；没有新增
DLL、原生 addon、常驻进程、跨命令缓存或额外安装要求。input helper 未改。

这是本机受控窗口结果，不是所有机器、应用或图片内容的性能保证。
本轮不是全桌面、多屏或锁屏环境的新增验收。

## 测量合同

- 主测量区间是 CLI 子进程启动到退出；包括 Node 启动、helper、文件校验、
  归档发布与命令清理，不包括 fixture 启动、workspace init 和独立像素复验。
- 补充的模块级测量在同一 Node 进程中调用 observe；它不包含逐次 Node/CLI
  冷启动，不能与 CLI 数字混用。
- 开启两个仓库自有的 WinForms target/decoy；只截图 target 的客户区。
  像素颜色由新 fixture token 派生，每次截图均用独立 PNG 解码器核对四个采样点。
- baseline/candidate 使用独立 workspace，每对测试历史数量一致，交替 AB/BA。
  历史逐次保留，不通过清空归档制造“更快”的结果。
- 桌面任务串行执行，避免其他测试的输入或窗口影响。性能对照不与完整回归并跑。
- 同时报告总体中位数、配对耗时差中位数和胜出对数，不只挑最快一次。
- 四色 fixture 的 PNG 压缩率很高。大图测试扩大的是受控像素区域，不代表照片、
  视频或复杂 UI 的内容分布。

环境：Node `v24.15.0`；stock Windows PowerShell `5.1.26100.9711`；
CLR `4.0.30319.42000`。Pi 的工具 shell 是 PowerShell 7；capture helper 仍是 5.1。

此前记录的小图 observe 为约 4.1–5.2 秒。本轮初始未修改代码时已经只有约
1.2–1.4 秒，不能把这个环境/测量时点差异归因于本轮代码。

## 原始分项定位

开发用脚本对原始 helper 加累计时间标记，并包装父进程同步 fs 调用。
这类插桩有额外开销，只用于热点定位，不用于最终性能胜负。

原始 400×300 捕获的一个样本：

| 项目 | 时间或数量 |
| --- | ---: |
| 模块级总耗时 | 1,264 ms |
| helper 子进程总耗时 | 866 ms |
| C# 编译阶段 | 224 ms |
| pre-snapshot 后到像素就绪 | 43 ms |
| 像素就绪后到 PNG flush | 16 ms |
| 父进程 `realpath.native` | 1,435 次 / 233 ms |
| 父进程 `lstatSync` | 1,544 次 / 25 ms |

helper 内部累计 ready 时间约 533 ms；子进程总耗时与其差值还包含启动及收尾，
不是可以直接删掉的单一阶段。父进程包含多个边界的重复读取与归档检查，调用
数量随 retained history 增加；因此一次 observe 的成本不只是生成一张 PNG。

## 候选与取舍

### 1. 减少 Add-Type 编译引用：未保留

在临时构建副本中尝试缩小 C# 引用集合。7 次探索没有显示收益；这组不是严格的
交错对照，因此不据此宣称一个确定的退化比例。没有应用到源码。

### 2. Reflection.Emit P/Invoke：保留

动态生成与原声明相同的 Win32 方法：

- Winapi calling convention；
- bool、IntPtr、uint32、by-ref 输出参数；
- Unicode desktop-name marshaling；
- 原来需要的 SetLastError 和 PreserveSig。

连接状态查询及 input-desktop 名称读取转为 PowerShell 包装函数，仍然释放
WTS buffer 和 desktop handle。PMv2 设置仍在 WinForms/Drawing 加载前执行。
原有前后 snapshot、destination CreateNew、flush、资源释放和内容无关失败回执
保持不变。

主要改动在 [`src/helper/windows-capture.ps1`](../../src/helper/windows-capture.ps1)。
决定依据见 [Decision 001](../specification/v1/decisions/001-command-scoped-windows-helper.md)。

### 3. 简化反射属性构造并合并程序集加载：未保留

在第 2 项基础上尝试少创建属性对象及合并 AssemblyName 加载。12 对模块级测试：
总体中位数仅低 0.4%，配对差中位数为 **-3 ms**，6/12 胜出。没有稳定收益，丢弃。
这是一组组合探索，不用于证明其中任一修改单独有效或无效。

### 4. New-Object 换直接构造器：未保留

把 Bitmap/FileStream 的 `New-Object` 改为 `::new`，12 对 CLI 测试：
总体中位数看似低 7.5%，但配对差中位数为 **-19 ms**，只有 4/12 胜出。

这说明仅比较两组中位数可能被时序与分布误导。按配对证据拒绝该候选，源码保留
原构造方式。

## 保留改动的结果

以下最终 CLI 测试以未修改 helper 为 baseline，以实际源码构建为 candidate。
模块级初筛单独列出。

| 测量路径 | 区域 | 对数 | 原始中位数 | 新中位数 | 降幅 | 胜出 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 模块级初筛 | 400×300 | 12 | 1.304 s | 1.136 s | 12.9% | 11/12 |
| 完整 CLI | 400×300 | 20 | 1.590 s | 1.442 s | 9.3% | 20/20 |
| 完整 CLI | 1280×720 | 12 | 1.739 s | 1.585 s | 8.8% | 10/12 |

两组最终 CLI 的配对节省时间中位数分别是 **155 ms** 和 **160 ms**。
总体中位数之差与配对差中位数是不同统计量，不能互换。
大图对照有两对明显的耗时波动；没有删除这些样本。

小图 CLI 的后段比前段慢，符合 retained-history 成本及环境波动的共同影响。
不能声称每次 observe 都稳定落在某个固定时长，更不能把初筛的 12.9% 套用到
所有任务。

## 回归与实际交付检查

- 新增“受控阻断 runtime C# compilation 仍能截图”的测试：旧 helper 为
  `capture_failed` / exit 1，新 helper 成功，四个随机颜色像素与尺寸均核对通过。
  这是受控的编译依赖测试，不代表绕过 Windows 动态代码安全策略。
- `npm test`：514 个测试，513 通过、0 失败、1 个因当前 Windows 无特权
  file-symlink 策略跳过。
- 修复一个本轮暴露的测试竞争：`windows-input-parent.test.ts` 原来比较整个系统
  TEMP 的目录列表，另一个测试正常清理 `cu-input-helper-functions-*` 会造成误报。
  现在给该测试进程独立 TEMP/TMP；input 执行器没有改变。
- 打包后安装的 public E2E：observe 与 act 两个测试均通过。覆盖实际 target 像素、
  displays、actionable evidence、输入事件、checkpoint 和 unresolved-input 禁止重放。
- 本机全局 `cu` 的 npm junction 指向当前仓库；源码、dist 与全局命令所用 capture
  helper 的 SHA-256 一致，构建已生效，无需重新安装。

以上检查不新增全桌面隔离验收、物理多屏验收或符号链接权限豁免。

## 如何复测

先准备两个独立且已 build 的代码目录，一个是未修改 baseline，一个是 candidate。
本仓库也需 build，以提供测试 fixture 支持。暂停其他桌面操作后运行：

```powershell
npm run build
node scripts/benchmark-observe.mjs --baseline C:/builds/cu-before --candidate D:/builds/cu-after --rounds 20 --output C:/results/cu-observe.json
```

[`scripts/benchmark-observe.mjs`](../../scripts/benchmark-observe.mjs) 会打开仓库自有
400×300 fixture，记录逐对 JSON，核验像素，最后清理窗口与临时 workspace。
`--baseline` 可省略以测单个版本，但单版本数字不用于归因优化收益。

本轮详细记录位于本机
`C:/Users/mapleland/ego/cu-observe-hillclimb-20261109/`：

- `baseline-profile.json`：分项及 fs 调用计数；
- `emit-paired-1.json`、`emit-paired-1-summary.json`：模块级初筛；
- `emit-fast-paired.json`、`emit-fast-paired-summary.json`：反射组合微调；
- `final-cli-small.json`：最终 20 对 CLI 数据；
- `final-cli-large.json`、`final-cli-large-summary.json`：大图对照；
- `ctor-cli.json`：直接构造器候选的逐对数据；
- `large-fixture.ps1`、`large-pattern.json`、`paired-large.mjs`：大图临时实验材料。

分项插桩、各候选构建副本与原始结果不进入产品包。

## 下一次爬坡的方向与禁区

剩余重点是 PowerShell 固定启动开销和父进程文件系统/归档检查，尤其是历史增长时。
值得继续拆解 `regular-file.ts` 与 `observation-archive.ts` 的重复工作，但必须先证明
替代方案仍在所有使用、发布和 cutover 边界获得新鲜的身份与内容证据。

不得以这些方式制造收益：

- 缓存桌面/session/topology 快照；
- 删除或跨不安全边界缓存 realpath、inode、父目录检查；
- 少检查 PNG、跳过最终落盘验证或 fsync；
- 测试前反复清空历史却把结果当成普通 retained-history 路径；
- 重放 act，或令 helper 跨命令存活。

本轮止于有明确证据、改动局部且通过受控 E2E 的收益，不宣称达到全局最优。
