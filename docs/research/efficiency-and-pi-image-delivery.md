# cu 效率调研与本轮决定

日期：2026-11-09。cu 源码基线：`d1b04f0`；Pi：本机 1.4.0。

## 已确认的断点与决定

`observe` 返回 `imagePath`；`act` 遇到 checkpoint 时返回
`checkpoint.imagePath`。普通 bash 结果只有文本，所以截图生成不意味着模型
收到了图像输入。Pi codemode 可以在一次外层工具调用中串行完成
`bash → 解析 receipt → read → image()`。本轮已通过真实受控窗口验证。

本轮采用现有 skill 指导这个组合，不增加 CLI 参数、Pi 扩展或 MCP 服务：

- `view = "image"`：需要定位、理解界面、视觉验收时直接交付图片。
- `view = "none"`：只返回采集结果，供归档或程序处理；不调用 `image()`。
- checkpoint 复用已经捕获的图像，不因结果只有路径而再运行 `observe`。
- 在下一步动作已经明确时，同一 codemode 调用完成写 action 文件、执行和
  checkpoint 交付。模型需要新图作决策时，仍要进入下一轮模型推理。

`view` 只是 skill 示例中的变量，现有 CLI 不接受这个 flag。主规则放在
skill description 和正文开头；具体实现见
[Pi codemode recipes](../../skills/cu-automation/references/pi-codemode.md)。

## 本机测量

使用仓库的受控窗口 fixture，捕获其 400×300 内容区，没有向应用注入输入。
以 fixture 随机 token 导出的颜色核对 PNG 像素，避免只凭文件存在判定成功。
所有工作区均在系统临时目录，未创建仓库内 `.cu/`。

| 测量 | 样本 | 结果 | 解释范围 |
| --- | --- | --- | --- |
| CLI `observe` 总时长 | 连续 5 次 | 4.13、4.35、4.60、4.72、5.18 秒，排序后中位数 4.60 秒 | 此机器、小图、当前实现；不能外推完整任务耗时 |
| 已生成 PNG 的文件读取 | 同 5 次 | 0.40–2.32 毫秒 | 不包含模型视觉编码或推理成本 |
| 进程内 `observeRegion` 总时长 | 另外 3 次 | 4.01–4.43 秒 | 排除 CLI Node 启动 |
| 其中 Windows helper | 同 3 次 | 2.22–2.54 秒，约 55–57% | 包含 PowerShell 启动、Add-Type、捕获、结果序列化，未进一步分项 |
| helper 之外 | 同 3 次 | 1.80–1.89 秒 | 尚未拆分验证、文件系统与发布事务等阶段 |

另做一次实际 codemode 调用，在同一结果中返回 receipt 和 PNG image block；
模型收到的图像是受控窗口的四色图案。此次 `observe` 约 4.34 秒，外层约
9.7 秒包含 fixture 创建/关闭等实验开销，不能当作生产快捷路径耗时。

这些结果证明应先节省模型往返和不必要的重复采集。不能由小图读取时间推出
图像 token 成本，也不能认定 helper 启动是全部瓶颈。尚无端到端任务成功率、
费用或 p95 提速结论。

## 外部资料与可迁移做法

资料均于调研日期获取。项目主分支会变化，以下为当时的公开内容。

| 来源 | 直接看到的机制 | cu 的对应改进 |
| --- | --- | --- |
| [OpenCode Browse 产品页](https://opencode.ai/product/browse) 与 [仓库](https://github.com/anomalyco/browse) | 复用已有登录和标签页，后台工作、持久会话、execute、截图/录像/HAR | 减少重复初始化和状态重建；保持工作区/run 稳定；归档不强制送入上下文 |
| [Browse 官方 skill](https://github.com/anomalyco/browse/blob/main/cli/skills/browse/SKILL.md) | 紧凑 snapshot、find/diff、视觉 labels、screenshotDiff；依赖临时 UI 的动作留在同次 execute；视觉证据需要返回截图 buffer | 把采集与图像交付组合；复用 checkpoint；未来考虑局部/差异视图，但必须保存坐标映射 |
| [Vercel agent-browser](https://github.com/vercel-labs/agent-browser) | 持久浏览器、紧凑 snapshot 与元素 ref；DOM 变化后重新观察 | 若增加 UIA/浏览器语义通道，应绑定快照有效性，不能沿用过期 ref |
| [Microsoft Playwright CLI](https://github.com/microsoft/playwright-cli) | 按需 page data、局部 snapshot、深度限制、find、命令后状态产物 | 以决策需要选择信息范围；大产物存文件，按需读 |
| [Browser Use agent 源码](https://github.com/browser-use/browser-use/blob/main/browser_use/agent/service.py) | `use_vision` 支持 true/false/auto；源码当时仍采集截图用于云端同步，模型视觉输入另行控制；有每步动作数限制 | “采集”和“模型看见”分离；不要把 vision=false 当作未采集，也不要把浏览器的批量动作规则直接移植到 cu |

Browse 的条件等待和多步执行基于浏览器语义与定位器。cu 当前是图像坐标输入，
D2 边界是现有执行合同；本轮只合并工具编排，不放宽第二个坐标动作、chord、
焦点键的 checkpoint，也不自动续跑被截断的动作尾部。

## 流媒体调研的边界

Google 视频检索找到下列候选，但 YouTube 页面触发通知权限提示，ego-browser
把该 TaskSpace 交给用户。没有用户确认前，未继续操作该浏览器，也未读取
视频字幕或完整观看。**本报告不把搜索摘要或视频标题当作已验证结论。**

- [Token-Efficient Browser Automation for AI Agents — Alex Hitt](https://www.youtube.com/watch?v=7pJTsmZqEv0)
- [Browser Use with Managed Deep Agents — LangChain](https://www.youtube.com/watch?v=r1iJzoxFBtg)
- [Browser Agents Don't Need Better Models… — AI Engineer](https://www.youtube.com/watch?v=JnubYCYunk8)

后续需要从视频字幕或实际演示抽取具体机制，再与官方实现核对。视频里的
宣传提速数字不能直接作为 cu 的预期收益。

## 后续优化顺序及验收

1. **先验证 skill 是否改变模型行为。** 用用户自己的真实任务，比对原 skill
   与新 skill：任务成功率、模型决策轮数、重复 capture 次数、实际附图次数、
   总耗时、可获得的模型 usage。不以“工具调用更少”代替任务成功。
2. **给 capture 路径分阶段计时。** 分清 helper 启动/编译、屏幕读取、PNG、
   验证、事务发布的占比，再决定是否引入预编译 helper；不能仅凭整体耗时
   直接改成常驻 daemon，命令级资源生命周期仍需保留或单独决策。
3. **按需视图与等待。** 可以研究较小观察区域、保持比例的预览与变化检测；
   裁剪需显式映射回原 observation。稳定像素不证明页面业务完成，条件等待
   需有超时和任务对应的判定条件。
4. **最后评估语义通道。** 浏览器 DOM 或 Windows UIA 可能省去视觉定位，但
   应作为有单独证据合同的能力；不能将未验证的控件信息假设为现有 cu 功能。

本轮只有 skill、引用与调研文档变更。没有新增 CLI flag，也没有对生产代码
或执行策略作改动。构建及受控 observe/图片交付链路已验证；checkpoint 交付
的字段来自源码核对，本轮没有额外发送真实输入来跑该动作分支。
