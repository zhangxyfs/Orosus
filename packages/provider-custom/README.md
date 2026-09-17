# provider-custom

- **提供**：N 个 `provider:<自定义名>` 槽（区内厂商表声明，`{ stream, defaultModel? }`，D32/D33）
- **消费**：无
- **配置**：`[provider-custom]` 区内 `providers` 子表——每厂商 `type`（anthropic/openai 选协议族）+ `baseUrl`（必填）+ `apiKey`（可选 `$ENV:` 占位）+ `defaultModel`（可选，裸名即用）；目录供给（models.dev）与 `/provider` 菜单见模块文档 §3（D34/D35/D37）
- **uses**：`network`、`secrets`
