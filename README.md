# 好人天团 · AI 生图 / 改图

> 基于 [Z1rconium/gpt-image-panel](https://github.com/Z1rconium/gpt-image-panel) 的交互与 API 兼容设计制作的精简版本。
> 为满足**服务端不持久化聊天/图片**的要求，本项目采用独立的轻量 Node HTTP + 内存队列实现，
> **不直接复用原版 SQLite 队列和画廊服务**。原版完整源码保存在本地 \`upstream-original/\` 文件夹供查阅。
> 原项目许可证 CC BY-NC 4.0，原作者著作权归其所有。请勿将其标注为原作者维护的官方版本。

## 功能

- 文字生图 + 上传参考图片改图，支持将上次生成图片直接作为改图参考
- 手绘涂鸦风格响应式聊天页面
- **无需登录、无验证码**
- 后端临时内存队列：最多 3 个同时运行、30 个等待，每个匿名浏览器只执行一个未结束任务
- 上游同步/异步图像请求兼容；异步任务提交和状态轮询
- 任务进度/取消/上游错误提示
- **浏览器 IndexedDB** 保存会话与图片，可下载或手动删除
- 无数据库、无磁盘图片文件、无后台持久化日志（平台基础设施日志不在应用控制范围内）
- 结果在进程 RAM 中暂存最多 15 分钟，任务运行时引用数据暂留内存；进程重启任务无法恢复

## Render 部署

1. 将**项目根目录中的** Dockerfile、server.mjs、package.json、public/、render.yaml、.dockerignore 推送至你的 GitHub 仓库根目录。不要把原始 ZIP、\`upstream-original/\` 上传到仓库（其源码用于本地参考，不是服务运行依赖）。
2. 在 Render 新建 **Blueprint** 并选择该 GitHub 仓库，或新建 **Web Service → Docker**。推荐先选 Free 测试，Render 免费实例休眠时可能首次打开慢；持续响应需要付费实例。
3. 在创建服务时填写 \`IMAGE_API_KEY\` **作为 Secret**，不要把真 Key 写在代码、Render Blueprint 或聊天消息里。
4. 服务创建后访问 \`https://你的服务名.onrender.com/api/health\`（状态码 200），打开首页。
5. 文生图先使用默认 \`gpt-image-2.5-sunburst\`、1 张、自动画质。图片编辑可选择上一张结果。

## 配置

| 环境变量 | 默认 | 用途 |
|---|---|---|
| \`PORT\` | 9090（Render 注入 10000） | 监听端口 |
| \`API_BASE_URL\` | https://image.mlgb7.com/v1 | 中转站 OpenAI 兼容 API |
| \`IMAGE_API_KEY\` | 必填 | 服务器统一使用的上游 Key |
| \`IMAGE_MODELS\` | gpt-image-2.5-sunburst,gpt-image-2.5-flare,gpt-image-2.5 | 前端可选模型 |
| \`IMAGE_ASYNC\` | true | 是否给上游 images/* 接口添加 \`?async=true\` |
| \`IMAGE_ALLOWED_HOSTS\` | 空 | 如果上游图片 URL 使用独立 CDN 域名，在此添加允许的域名列表 |
| \`MAX_CONCURRENT\` | 3 | 同时进行的上游任务数 |
| \`MAX_QUEUED\` | 30 | 全站内存等待任务数量 |
| UPSTREAM_SUBMIT_TIMEOUT_SECONDS | 240 | 上游提交等待上限：兼容忽略异步参数、生成完成才返回的接口 |
| \`MAX_UPSTREAM_WAIT_SECONDS\` | 540 | 异步轮询最长等待 |
  
**异步 API 注意：** 若中转站支持异步任务编号，就通过 GET /api/image-tasks?ids=... 查询；如果中转站忽略 async=true 并且直接返回图片，本站将最多等待 240 秒（可配置）。如果上游返回 HTTP 524，本站延长等待也不能消除上游代理超时。

**隐私限制：** 用户图片可能发送给你选择的第三方 API 供应商，供应商的数据保存政策不由本站控制；Render 网络层日志和平台日志同样不属于应用级图片/聊天持久化存储。网站后端自身不写图片和聊天历史到磁盘。

## 本地启动

Windows PowerShell：

\`\`\`powershell
$env:IMAGE_API_KEY="你自己的Key"
node server.mjs
\`\`\`

打开 \`http://localhost:9090/\`。运行 \`npm.cmd test\` 可执行内存任务与接口测试。

## 来源

- 基础需求和 API 兼容行为参考：Z1rconium/gpt-image-panel（CC BY-NC 4.0）
- 这是独立精简实现，前端和任务状态管理为重新实现，未声称与原项目具有相同的可靠性或持久化恢复能力。
