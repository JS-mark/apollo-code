# 首次运行

在代码仓库中执行 `apollo`。写入任何配置前，引导流程会说明遥测默认仅保存在本地，并展示当前检测到的 Sandbox Tier。

1. 选择 Anthropic 作为 provider。
2. 只在 Apollo 遮罩显示的凭据输入框中输入 API key。不要把密钥粘贴到聊天、Shell 历史、日志、Issue 或 commit 中。
3. Apollo 会先验证凭据，再写入系统钥匙串或加密的降级存储。
4. 仔细检查每一次写文件、执行命令和网络访问请求；不理解的请求应当拒绝。

真实任务前先执行 `apollo doctor --strict`。沙箱降级时命令会以状态码 3 退出。`--dangerously-no-sandbox` 需要显式风险确认，不得用于发布验收。
