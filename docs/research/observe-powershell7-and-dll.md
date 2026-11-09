# PowerShell 7 与 DLL：Observe 对比及 Hill Climb

> 历史实验记录：本阶段结束时仍使用 5.1。随后完成并采用了
> [原生 C++ capture helper](observe-native-helper.md)；本文的基线与结果保持原样。
> 当前复测脚本会在独立副本中重建 PowerShell 调度路径。

## 结论

2026-11-09，在用户同时运行游戏的 Windows 主机上，比较当前 PowerShell 5.1
实现、pwsh 7.6.9、预编译 P/Invoke DLL，以及减少程序集依赖的组合候选。

**本轮不切换生产运行时。** pwsh 7 的完整 observe 比当前 5.1 慢；预编译 DLL
可以追回几十毫秒，但没有逆转结果。5.1 加小 DLL 的独立复核仅省约 12 ms。
保留可复现实验工具和 DLL 源码，不把这点收益扩大为必须新增产品二进制依赖的理由。

最终两组共 **160 次捕获全部成功，像素全部核验通过**。实验未改 `src/`、
产品打包配置、全局安装版运行时或 input helper。

## 测量口径

- Windows PowerShell：`5.1.26100.9711` / CLR `4.0.30319.42000`。
- PowerShell 7：`7.6.9` / `.NET 10.0.14` / x64。
- Node：`v24.15.0`。
- 本机查询到两个显示器，虚拟屏幕为 `(-2560, 0, 5120, 1600)`；只截图仓库自有
  400×300 target 客户区，不截图游戏或整个桌面。
- 用户明确说明同时在运行游戏。保留这种负载；不关闭游戏，也不删去耗时较高的样本。
- 测量 `node <variant>/dist/src/cli.js observe ...` 子进程启动到退出，含 helper、
  PNG 校验、归档发布、锁及清理；不含额外的 npm/PowerShell 命令 shim。
- fixture 启动、workspace init、独立 PNG 解码与像素核对在计时区间外。
- 每张图核对由 fixture 随机 token 决定的四个像素及尺寸，最后核对没有注入输入事件。
- 最终主对照每次使用新的、已初始化的 workspace，均为首次 observe、空归档。
  这防止失败导致两边历史数量失衡；不能把数字当作长历史 run 的耗时。
- 多路测量采用轮转加反向顺序；两路初筛为 AB/BA。分别报告总体中位数、同轮配对
  耗时差中位数、胜出对数、失败次数。总体中位数之差不等于配对差中位数。
- 每次启动新的进程，但操作系统文件/程序集缓存已热；不是重启机器后的冷启动测试。

机器负载在不同实验时段变化明显，因此跨表比较绝对耗时没有归因意义。
本文性能判断均基于同组交错配对。

## pwsh 7 的兼容性适配

未经适配的当前 helper 在 pwsh 7 下直接失败：`capture_failed` / exit 1。
私有诊断确认 `.NET 10` 的 `System.AppDomain` 没有 `DefineDynamicAssembly`。

实验副本改用：

```powershell
[Reflection.Emit.AssemblyBuilder]::DefineDynamicAssembly(
  $assemblyName, [Reflection.Emit.AssemblyBuilderAccess]::Run
)
```

此 API 在本机 5.1 和 7 上都能运行。初始运行时对照两边使用相同的适配版 helper，
仅子进程 executable 不同。最终主对照则纳入完全未改的当前 5.1 构建。

更换 executable 时，仍从系统 Windows PowerShell 路径推导 `SYSTEMROOT/WINDIR`。
不能把 `C:/Program Files/PowerShell/7` 向上三层当作 Windows 系统目录。

没有给公开 CLI 增加运行时开关；这些替换只发生在独立实验构建副本。

## 初始基线与分项

12 对、两边保留等量历史的完整 CLI 对照：

| 方案 | 中位数 | pwsh 7 胜出 | 配对结果 |
| --- | ---: | ---: | ---: |
| 5.1，兼容 API | 1,650 ms | — | — |
| pwsh 7，兼容 API | 1,743 ms | 2/12 | 慢 110 ms |

单独 16 对 fresh-process `-Command "exit 0"` 的启动耗时中位数：

| 运行时 | 中位数 |
| --- | ---: |
| 5.1 | 188 ms |
| pwsh 7 | 232 ms |

它只是进程启动的参考下限，不执行 helper，不能直接当作 observe 耗时。

helper 插桩还显示：pwsh 7 的原生方法初始化略快，但 `Add-Type` 加载程序集阶段更贵。
四次初筛中，5.1 的 native-ready 中位数约 74 ms，pwsh 7 约 64 ms；从 native-ready
到 assemblies-ready 约为 57 ms 与 192 ms。这些数字用于定位，不是最终总收益。

## Hill Climb 候选

### 小型 P/Invoke DLL

将 8 个原生函数声明预编译为 **3,584 字节的 managed AnyCPU DLL**，在命令内
`Assembly.LoadFrom`。保留 PowerShell 包装函数及所有桌面、DPI、拓扑、协议、
PNG、发布和清理检查。

源码：[CuCaptureNative.cs](../../scripts/experiments/observe-powershell/CuCaptureNative.cs)。
使用系统 .NET Framework 4 的 `csc.exe` 构建，无额外 SDK 安装，5.1/7 均通过实测。
这是构建一次、每个 helper 进程加载一次；不是常驻进程或缓存截图。

### 直接加载程序集

用带完整身份的 `Assembly.Load` 取代 `Add-Type -AssemblyName`，分别尝试单独使用
以及与 DLL 组合。程序集加载阶段明显缩短，但首次 JSON cmdlet 模块加载推迟到
后面：不能把阶段时间平移算成总体加速。

pwsh 7 单独替换的 12 对完整 CLI 初筛：1,762 → 1,754 ms，仅 0.45%，胜负 6/12。
因此没有认定为稳定的独立收益。

### DLL 中使用 Win32 显示器枚举

另一个 **6,144 字节 DLL** 用 `GetSystemMetrics`、`EnumDisplayMonitors`、
`GetMonitorInfoW` 提供 virtual-screen 与 monitor 信息，删除 WinForms 程序集依赖。
排序、拓扑校验、前后 snapshot 与实际截图逻辑仍由原 helper 执行。

源码：[CuCaptureTopology.cs](../../scripts/experiments/observe-powershell/CuCaptureTopology.cs)。
它与小 DLL 是两个独立构建候选，均定义 `CuCaptureNative`；不能合并到同一程序集编译。

本机双屏 `displays` 回执与原实现完全一致；测试覆盖负 origin、选择器验证与陈旧
显示器绑定。没有新增锁屏、远程会话、镜像屏或显示设备热插拔的实机验收。

## 最终五路对照

空归档、每路 20 次、总计 100 次；每路 0 失败。完整 CLI 数据：

| 方案 | 中位数 | 相对当前 5.1 的配对节省 | 比当前 5.1 快 |
| --- | ---: | ---: | ---: |
| 当前 5.1 | 957 ms | — | — |
| pwsh 7，兼容 API | 1,037 ms | -78 ms | 0/20 |
| pwsh 7 + 小 DLL | 1,008 ms | -48 ms | 2/20 |
| pwsh 7 + DLL + 直接加载 + 原生枚举 | 1,009 ms | -33 ms | 3/20 |
| 5.1 + DLL + 直接加载 + 原生枚举 | 929 ms | +27 ms | 19/20 |

在同一组内，以未优化 pwsh 7 为基线：

- 小 DLL：配对省 **30 ms**，16/20 胜出，总体中位数下降 2.74%。
- 原生枚举组合：配对省 **38 ms**，18/20 胜出，总体中位数下降 2.70%。
- 原生枚举组合相对小 DLL：配对反而慢 **3 ms**，9/20 胜出，不认定额外收益。

### 5.1 的 DLL 独立复核

另开 20 轮三路对照，总计 60 次；全部成功、像素通过：

| 方案 | 中位数 | 相对当前 5.1 配对节省 | 胜出 |
| --- | ---: | ---: | ---: |
| 当前 5.1 | 952 ms | — | — |
| 5.1 + 小 DLL | 939 ms | 12 ms | 16/20 |
| 5.1 + DLL + 直接加载 + 原生枚举 | 937 ms | 22 ms | 18/20 |

小 DLL 的总体中位数改善 1.41%；组合改善 1.61%。组合相对小 DLL 只配对省 7 ms，
12/20 胜出。证据不支持为了这个额外增量把 WinForms 枚举重写纳入生产路径。

## 中断与失败，不隐藏样本

原生枚举候选早期两组 growing-history 对照中断：

- 第一组 5 次成功后出现 1 次 `capture_invalid`。该次没有保留私有异常，不能补写原因。
- 第二组 22 次成功后出现 1 次 `capture_invalid`；诊断确认是原有的
  `environment_changed` 检查，未保留具体变化字段。
- 用户说明同时运行游戏，这解释了负载波动的条件；它本身不能证明是哪一项环境身份变化。
- 这两组不用于性能结论，原始日志保留；之后的 12 次诊断捕获均通过。
- 最终 fresh 模式预先规定：失败计入记录、不重试，下一轮使用新 workspace；性能配对
  仅使用同轮双方都成功的样本，并报告失败数。最终 160 次没有发生失败，无需排除任何样本。

所有环境检查原样保留；没有通过删除前后校验来使候选“通过”。

## 验证

六种配置运行了现有 capture-helper 测试：5.1 兼容版、pwsh 7 兼容版、两种运行时的小 DLL、
以及两种运行时的原生枚举组合。每种 **13/13 通过**，合计 78 项；其中含现有源码结构检查。
实际行为包括：随机 target 像素、编译不可用、非规范私有协议、现有文件保留、拓扑、
选择器、display 查询和陈旧绑定拒绝。fixture 自身始终由 stock PowerShell 创建。

五路验证的公开 `displays --json` 回执完全一致。测试没有把图片路径当作像素验证。
JavaScript 做了语法检查；两个 C# 源文件由真实 .NET Framework 编译器独立构建并执行。
LSP 没有报告诊断，但 C# 两个文件的服务器未给出覆盖确认，因此以实际编译和运行结果为准。

## 复现

先在本仓库运行 `npm run build`。准备脚本要求输出目录不存在，避免覆盖其他实验。
下面以本机默认安装路径示例：

```powershell
node scripts/experiments/observe-powershell/prepare.mjs C:/cu-experiment "C:/Program Files/PowerShell/7/pwsh.exe"
node scripts/experiments/observe-powershell/verify.mjs C:/cu-experiment/manifest.json ps51-portable ps7-portable ps7-dll ps7-dll-load-native ps51-dll-load-native
node scripts/experiments/observe-powershell/measure.mjs C:/cu-experiment/manifest.json C:/cu-experiment/result.json 20 --fresh ps51-current ps7-portable ps7-dll ps7-dll-load-native ps51-dll-load-native
```

去掉 `--fresh` 会保留历史，并在第一次失败时停止，保证仍可比较等量历史。
所有样本和失败都立即写入输出 JSON；脚本清理自己的临时 workspace 和 fixture。
构建副本及 DLL 保留在所选输出目录，便于审查。运行时选择不会写回产品源码。

工具入口：[prepare.mjs](../../scripts/experiments/observe-powershell/prepare.mjs)、
[measure.mjs](../../scripts/experiments/observe-powershell/measure.mjs)、
[verify.mjs](../../scripts/experiments/observe-powershell/verify.mjs)、
[startup.mjs](../../scripts/experiments/observe-powershell/startup.mjs)。

## 数据与后续判断

仓库中保留了 [逐样本 JSON](data/observe-powershell-20261109.json)，包含初筛、
两组最终矩阵、启动测量、分项摘要及中断说明。
本机完整构建、原始日志和插桩脚本在
`C:/Users/mapleland/ego/cu-pwsh7-hillclimb-20261109/`。

本轮不把 pwsh 7 作为提速路径，也不将更复杂的显示器枚举 DLL 纳入产品。
小 DLL 是可用的备选，但 5.1 上的十几毫秒收益不足以成为当前最高优先级。
若目标是进一步大幅降低 observe 延迟，下一步应测量父进程归档/文件系统工作，
或评估把更多 helper 逻辑移入独立编译组件的收益；都需要新的行为等价与发布验证，
不能用本轮 8 个 P/Invoke 声明的 DLL 结果代替。
