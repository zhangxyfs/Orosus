# provider-custom

- **提供**：N 个 `provider:<自定义名>` 槽（区内厂商表声明，`{ stream, listModels, listThinking, defaultModel? }`，D32/D33）——listModels 目录优选（策展清单覆盖 live `/models` 兜底）、listThinking 供 `/effort` 思考声明解析（目录三级匹配）；defaultModel 有值则裸名即用
- **消费**：双边服务 `tool-web.search-faces`（搜索改道端点知识，2026-09-24 服务倒挂拍板：openai 档槽 webSearch 请求命中已知可搜端点即改发 `{anthropicRoot}/v1/messages` 同 key 双头；服务缺席 = chat 面原行为）
- **配置**：`[provider-custom]` 区内 `providers` 子表——每厂商 `type`（anthropic/openai 选协议族）+ `baseUrl`（必填）+ `apiKey`（可选 `$ENV:` 占位）+ `defaultModel`（可选，裸名即用）；目录供给（models.dev）与 `/provider` 菜单见模块文档 §3（D34/D35/D37）
- **uses**：`network`、`secrets`
