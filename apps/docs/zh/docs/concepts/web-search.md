# WebSearch 安全契约

`WebSearch` 工具本体在 packages/tools，无 provider 时 fail-closed（报 "no provider
configured"）。真实搜索能力以内置插件 `volund-plugin-web-search` 提供：插件经
`webSearch.provide` 贡献搜索后端（tavily / brave），宿主适配成 provider 热接进共享
工具实例；权限门、结果限长与 `<untrusted>` 包裹仍归工具本体，插件只是数据源。
仓库中的 `MockWebSearchProvider` 仅用于离线契约测试，不访问网络、不需要 API key。

## 配置

配置在用户级 `~/.volund/config.toml` 的 `[web_search]` 段（api key 项目级禁止覆盖），
插件每次搜索重读该段，改配置即时生效：

```toml
[web_search]
backend = "tavily"        # "tavily" | "brave" | "custom"
max_results = 5           # 1-10，默认 5
tavily_api_key = "tvly-…" # backend=tavily 时必填
# brave_api_key = "…"     # backend=brave 时必填
# custom_url = "https://search.internal.example/query"  # backend=custom 时必填
# custom_api_key = "…"    # 可选；以 Authorization: Bearer 发送
```

**custom 后端契约**（`backend = "custom"`）：插件先向 `custom_url` POST JSON
`{query, max_results}`（配置了 `custom_api_key` 则附 `Authorization: Bearer`），
非 2xx 或非 JSON 时自动回退一发 GET 别名参数。契约取智能体搜索 API 已收敛的形状
（`results` 数组），并宽容解析 SearXNG、Brave、SerpAPI、Bing v7、Google CSE 的
原生形状——完整请求/响应规范、包装形状表与服务端示例见
[Web 搜索自定义后端参考](/zh/docs/reference/web-search-custom-backend)。该端点主机经插件网络出口**动态放行**
——写进用户级 config 即视为授权（项目级覆盖禁止，与 `provider.*.baseUrl` 同一
数据流向门）。

编辑面：TUI `/web-search` 面板（presence 视图 + `volund config set` 命令行）、
web 控制台设置页「Web 搜索」段（key 只写不读）、`volund config set/unset`。
未配置 backend 时每次搜索报配置指引错误，而不是静默失败。

插件联网走宿主受控出口（`http.fetch` 桥方法）：仅 HTTPS + manifest
`permissions.net` allowlist 内的主机（api.tavily.com / api.search.brave.com，外加配置的
`custom_url` 主机），
响应 900KB / 9 秒封顶，代理栈与 WebFetch 同源（HTTPS_PROXY）。沙箱插件自身无网络。

## 权限与日志

每次查询都必须先通过 permission gate。权限请求只包含 provider 标识与脱敏后的
query；执行日志仅记录 query 的短哈希、provider 和结果数量，不记录原始 query、
结果正文或凭据。api key 只随单次搜索调用注入插件，不落插件存储、不进日志。

结果保持 provider 返回顺序，不引入隐藏的跨 provider 排名。数量、单条摘要和总
字符数都有上限，并以带来源的 `<untrusted>` 包裹返回；结果中的标签字符会编码，
不能提前闭合包裹。此标记用于提示模型把搜索结果当数据而非指令，不能替代
permission、WebFetch 的域名许可或 SSRF 防护。

未来 provider 若抓取结果页面（而非调用结构化搜索 API），必须复用 WebFetch 的
canonical domain permission、逐跳 DNS 重解析、私网/metadata 地址拒绝、redirect
policy 和响应限制，不能直接绕过这些原语。
