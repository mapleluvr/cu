# Observe 脱离 PowerShell 的路径

> 本文保留最初的路径比较与空进程测量。用户随后明确不以重写成本限制方案，
> 已实现并采用原生 C++ capture helper；当前结果见
> [原生 helper 实测](observe-native-helper.md)。下文 C# 优先建议已被该决定替代。

## 建议

2026-11-09，在 PowerShell 7 和小 DLL 对照之后，优先评估 **命令级 C# EXE helper**。
Node 直接启动 EXE，保留现有 stdin/stdout 私有协议和父进程验证、归档、发布职责。
该路径可以去掉 PowerShell 宿主、脚本解释和 cmdlet 初始化，并继续在每条命令结束时退出。

本轮只验证独立程序的编译、执行及启动成本。尚未移植完整 capture helper，
没有更改生产执行器或声称完整 observe 已获得以下启动时间差对应的收益。

## 可行路径比较

| 路径 | 能消除的主要开销 | 代价与适合阶段 |
| --- | --- | --- |
| C# / .NET Framework EXE | PowerShell 宿主、脚本和 cmdlet；保留 CLR | 现有逻辑多为 .NET/PInvoke，迁移范围较小；首选原型 |
| C/C++/Rust 原生 EXE | PowerShell 和 CLR | 需要移植协议、Win32 结构、PNG 编码、错误与资源处理；后续性能候选 |
| 现代 .NET 自包含或 NativeAOT EXE | PowerShell；AOT 进一步避免运行时 JIT | 工具链、包体、目标架构和 native interop 构建要求更高；本轮未测 |
| Node 原生 addon / FFI | helper 子进程启动与 IPC | Node 本身没有通用内建 Win32 FFI；需额外桥接、目标架构产物及崩溃隔离设计 |
| 常驻 helper | 多次命令摊薄启动与图形初始化 | 改变当前命令级生命周期，新增身份、超时、崩溃、残余状态和恢复职责 |

纯 JavaScript 无法凭 Node 标准库调用 BitBlt、WTS、桌面状态等 Win32 API。
换成 Python ctypes 或 Bun FFI 可以减少某些桥接代码，但引入新的运行时/图像编码依赖，
目前没有证据比直接编译 helper 更合适。

现有设计明确使用 stock PowerShell、无必需 daemon。这些是当前实现与契约选择，
不是操作系统技术限制。EXE 生产迁移时应更新对应决定与发布条件；本轮仅生成实验产物。

## 启动成本实测

本机具备 .NET Framework `csc.exe`、GCC 14.2.0 和 .NET SDK 9.0.320。
本轮使用前两者编译空程序，不安装工具、不下载依赖。用户此前说明同时运行游戏，
本轮不干预其负载。

20 轮五路轮转加反向测量，各程序仅启动后返回 0：

| 程序 | 中位数 | 相对 5.1 配对节省 | 更快对数 |
| --- | ---: | ---: | ---: |
| Windows PowerShell 5.1 | 182.66 ms | — | — |
| pwsh 7.6.9 | 228.40 ms | -44.49 ms | 0/20 |
| C# / .NET Framework EXE | 50.59 ms | 132.19 ms | 20/20 |
| GCC 原生 EXE | 25.60 ms | 157.18 ms | 20/20 |
| Node 空进程 | 90.25 ms | 91.76 ms | 20/20 |

计时包括从 Node `spawnSync` 启动子进程到退出；无 shell 包装，全部设置 `windowsHide`。
这是每次新进程、操作系统文件缓存已热的测试，不是机器重启后的冷启动。
全部 100 次运行 exit 0、stdout/stderr 为空。

C# 空 EXE 为 3,584 字节；原生空 EXE 为 14,848 字节。这不是未来完整 helper 的包体。
原生空程序 imports 为系统 Kernel32/UCRT API sets；没有额外的 MinGW DLL import。
真实图像编码与完整协议会改变依赖及体积。

**这些程序没有执行桌面校验、捕获、PNG 编码或归档。** 数字只证明运行时启动层
存在可减少的开销；不能将完整 observe 直接写成 51 ms/26 ms，也不能简单减去此前
另一时段的基线。完整 helper 的 CLR/JIT、库加载和任务成本必须在同组对照里重测。

[逐样本记录](data/observe-executable-startup-20261109.json)保留全部数据。

## 建议的最小迁移边界

第一步只迁移 capture/displays helper，保留 input helper：

```text
Node observe
  -> 创建命令 TEMP 与请求
  -> 直接启动 cu-capture.exe
  -> stdin：现有版本化请求
  -> EXE：DPI、session/desktop、前后快照、区域捕获、PNG、清理
  -> stdout：现有版本化结果
  -> Node：验证内容与身份、归档、发布 live observation、释放锁
  -> EXE 与命令资源退出
```

这不会要求更改公开 `cu observe` 回执或重新设计 archive。
移植必须保留以下行为并对照验证：

- UTF-8、请求大小、精确字段、规范数字与 JSON 形态、单一结果及无泄露诊断；
- PMv2 在图形初始化之前，session/input-desktop admission；
- 相同坐标映射、显示器身份和区域限制；
- 截图前后环境校验；
- destination CreateNew、PNG flush、hash、清理所有权；
- 父进程已有的完整 PNG、文件身份、事务发布及超时/退出分类。

现有测试中的运行行为可迁移为后端共同测试；PowerShell AST/源码结构检查不能
直接当作 EXE 的验收。实际像素、非法协议、清理、环境变化、打包后 checkpoint
都需要复验。之后再测完整 CLI；有明确收益再修改产品构建和分发。

## 其他独立优化方向

**父进程归档/文件系统工作**应与 helper 迁移独立测量。此前 profile 中有约
1,500 次 realpath/lstat 调用，历史增长也会增加成本。改用 EXE 不会自动消除它们。
减少重复工作必须保留跨使用/发布边界的新鲜身份与内容证据。

**DXGI Desktop Duplication / Windows Graphics Capture**优化的是像素获取路径，
对连续、高频或特定窗口捕获可能更合适。目前单张 observe 的主热点包含启动和归档；
每命令新建 D3D/捕获对象的成本必须计入，不能套用视频连续帧吞吐数字。

**常驻 helper**可以进一步摊薄启动，但需要另立生命周期设计，不能偷偷让当前 helper
跨命令存活。当前推荐先验证无需 daemon 的独立 EXE。

## 复现启动测量

本仓库需已 build，以提供 stock PowerShell 路径解析支持。输出目录必须不存在：

```powershell
node scripts/experiments/observe-powershell/executable-startup.mjs C:/cu-exe-startup D:/ProgramFiles/mingw64/bin/gcc.exe "C:/Program Files/PowerShell/7/pwsh.exe"
```

脚本：[executable-startup.mjs](../../scripts/experiments/observe-powershell/executable-startup.mjs)。
源码：[EmptyHelper.cs](../../scripts/experiments/observe-powershell/EmptyHelper.cs)、
[empty-helper.c](../../scripts/experiments/observe-powershell/empty-helper.c)。
编译结果与原始数据在本机 `C:/Users/mapleland/ego/cu-executable-startup-20261109/`。
