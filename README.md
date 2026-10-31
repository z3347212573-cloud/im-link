# 接线台 · IM Link

本机 Agent 的可视化 IM 渠道配置管理器。机器人信息填一次，即可安装对应接入配置、查看绑定关系，并在支持的 Agent 之间更换绑定。

管理工具按需打开；日常收发和独立会话由 Agent 侧组件处理。首版面向 Windows 和 macOS，以飞书私聊、DSH、Claude Code 验证完整流程。

## 当前版本

0.1.0 开发版，2026-10-29。

已实现桌面界面、配置扫描与选择导入、多套设置、加密凭据、绑定和更换、解绑与删除、备份与回滚、Agent 侧会话队列、飞书文字适配、DSH 插件和 Claude 生命周期钩子接入。

Windows 桌面交互、原生 Claude CLI 钩子、真实 SDK 进程与本地模拟模型的会话及交互测试已经通过。真实飞书收发、DSH 插件在用户实际 profile 中运行、IDE／桌面 Agent 入口和 macOS 尚未完成端到端验收。详见 [验证结果](docs/验证结果.md)。

## 直接运行 Windows 开发版

另一台电脑试用时，请先阅读 [跨电脑试用说明](docs/另一台电脑试用.md)。Windows 可以从仓库 Releases 下载完整运行包；macOS 先使用源码，实际兼容性仍需验证。

打开 release/IM-Link-0.1.0-win32-x64/IM Link.exe。

保留整个文件夹，不能只复制 exe。开发版未制作安装程序和代码签名。正常运行不需要先启动本地网页服务，也不需要打开终端运行管理后端。

首次打开会扫描本机配置，只展示发现结果，不会自行接管机器人。选择“查看发现结果 → 导入并接管”，或者“添加渠道”跟随指引填写一个机器人。

导入并接管会备份配置，停用所选的旧接入注册并注册新的 Agent 侧组件。按提示手动重开对应 Agent，再通过飞书私聊验证文字回复。

## 从源码运行

需要 Node.js 22 或更高版本，以及已安装和配置的目标 Agent。

    npm install
    npm start

Windows 上如果企业网络阻止 Electron 的完整文件下载，可以运行附带的分段下载工具。工具使用公开镜像，但必须通过 Electron 包提供的官方 SHA-256 校验后才安装：

    node tools/install-electron-ranged.mjs

验证与打包：

    npm run check
    npm test
    node tools/probe.mjs --hooks
    node tools/run-smoke.mjs
    npm run package

原生钩子探针目前针对 Windows；macOS 应在对应主机验证和打包，不能用 Windows 的运行结果代替。桌面测试使用 .test-data 下的隔离配置，原生会话集成测试使用临时目录和本地模拟模型。

已安装 DSH 时，可额外验证插件在当前 Cordis 中的启动和卸载（不会读取机器人凭据、连接飞书或修改该 profile）：

    IM_LINK_DSH_PROFILE="$HOME/.dsh/profiles/web" node --test tests/dsh-integration.test.mjs

## 日常使用

- 配置完成后，照常打开 Agent。DSH 使用 Cordis 补丁层；Claude Code 使用用户级 SessionStart／SessionEnd 钩子，不要求专用快捷方式或给日常命令加 channels 参数。
- 各原有入口需要分别实测。目前只验证了 Windows 原生 Claude CLI 的钩子；IDE 和桌面入口尚未验证。
- 你在飞书中的每个私聊拥有独立 Agent 会话，正常重开 Agent 后恢复原会话。
- 发送 /new 新建空白会话。当前任务未完成时先等待，完成回复后再新建，并提示“已新建会话”。
- Agent 问题或操作确认会返回原私聊；按提示回答后继续。
- 如果已排队 /new，而旧任务仍等待回答，使用提示中的 /reply 你的答案 完成旧任务。其他普通消息仍留给新会话，避免误当成旧问题的回答。
- 更换 Agent 等待当前任务完成；更换后不携带旧上下文，原 Agent 历史记录保留。
- 解绑保留机器人信息；删除清理本工具的渠道信息和凭据，不删除飞书后台应用。

首版只处理私聊文字，不增加账号白名单或强制配对，不处理群聊、图片和文件。

## 本机数据

默认位于用户目录下的 .im-link：

- state.json：Agent 设置、绑定、最近操作记录。
- credentials.enc.json：AES-256-GCM 加密的渠道接入信息。
- key.dpapi：Windows 当前用户保护的主密钥；macOS 主密钥使用系统钥匙串。
- backups/：受管理配置的备份和恢复清单。
- sessions/：私聊会话映射、待处理消息和投递状态。
- runtime/、hosts/：Agent 侧组件的存活信息和接入所有权。

凭据不写入 Agent 插件注册参数。管理窗口完全退出后，Agent 侧组件通过系统保护的本机密钥读取接入信息。操作记录不保存聊天正文或密钥。

## 代码结构

- src/main.mjs、src/preload.cjs：桌面窗口与受限 IPC。
- src/ui/：本地界面，无在线字体或远程页面依赖。
- src/core/：配置、发现、加密、会话队列、绑定与回滚。
- src/adapters/：飞书、DSH、Claude 会话适配。
- src/runtime/：随 Agent 生命周期运行的组件。
- tests/：核心、并发、回滚、原生 SDK 集成测试。
- tools/：探针、桌面交互测试、运行环境安装与打包。

## 设计文档

- [首版需求说明](docs/首版需求说明.md)
- [技术验证方案](docs/技术验证方案.md)
- [验证结果与未完成项](docs/验证结果.md)
- [界面设计](docs/界面设计.md)
