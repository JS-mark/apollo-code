/** 设置页文案（settings.*）：zh 为权威，en 同键。由 SettingsPage.tsx 认领维护。 */

export const settingsZh = {
  // 页面骨架
  'settings.title': '设置',
  'settings.configUnavailable': 'config 端口未装配：配置项只读不可用，仅本地偏好（主题）可改。',
  'settings.configLoadFailed': '配置读取失败：{error}',
  'settings.savedToast': '已保存（下次启动生效；部分键立即生效）',
  'settings.saveFailedToast': '保存失败：{error}',
  'settings.resetToast': '已重置',
  'settings.resetFailedToast': '重置失败：{error}',

  // 导航 / 分节标题
  'settings.sectionConnection': '连接状态',
  'settings.sectionAppearance': '外观',
  'settings.sectionModels': '模型选择',
  'settings.sectionPermission': '权限模式',
  'settings.sectionReasoning': '模型与推理',
  'settings.sectionBehavior': '行为',
  'settings.sectionWebSearch': 'Web 搜索',
  'settings.sectionMemory': '记忆',
  'settings.sectionTasks': '定时任务',
  'settings.sectionLanguage': '语言',
  'settings.sectionAgents': 'Agent 预设',
  'settings.sectionAdvanced': '高级',
  'settings.sectionSandbox': '安全沙箱',
  'settings.sectionSystem': '系统信息',

  // 通用控件
  'settings.reset': '重置',
  'settings.refresh': '刷新',
  'settings.unset': '未设置',
  'settings.unsetDefault': '未设置（默认）',
  'settings.pressEnterToAdd': '回车添加',
  'settings.save': '保存',
  'settings.cancel': '取消',
  'settings.add': '添加',
  'settings.clear': '清除',
  'settings.clearAll': '清空',
  'settings.credentialSet': '已设置（不回显）',
  'settings.replace': '替换',
  'settings.credentialPlaceholder': '粘贴后保存，永不回显',

  // 定时任务调度器状态
  'settings.schedulerStatus': '调度器状态',
  'settings.schedulerStatusHint':
    '触发由 volund daemon 独占；启停在 CLI（volund daemon / launchd·systemd 保活）',
  'settings.schedulerLoading': '读取中',
  'settings.schedulerRunning': 'daemon 运行中（pid {pid}）',
  'settings.schedulerStopped': 'daemon 未运行——任务不会触发',

  // 确认弹窗 / JSON 段
  'settings.clearKeyConfirm': '清除 {key}？',
  'settings.jsonParseError': 'JSON 解析失败，未保存',
  'settings.clearSectionConfirm': '清空 [{section}] 段？',

  // 别名编辑器
  'settings.aliasRequired': '别名、provider、model 均必填',
  'settings.noAliases': '暂无别名',
  'settings.aliasColumn': '别名',
  'settings.deleteAliasConfirm': '删除别名 {alias}？',
  'settings.addAlias': '添加别名',
  'settings.addAliasTitle': '添加模型别名',
  'settings.aliasNamePlaceholder': '别名（如 fast）',
  'settings.providerPlaceholder': 'Provider（如 anthropic）',
  'settings.modelIdPlaceholder': 'Model（如 claude-haiku-4-5-20251001）',

  // 端点编辑器
  'settings.providerNameRequired': 'provider 名称必填',
  'settings.noProviders': '暂无自定义端点',
  'settings.nameColumn': '名称',
  'settings.defaultModelColumn': '默认模型',
  'settings.baseUrlPlaceholder': 'https://…（留空走官方端点）',
  'settings.deleteProviderConfirm': '删除 provider {name}？',
  'settings.addProvider': '添加端点',
  'settings.addProviderTitle': '添加 OpenAI 兼容端点',
  'settings.providerNamePlaceholder': '名称（如 deepseek）',
  'settings.defaultModelOptionalPlaceholder': '默认模型（可选）',
  'settings.baseUrlOptionalPlaceholder': 'Base URL（可选，如 https://api.deepseek.com/v1）',

  // fallback 链编辑器
  'settings.chainNodeRequired': 'provider、model、priority 均必填',
  'settings.noRouterChain': '未配置（type=single 时忽略）',
  'settings.addChainNode': '添加节点',
  'settings.clearChainConfirm': '清空 fallback 链？',
  'settings.addChainNodeTitle': '添加 fallback 节点',
  'settings.priorityPlaceholder': 'priority（高者优先）',

  // 环境变量编辑器
  'settings.envNameRequired': '变量名必填',
  'settings.noEnvVars': '暂无环境变量',
  'settings.valueColumn': '值',
  'settings.deleteKeyConfirm': '删除 {key}？',
  'settings.addEnvVar': '添加变量',
  'settings.addEnvVarTitle': '添加环境变量',
  'settings.envNamePlaceholder': '名称（如 HTTP_PROXY；*_api_key 保存后不回显）',
  'settings.envSecretValuePlaceholder': '值（保存后不回显）',
  'settings.envValuePlaceholder': '值（支持 ~ 与 ${VAR} 前置解析）',

  // 连接状态
  'settings.status': '状态',
  'settings.connected': '已连接',
  'settings.disconnected': '未连接',
  'settings.sessionId': '会话ID',
  'settings.noActiveSession': '（无活动会话）',
  'settings.serverVersion': '服务器版本',
  'settings.workingDir': '工作目录',

  // 外观
  'settings.uiTheme': '界面主题',
  'settings.uiThemeHint': 'Web 控制台主题（浏览器本地保存）',
  'settings.followSystem': '跟随系统',
  'settings.themeLight': '浅色',
  'settings.themeDark': '深色',
  'settings.tuiTheme': 'TUI 主题',
  'settings.tuiThemeHint': '终端 UI 主题名（ui.theme）',
  'settings.tuiColor': 'TUI 彩色输出',
  'settings.tuiColorHint': '终端彩色输出（ui.color，默认开）',

  // 模型选择
  'settings.defaultModel': '默认模型',
  'settings.defaultModelHint': 'preferences.model；会话内仍可用选择器临时切换',
  'settings.defaultProvider': '默认 Provider',
  'settings.defaultProviderHint': 'provider.default（如 anthropic）',
  'settings.customModels': '自定义模型（别名）',
  'settings.customModelsDesc': 'models.aliases：别名 → provider/model，进 /model 选择器',
  'settings.customEndpoints': '自定义端点（OpenAI 兼容）',
  'settings.customEndpointsDesc': 'provider.<name>：默认模型 / Base URL，支持增删改',
  'settings.anthropicKeyHint': 'auth.anthropic_api_key（Layer 4 明文 key；只写不读）',
  'settings.skipAuth': '跳过凭据',
  'settings.skipAuthHint': 'auth.skipAuth：企业网关/本地代理不带凭据头',

  // 权限模式
  'settings.currentMode': '当前会话模式',
  'settings.currentModeHint': '热切当前会话（§4.4 三档）',
  'settings.defaultPermissionMode': '默认权限模式',
  'settings.defaultPermissionModeHint': 'permissions.mode：新会话的默认档（项目级不可覆盖）',

  // 模型与推理
  'settings.reasoningEffort': '推理努力级别',
  'settings.routerType': '路由类型',
  'settings.routerTypeHint': 'router.type（默认 single）',
  'settings.fallbackChain': 'Fallback 链',
  'settings.fallbackChainDesc': 'router.chain：priority 高者优先，失败进入冷却',
  'settings.cooldownSeconds': '失败冷却（秒）',
  'settings.cooldownSecondsHint': 'router.cooldown_seconds（默认 60）',
  'settings.crossProviderTools': '跨 provider 工具调用',
  'settings.crossProviderToolsHint': 'router.allow_cross_provider_tool_use（默认关）',
  'settings.contextPolicy': '上下文策略',
  'settings.contextPolicyHint': 'context.policy（默认 sliding）',
  'settings.contextMaxTokens': '上下文上限（tokens）',
  'settings.contextMaxTokensHint': 'context.max_tokens（默认 180000）',

  // 行为
  'settings.maxToolLoops': '每轮工具循环上限',
  'settings.maxToolLoopsHint': 'runner.maxToolLoopsPerTurn（默认 25）',
  'settings.topLevelBudget': '顶层预算门',
  'settings.topLevelBudgetHint': 'runner.top_level_budget（默认关）',
  'settings.autoCompact': '自动压缩上下文',
  'settings.notifications': '通知',
  'settings.promptSuggestions': '提示建议',
  'settings.tokenCounter': 'Token 计数',
  'settings.terminalProgressBar': '终端进度条',
  'settings.windowsShellHint': 'tools.windows_shell（如 powershell / bash）',
  'settings.passThroughEnv': '沙箱透传环境变量',
  'settings.passThroughEnvHint': 'tools.pass_through_env：env_clear 白名单',
  'settings.ignoreDirs': '忽略目录',
  'settings.ignoreDirsHint': 'tools.ignore_dirs（默认 .git/node_modules/target/dist）',
  'settings.evolutionHint': 'evolution.enabled：应用已有 context tuning（默认关）',

  // Web 搜索
  'settings.searchBackend': '搜索后端',
  'settings.searchBackendHint': 'web_search.backend（未设置时默认 tavily；改后即时生效）',
  'settings.customApiOption': '自定义 API',
  'settings.tavilyKeyHint': 'backend=tavily 时必填（tavily.com 免费申请）',
  'settings.braveKeyHint': 'backend=brave 时必填（brave.com/search/api 免费申请）',
  'settings.customSearchUrl': '自定义搜索 API 端点',
  'settings.customSearchUrlHint':
    'backend=custom 时必填；先 POST {query, max_results}，不行回退 GET ?q=&format=json；返回数组或 {results:[…]}（title/url + snippet|content|description），SearXNG 等直接可接',
  'settings.customApiKey': '自定义 API Key（可选）',
  'settings.customApiKeyHint': 'backend=custom 时有则带 Authorization: Bearer',
  'settings.maxSearchResults': '单次结果数上限',
  'settings.maxSearchResultsHint': 'web_search.max_results（1-10，默认 5）',

  // 记忆
  'settings.memoryEnabled': '启用记忆',
  'settings.autoMemory': '自动记忆',
  'settings.typedMemory': '类型化记忆',
  'settings.memoryBodyLines': '单条正文行数上限',
  'settings.memoryBodyLinesHint': 'memory.max_body_lines（默认 200）',
  'settings.memoryGlobalPath': '全局记忆路径',
  'settings.memoryGlobalPathHint': 'memory.paths.global（缺省内置布局）',
  'settings.memoryProjectPath': '项目记忆路径',
  'settings.memoryProjectPathHint': 'memory.paths.project（缺省内置布局）',

  // 定时任务
  'settings.tasksEnabled': '启用定时任务调度',
  'settings.tasksEnabledHint': 'tasks.enabled（默认 false；开启后还需 volund daemon 在场才会触发）',
  'settings.tasksMaxConcurrent': '同时在途运行上限',
  'settings.tasksMaxConcurrentHint': 'tasks.max_concurrent（1–8，默认 1）',
  'settings.journalRetention': '运行记录保留条数',
  'settings.journalRetentionHint': 'tasks.journal_retention（10–10000，默认 200）',

  // 语言
  'settings.replyLanguage': '回复语言',
  'settings.replyLanguageHint': 'preferences.language，写入用户级 config.toml',
  'settings.outputStyle': '输出风格',

  // Agent 预设
  'settings.subagentMaxDepth': '子代理最大深度',
  'settings.subagentMaxDepthHint': 'subagent.max_depth（默认 3）',
  'settings.subagentMaxConcurrent': '子代理并发上限',
  'settings.subagentMaxConcurrentHint': 'subagent.max_concurrent（默认 4）',
  'settings.subagentBudgetCost': '子代理预算：费用（USD）',
  'settings.subagentBudgetCostHint': 'subagent.default_budget.costUSDMax（默认 1）',
  'settings.subagentBudgetTokens': '子代理预算：tokens',
  'settings.subagentBudgetTokensHint': 'subagent.default_budget.tokenMax（默认 200000）',
  'settings.subagentBudgetTime': '子代理预算：时长（ms）',
  'settings.subagentBudgetTimeHint': 'subagent.default_budget.timeMsMax（默认 600000）',
  'settings.skillsIndexBudget': 'Skills 索引预算（字符）',
  'settings.skillsIndexBudgetHint': 'skills.index_budget（默认 4096）',
  'settings.reflectionCard': '动态反思（§21）',
  'settings.reflectionEnabled': '启用反思',
  'settings.reflectionEnabledHint': 'reflection.enabled（默认开）',
  'settings.reflectionOnError': '出错时触发',
  'settings.reflectionOnErrorHint': 'reflection.triggers.on_error（默认开）',
  'settings.reflectionOnCompact': '压缩时触发',
  'settings.reflectionOnCompactHint': 'reflection.triggers.on_compact（默认关）',
  'settings.reflectionEveryNTurns': '定期触发（每 N 轮）',
  'settings.reflectionEveryNTurnsHint': 'reflection.triggers.every_n_turns（0 = 关）',
  'settings.reflectionCooldown': '反思冷却（秒）',
  'settings.reflectionCooldownHint': 'reflection.cooldown_seconds（默认 60）',
  'settings.reflectionModelRole': '反思模型角色',
  'settings.reflectionModelRoleHint':
    'reflection.model_role（默认 reflection，未配置回落会话模型）',
  'settings.runBudgetCost': '单次预算：费用（USD）',
  'settings.runBudgetCostHint': 'reflection.run_budget.costUSDMax（默认 0.05）',
  'settings.runBudgetTokens': '单次预算：tokens',
  'settings.runBudgetTokensHint': 'reflection.run_budget.tokenMax（默认 16000）',
  'settings.runBudgetTime': '单次预算：时长（ms）',
  'settings.runBudgetTimeHint': 'reflection.run_budget.timeMsMax（默认 60000）',
  'settings.sessionTokenBudget': '会话 token 硬顶',
  'settings.sessionTokenBudgetHint': 'reflection.session_token_budget（默认 50000）',
  'settings.persist': '持久化',
  'settings.persistHint': 'reflection.persist（默认 manual）',
  'settings.injectMaxLessons': '注入条数上限',
  'settings.injectMaxLessonsHint': 'reflection.inject_max_lessons（默认 3）',
  'settings.injectMaxBytes': '注入字节上限',
  'settings.injectMaxBytesHint': 'reflection.inject_max_bytes（默认 2048）',

  // 高级
  'settings.envSection': '环境变量（[env]）',
  'settings.envSectionDesc':
    '启动时写入 process.env；子进程（MCP / 插件宿主）继承；进沙箱需配合 tools.pass_through_env',
  'settings.ipcMaxLineBytes': 'Native IPC 行字节上限',
  'settings.ipcMaxLineBytesHint': 'native.ipc_max_line_bytes（默认 4194304）',
  'settings.telemetrySink': '遥测输出',
  'settings.telemetrySinkHint': 'telemetry.sink（默认 local）',
  'settings.pluginsMarket': '插件市场源',
  'settings.pluginsMarketHint': 'plugins.market：HTTPS 索引 URL（信任配置）',
  'settings.builtinDisabled': '禁用的内置工具域',
  'settings.builtinDisabledHint': 'plugins.builtin_disabled（如 volund.exec）',
  'settings.cleanupPeriod': '会话清理周期（天）',
  'settings.cleanupPeriodHint': 'preferences.cleanupPeriod（默认 30）',
  'settings.promptSection': '[prompt] @include 参数',
  'settings.promptSectionHint': '开放段（§6.5.6）：如 max_depth / max_expansions；JSON 整体读写',
  'settings.webConsole': 'Web 控制台',
  'settings.webAutoStart': '随 TUI 静默自启',
  'settings.webAutoStartHint':
    'web.enabled：Web 侧不可调整（控制台不能关掉自己）；需经 CLI `volund config set web.enabled false`（下次启动生效）',
  'settings.webPort': '固定端口',
  'settings.webPortHint': 'web.port：0 = 随机空闲（记住上次优先复用）',
  'settings.terminalShell': '终端 shell',
  'settings.terminalShellHint':
    'web.terminal.shell：工作台终端的 shell（默认 $SHELL → /bin/sh）；下次开终端生效',
  'settings.terminalFontSize': '终端字号',
  'settings.terminalFontSizeHint':
    'web.terminal.font_size（9–32，默认 12）；已打开的终端下次重开生效',
  'settings.terminalScrollback': '终端滚动缓冲',
  'settings.terminalScrollbackHint':
    'web.terminal.scrollback（100–100000 行，默认 2000）；已打开的终端下次重开生效',

  // 安全沙箱
  'settings.sandboxSection': '[sandbox] 降级策略 / tier',
  'settings.sandboxSectionHint':
    '开放段（§5.5）：JSON 整体读写；沙箱内 Bash 走 env_clear 白名单模型，透传名单见 行为 → 沙箱透传环境变量',

  // 系统信息
  'settings.serverId': '服务器 ID',
  'settings.startedAt': '启动时间',
  'settings.nativeModules': 'Native 模块',
  'settings.userConfigFile': '用户级配置',
  'settings.projectConfigFile': '项目级配置',
  'settings.configWarnings': '配置警告',
} as const

export type SettingsKeys = keyof typeof settingsZh

export const settingsEn: Record<SettingsKeys, string> = {
  // Page chrome
  'settings.title': 'Settings',
  'settings.configUnavailable':
    'Config port not wired: settings are read-only and unavailable; only local preferences (theme) can be changed.',
  'settings.configLoadFailed': 'Failed to load config: {error}',
  'settings.savedToast': 'Saved (takes effect on next start; some keys apply immediately)',
  'settings.saveFailedToast': 'Save failed: {error}',
  'settings.resetToast': 'Reset',
  'settings.resetFailedToast': 'Reset failed: {error}',

  // Navigation / section headings
  'settings.sectionConnection': 'Connection',
  'settings.sectionAppearance': 'Appearance',
  'settings.sectionModels': 'Models',
  'settings.sectionPermission': 'Permission Mode',
  'settings.sectionReasoning': 'Model & Reasoning',
  'settings.sectionBehavior': 'Behavior',
  'settings.sectionWebSearch': 'Web Search',
  'settings.sectionMemory': 'Memory',
  'settings.sectionTasks': 'Scheduled Tasks',
  'settings.sectionLanguage': 'Language',
  'settings.sectionAgents': 'Agent Presets',
  'settings.sectionAdvanced': 'Advanced',
  'settings.sectionSandbox': 'Sandbox',
  'settings.sectionSystem': 'System Info',

  // Shared controls
  'settings.reset': 'Reset',
  'settings.refresh': 'Refresh',
  'settings.unset': 'Not set',
  'settings.unsetDefault': 'Not set (default)',
  'settings.pressEnterToAdd': 'Press Enter to add',
  'settings.save': 'Save',
  'settings.cancel': 'Cancel',
  'settings.add': 'Add',
  'settings.clear': 'Clear',
  'settings.clearAll': 'Clear',
  'settings.credentialSet': 'Set (never shown)',
  'settings.replace': 'Replace',
  'settings.credentialPlaceholder': 'Paste then save; never shown again',

  // Task scheduler status
  'settings.schedulerStatus': 'Scheduler status',
  'settings.schedulerStatusHint':
    'Triggers are owned exclusively by the volund daemon; start/stop via CLI (volund daemon / launchd·systemd keepalive)',
  'settings.schedulerLoading': 'Loading',
  'settings.schedulerRunning': 'daemon running (pid {pid})',
  'settings.schedulerStopped': 'daemon not running — tasks will not trigger',

  // Confirmations / JSON sections
  'settings.clearKeyConfirm': 'Clear {key}?',
  'settings.jsonParseError': 'JSON parse failed; nothing was saved',
  'settings.clearSectionConfirm': 'Clear the [{section}] section?',

  // Aliases editor
  'settings.aliasRequired': 'Alias, provider and model are all required',
  'settings.noAliases': 'No aliases yet',
  'settings.aliasColumn': 'Alias',
  'settings.deleteAliasConfirm': 'Delete alias {alias}?',
  'settings.addAlias': 'Add alias',
  'settings.addAliasTitle': 'Add model alias',
  'settings.aliasNamePlaceholder': 'Alias (e.g. fast)',
  'settings.providerPlaceholder': 'Provider (e.g. anthropic)',
  'settings.modelIdPlaceholder': 'Model (e.g. claude-haiku-4-5-20251001)',

  // Providers editor
  'settings.providerNameRequired': 'Provider name is required',
  'settings.noProviders': 'No custom endpoints yet',
  'settings.nameColumn': 'Name',
  'settings.defaultModelColumn': 'Default model',
  'settings.baseUrlPlaceholder': 'https://… (leave empty to use the official endpoint)',
  'settings.deleteProviderConfirm': 'Delete provider {name}?',
  'settings.addProvider': 'Add endpoint',
  'settings.addProviderTitle': 'Add OpenAI-compatible endpoint',
  'settings.providerNamePlaceholder': 'Name (e.g. deepseek)',
  'settings.defaultModelOptionalPlaceholder': 'Default model (optional)',
  'settings.baseUrlOptionalPlaceholder': 'Base URL (optional, e.g. https://api.deepseek.com/v1)',

  // Fallback chain editor
  'settings.chainNodeRequired': 'Provider, model and priority are all required',
  'settings.noRouterChain': 'Not configured (ignored when type=single)',
  'settings.addChainNode': 'Add node',
  'settings.clearChainConfirm': 'Clear the fallback chain?',
  'settings.addChainNodeTitle': 'Add fallback node',
  'settings.priorityPlaceholder': 'priority (higher first)',

  // Env editor
  'settings.envNameRequired': 'Variable name is required',
  'settings.noEnvVars': 'No environment variables yet',
  'settings.valueColumn': 'Value',
  'settings.deleteKeyConfirm': 'Delete {key}?',
  'settings.addEnvVar': 'Add variable',
  'settings.addEnvVarTitle': 'Add environment variable',
  'settings.envNamePlaceholder': 'Name (e.g. HTTP_PROXY; *_api_key is never shown after save)',
  'settings.envSecretValuePlaceholder': 'Value (never shown after save)',
  'settings.envValuePlaceholder': 'Value (supports ~ and ${VAR} prefix expansion)',

  // Connection
  'settings.status': 'Status',
  'settings.connected': 'Connected',
  'settings.disconnected': 'Disconnected',
  'settings.sessionId': 'Session ID',
  'settings.noActiveSession': '(no active session)',
  'settings.serverVersion': 'Server version',
  'settings.workingDir': 'Working directory',

  // Appearance
  'settings.uiTheme': 'UI theme',
  'settings.uiThemeHint': 'Web console theme (saved in this browser)',
  'settings.followSystem': 'Follow system',
  'settings.themeLight': 'Light',
  'settings.themeDark': 'Dark',
  'settings.tuiTheme': 'TUI theme',
  'settings.tuiThemeHint': 'Terminal UI theme name (ui.theme)',
  'settings.tuiColor': 'TUI color output',
  'settings.tuiColorHint': 'Terminal color output (ui.color, on by default)',

  // Models
  'settings.defaultModel': 'Default model',
  'settings.defaultModelHint':
    'preferences.model; can still be switched temporarily via the in-session picker',
  'settings.defaultProvider': 'Default provider',
  'settings.defaultProviderHint': 'provider.default (e.g. anthropic)',
  'settings.customModels': 'Custom models (aliases)',
  'settings.customModelsDesc':
    'models.aliases: alias → provider/model, shows up in the /model picker',
  'settings.customEndpoints': 'Custom endpoints (OpenAI-compatible)',
  'settings.customEndpointsDesc':
    'provider.<name>: default model / Base URL, with full add/edit/remove support',
  'settings.anthropicKeyHint': 'auth.anthropic_api_key (Layer 4 plaintext key; write-only)',
  'settings.skipAuth': 'Skip credentials',
  'settings.skipAuthHint':
    'auth.skipAuth: send no credential headers behind enterprise gateways / local proxies',

  // Permission mode
  'settings.currentMode': 'Current session mode',
  'settings.currentModeHint': 'Hot-switches the current session (§4.4 three tiers)',
  'settings.defaultPermissionMode': 'Default permission mode',
  'settings.defaultPermissionModeHint':
    'permissions.mode: default tier for new sessions (project level cannot override)',

  // Model & reasoning
  'settings.reasoningEffort': 'Reasoning effort',
  'settings.routerType': 'Router type',
  'settings.routerTypeHint': 'router.type (single by default)',
  'settings.fallbackChain': 'Fallback chain',
  'settings.fallbackChainDesc': 'router.chain: higher priority first; failures enter cooldown',
  'settings.cooldownSeconds': 'Failure cooldown (s)',
  'settings.cooldownSecondsHint': 'router.cooldown_seconds (60 by default)',
  'settings.crossProviderTools': 'Cross-provider tool calls',
  'settings.crossProviderToolsHint': 'router.allow_cross_provider_tool_use (off by default)',
  'settings.contextPolicy': 'Context policy',
  'settings.contextPolicyHint': 'context.policy (sliding by default)',
  'settings.contextMaxTokens': 'Context limit (tokens)',
  'settings.contextMaxTokensHint': 'context.max_tokens (180000 by default)',

  // Behavior
  'settings.maxToolLoops': 'Tool loop limit per turn',
  'settings.maxToolLoopsHint': 'runner.maxToolLoopsPerTurn (25 by default)',
  'settings.topLevelBudget': 'Top-level budget gate',
  'settings.topLevelBudgetHint': 'runner.top_level_budget (off by default)',
  'settings.autoCompact': 'Auto-compact context',
  'settings.notifications': 'Notifications',
  'settings.promptSuggestions': 'Prompt suggestions',
  'settings.tokenCounter': 'Token counter',
  'settings.terminalProgressBar': 'Terminal progress bar',
  'settings.windowsShellHint': 'tools.windows_shell (e.g. powershell / bash)',
  'settings.passThroughEnv': 'Sandbox passthrough env vars',
  'settings.passThroughEnvHint': 'tools.pass_through_env: env_clear allowlist',
  'settings.ignoreDirs': 'Ignored directories',
  'settings.ignoreDirsHint': 'tools.ignore_dirs (.git/node_modules/target/dist by default)',
  'settings.evolutionHint': 'evolution.enabled: apply existing context tuning (off by default)',

  // Web search
  'settings.searchBackend': 'Search backend',
  'settings.searchBackendHint':
    'web_search.backend (tavily by default when unset; changes apply immediately)',
  'settings.customApiOption': 'Custom API',
  'settings.tavilyKeyHint': 'Required when backend=tavily (apply for free at tavily.com)',
  'settings.braveKeyHint': 'Required when backend=brave (apply for free at brave.com/search/api)',
  'settings.customSearchUrl': 'Custom search API endpoint',
  'settings.customSearchUrlHint':
    'Required when backend=custom; POST {query, max_results} first, falls back to GET ?q=&format=json; accepts an array or {results:[…]} (title/url + snippet|content|description); works with SearXNG out of the box',
  'settings.customApiKey': 'Custom API key (optional)',
  'settings.customApiKeyHint': 'Sent as Authorization: Bearer when backend=custom and set',
  'settings.maxSearchResults': 'Max results per query',
  'settings.maxSearchResultsHint': 'web_search.max_results (1-10, 5 by default)',

  // Memory
  'settings.memoryEnabled': 'Enable memory',
  'settings.autoMemory': 'Auto memory',
  'settings.typedMemory': 'Typed memory',
  'settings.memoryBodyLines': 'Max body lines per entry',
  'settings.memoryBodyLinesHint': 'memory.max_body_lines (200 by default)',
  'settings.memoryGlobalPath': 'Global memory path',
  'settings.memoryGlobalPathHint': 'memory.paths.global (built-in layout by default)',
  'settings.memoryProjectPath': 'Project memory path',
  'settings.memoryProjectPathHint': 'memory.paths.project (built-in layout by default)',

  // Scheduled tasks
  'settings.tasksEnabled': 'Enable task scheduler',
  'settings.tasksEnabledHint':
    'tasks.enabled (false by default; the volund daemon must also be present for triggers to fire)',
  'settings.tasksMaxConcurrent': 'Max concurrent runs',
  'settings.tasksMaxConcurrentHint': 'tasks.max_concurrent (1–8, 1 by default)',
  'settings.journalRetention': 'Journal retention (entries)',
  'settings.journalRetentionHint': 'tasks.journal_retention (10–10000, 200 by default)',

  // Language
  'settings.replyLanguage': 'Reply language',
  'settings.replyLanguageHint': 'preferences.language, written to the user-level config.toml',
  'settings.outputStyle': 'Output style',

  // Agent presets
  'settings.subagentMaxDepth': 'Subagent max depth',
  'settings.subagentMaxDepthHint': 'subagent.max_depth (3 by default)',
  'settings.subagentMaxConcurrent': 'Subagent concurrency limit',
  'settings.subagentMaxConcurrentHint': 'subagent.max_concurrent (4 by default)',
  'settings.subagentBudgetCost': 'Subagent budget: cost (USD)',
  'settings.subagentBudgetCostHint': 'subagent.default_budget.costUSDMax (1 by default)',
  'settings.subagentBudgetTokens': 'Subagent budget: tokens',
  'settings.subagentBudgetTokensHint': 'subagent.default_budget.tokenMax (200000 by default)',
  'settings.subagentBudgetTime': 'Subagent budget: duration (ms)',
  'settings.subagentBudgetTimeHint': 'subagent.default_budget.timeMsMax (600000 by default)',
  'settings.skillsIndexBudget': 'Skills index budget (chars)',
  'settings.skillsIndexBudgetHint': 'skills.index_budget (4096 by default)',
  'settings.reflectionCard': 'Dynamic reflection (§21)',
  'settings.reflectionEnabled': 'Enable reflection',
  'settings.reflectionEnabledHint': 'reflection.enabled (on by default)',
  'settings.reflectionOnError': 'Trigger on error',
  'settings.reflectionOnErrorHint': 'reflection.triggers.on_error (on by default)',
  'settings.reflectionOnCompact': 'Trigger on compact',
  'settings.reflectionOnCompactHint': 'reflection.triggers.on_compact (off by default)',
  'settings.reflectionEveryNTurns': 'Periodic trigger (every N turns)',
  'settings.reflectionEveryNTurnsHint': 'reflection.triggers.every_n_turns (0 = off)',
  'settings.reflectionCooldown': 'Reflection cooldown (s)',
  'settings.reflectionCooldownHint': 'reflection.cooldown_seconds (60 by default)',
  'settings.reflectionModelRole': 'Reflection model role',
  'settings.reflectionModelRoleHint':
    'reflection.model_role (reflection by default; falls back to the session model when unset)',
  'settings.runBudgetCost': 'Per-run budget: cost (USD)',
  'settings.runBudgetCostHint': 'reflection.run_budget.costUSDMax (0.05 by default)',
  'settings.runBudgetTokens': 'Per-run budget: tokens',
  'settings.runBudgetTokensHint': 'reflection.run_budget.tokenMax (16000 by default)',
  'settings.runBudgetTime': 'Per-run budget: duration (ms)',
  'settings.runBudgetTimeHint': 'reflection.run_budget.timeMsMax (60000 by default)',
  'settings.sessionTokenBudget': 'Session token hard cap',
  'settings.sessionTokenBudgetHint': 'reflection.session_token_budget (50000 by default)',
  'settings.persist': 'Persistence',
  'settings.persistHint': 'reflection.persist (manual by default)',
  'settings.injectMaxLessons': 'Max injected lessons',
  'settings.injectMaxLessonsHint': 'reflection.inject_max_lessons (3 by default)',
  'settings.injectMaxBytes': 'Max injected bytes',
  'settings.injectMaxBytesHint': 'reflection.inject_max_bytes (2048 by default)',

  // Advanced
  'settings.envSection': 'Environment variables ([env])',
  'settings.envSectionDesc':
    'Written into process.env at startup; inherited by child processes (MCP / plugin hosts); pair with tools.pass_through_env to enter the sandbox',
  'settings.ipcMaxLineBytes': 'Native IPC max line bytes',
  'settings.ipcMaxLineBytesHint': 'native.ipc_max_line_bytes (4194304 by default)',
  'settings.telemetrySink': 'Telemetry sink',
  'settings.telemetrySinkHint': 'telemetry.sink (local by default)',
  'settings.pluginsMarket': 'Plugin marketplace source',
  'settings.pluginsMarketHint': 'plugins.market: HTTPS index URL (trusted configuration)',
  'settings.builtinDisabled': 'Disabled built-in tool domains',
  'settings.builtinDisabledHint': 'plugins.builtin_disabled (e.g. volund.exec)',
  'settings.cleanupPeriod': 'Session cleanup period (days)',
  'settings.cleanupPeriodHint': 'preferences.cleanupPeriod (30 by default)',
  'settings.promptSection': '[prompt] @include params',
  'settings.promptSectionHint':
    'Open section (§6.5.6): e.g. max_depth / max_expansions; JSON read/written as a whole',
  'settings.webConsole': 'Web console',
  'settings.webAutoStart': 'Silent autostart with the TUI',
  'settings.webAutoStartHint':
    'web.enabled: not adjustable from the Web side (the console cannot turn itself off); use the CLI `volund config set web.enabled false` (takes effect on next start)',
  'settings.webPort': 'Fixed port',
  'settings.webPortHint':
    'web.port: 0 = random free port (the last one is remembered and reused first)',
  'settings.terminalShell': 'Terminal shell',
  'settings.terminalShellHint':
    'web.terminal.shell: shell for workbench terminals ($SHELL → /bin/sh by default); applies to terminals opened afterwards',
  'settings.terminalFontSize': 'Terminal font size',
  'settings.terminalFontSizeHint':
    'web.terminal.font_size (9–32, 12 by default); already-open terminals pick it up when reopened',
  'settings.terminalScrollback': 'Terminal scrollback',
  'settings.terminalScrollbackHint':
    'web.terminal.scrollback (100–100000 lines, 2000 by default); already-open terminals pick it up when reopened',

  // Sandbox
  'settings.sandboxSection': '[sandbox] fallback policy / tier',
  'settings.sandboxSectionHint':
    'Open section (§5.5): JSON read/written as a whole; Bash inside the sandbox follows the env_clear allowlist model — see Behavior → Sandbox passthrough env vars for the passthrough list',

  // System info
  'settings.serverId': 'Server ID',
  'settings.startedAt': 'Started at',
  'settings.nativeModules': 'Native modules',
  'settings.userConfigFile': 'User-level config',
  'settings.projectConfigFile': 'Project-level config',
  'settings.configWarnings': 'Config warnings',
}
