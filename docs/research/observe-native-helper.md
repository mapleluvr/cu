# 原生 Capture Helper：实现与 Observe 对照

## 结果与当前状态

2026-11-09，用户明确允许原生重写，要求以保留功能及性能为准，不以重写成本排除方案。
已将 `observe`、`displays` 和 action checkpoint 的 capture 后端切换为 **独立原生 C++ EXE**。
Node 直接启动 `cu-capture.exe`，命令结束即退出。当前本机源码构建与全局 junction 安装已使用此路径。

**最终完整 CLI 对照约省 0.48–0.49 秒/次，32/32 对更快。** 没有常驻进程，未缓存桌面状态。
input helper 保持原实现，所以 **整个 cu 仍需要 PowerShell 5.1 执行输入**；capture/displays
本身不再启动 PowerShell 或 CLR。生产 capture 失败时不回退到另一后端。

## 测量

用户说明同时运行游戏；实验不干预其负载。Windows x64，Node 24.15.0，基线为已做
Reflection.Emit 优化的 stock PowerShell 5.1，不是更早每次编译 C# 的版本。

两边使用相同的当前 Node 代码、验证、归档与清理逻辑；独立构建副本仅替换 capture
helper 调度。每次新进程，OS 文件缓存已热，交错顺序轮转并反向。计时包含完整
Node CLI 启动至退出，不含 fixture/init、之后的独立 PNG 解码及像素核对。

| 条件 | 每路次数 | 5.1 中位数 | 原生中位数 | 总体中位数降幅 | 配对节省中位数 | 原生更快 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 400×300，每次新空归档 | 20 | 965.25 ms | 485.76 ms | 49.68% | 482.64 ms | 20/20 |
| 1280×720，逐轮保留等量历史 | 12 | 1,181.01 ms | 684.78 ms | 42.02% | 489.17 ms | 12/12 |

最终 **64 次捕获均成功**，随机色块实际像素与尺寸核验全部通过，没有剔除失败样本或重试。
两种尺寸的截图都来自测试自有 target；大尺寸 fixture 只在实验副本内放大，未抓取整个桌面或游戏。
色块图像压缩率较高，不把结果外推为任意复杂图像的固定耗时。

初筛另有 400×300、20 对等量增长历史结果：1,097.00 → 634.50 ms，下降 42.16%，
配对省 479.76 ms，20/20 更快，40 次实际像素均通过。连同最终组共 104 次测量捕获成功。

空归档与有历史条件不可直接横比；总体中位数之差也不等于配对差中位数。
结果支持保留原生改动，但没有给出对所有硬件、负载和长期历史的固定延迟保证。

[逐样本数据](data/observe-native-20261109.json)保留每次耗时、状态、图片大小和像素验证结果。

## 实现与行为边界

源码：[capture.cpp](../../src/helper/native/capture.cpp)。

- Win32 获取 PMv2 DPI awareness、进程 session、WTS connected 状态、可见 window station、
  input desktop、前台窗口及进程；只接受默认可交互桌面。
- `GetSystemMetrics` / `EnumDisplayMonitors` / `GetMonitorInfoW` 获取显示拓扑，保持排序、
  拓扑哈希及 display ID 的既有 JSON 字段顺序。
- 保留 pixel、normalized、display_region、full_screen 四种 selector；负坐标、半开区域、
  显示器绑定、全屏并集、尺寸限制和陈旧 ID 拒绝逻辑全部实现。
- GDI `BitBlt(SRCCOPY)` 获取像素，GDI+ 24-bit bitmap 编码 PNG，继续使用原截图与编码技术。
  本次没有同时改成 DXGI/WGC，性能收益可归因于移除 PowerShell/CLR 和脚本执行层。
- 请求为最多 64 KiB 的规范 UTF-8 JSON；nlohmann/json 3.12.0 ordered JSON 加重复键拒绝、
  深度上限、精确字段/标量/整数形态验证及规范序列化逐字节比较。
- 目标文件限定在命令 TEMP 中，以 `CREATE_NEW`、独占打开和 `FlushFileBuffers` 写入，
  从同一持有句柄回读并计算 BCrypt SHA-256。
- 截图前后完整环境身份必须一致；display 查询允许前台窗口变化，但桌面和拓扑必须一致。
- 发布前失败通过**持有的文件句柄**标记删除，只清理本次创建的文件；原有文件不覆盖、不删除。
- 输出仍为现有私有版本化协议，异常仅输出 `capture_failed`。Node 独立进行 PNG、字节、
  哈希、文件身份、事务归档与 live observation 验证，资源/证据所有权不变。

命令 TEMP、真实路径及源文件校验仍由父进程负责。helper 没有工作区控制记录写入权限，
没有 native input 调用，没有跨命令桌面缓存。

## 构建、包与依赖

[build-native.mjs](../../scripts/build-native.mjs) 优先使用与 Node 架构匹配的 MinGW-w64，
不可用时使用 CMake/Visual Studio C++ 工具链。`CU_CXX` 可以显式指定 MinGW 编译器。
本机实际验证过 GCC 14.2.0 与 MSVC 19.42 两条构建路径及各自的核心/实际像素测试。

- GCC x64 构建：380,416 字节，约 372 KiB。
- MSVC x64 Release：333,824 字节，约 326 KiB。
- 使用静态 C/C++ runtime 链接策略；PE imports 为 Windows 系统 DLL，未要求 MinGW DLL、
  新 CLR 或另装图形库。
- vendored JSON header 的版本、来源与 SHA-256 见
  [依赖记录](../../src/helper/native/vendor/README.md)。MIT notice 复制进安装包。
- `npm run build` 编译 EXE；安装包带编译产物，用户无需安装编译器。
- 历史 PowerShell capture 源码留在仓库用于对照和参考测试，不进入产品包，且不是运行时 fallback。
- x64 是本次实测目标。其他架构虽有构建选项，尚无该架构的运行验收，不能因此声称已验证。

## 验证结果

- 原有完整回归：**513 通过，0 失败，1 个符号链接权限条件跳过**。
- 原生行为测试：**4/4 通过**，覆盖 display 查询、30 组非法协议/selector、文件保留、
  Unicode 路径、实际随机 target 像素和 display-bound 捕获。GCC 与 MSVC 构建分别运行通过。
- 原生核心测试：负 origin、normalized 边界、full-screen 并集、拓扑重复/溢出、display ID
  失效、前后环境身份、规范 JSON 与持有文件句柄的失败清理通过。
- 包安装后的 observe E2E：**1/1 通过**；真实像素、归档、可行动证据均核验。
- 包安装后的 act E2E：**1/1 通过**；受控 target 效果、无 decoy 效果、checkpoint、
  未决输入禁止重放均核验。

原生测试源码：[协议与像素](../../test/windows-capture-native.test.mjs)、
[核心行为](../../test/native/capture-core.cpp)。旧 PowerShell 源码结构检查仍存在，但不把它们
当成新原生后端的行为证据。

格式化曾改变 Windows SDK include 顺序导致重建失败，已修复，并在 native 目录禁用
include 自动排序；之后重建及包级 E2E 均通过。C++ 的实机编译/测试是有效验证证据；
不把没有配置完整 Windows SDK include 的 LSP/cpp-check 静默或启动失败当作 clean。

本轮没有隔离 VM/Sandbox 全桌面、锁屏、远程会话或显示器热插拔验收，沿用已有发布限制。
full_screen 的选择与拓扑计算在合成用例验证，未在用户普通桌面上做全屏捕获。

## 复现

```powershell
npm run build
npm run test:native
node scripts/experiments/observe-native/prepare.mjs C:/cu-native-small small
node scripts/experiments/observe-powershell/measure.mjs C:/cu-native-small/manifest.json C:/cu-native-small/result.json 20 --fresh ps51 native
node scripts/experiments/observe-native/prepare.mjs C:/cu-native-large large
node scripts/experiments/observe-powershell/measure.mjs C:/cu-native-large/manifest.json C:/cu-native-large/result.json 12 ps51 native
```

输出目录必须不存在。所有桌面工作串行；不要同时运行两个 fixture、bench 或输入测试。
测量器每个样本立即落盘，不因失败重试；`--fresh` 允许继续有限计划并独立报告失败数，
有历史模式则第一次失败即停止，避免两边历史数量失衡。

本机原始构建、编译器对照、日志及数据在 `C:/Users/mapleland/ego/cu-native-capture-20261109/`。
设计决定和开发要求已同步；下一处可独立测量的热点是父进程归档与随 retained-history
增长的文件系统工作。
