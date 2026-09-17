# provider-deepseek

- **提供**：provider 槽 `provider:deepseek`（`{ stream, defaultModel: "deepseek-chat" }`，裸名 `model = "deepseek"` 即用；reasoner 显式 `model = "deepseek/deepseek-reasoner"`）
- **消费**：无
- **配置**：`[provider-deepseek]` —— `apiKey`（必填，`"$ENV:DEEPSEEK_API_KEY"` 占位）、`baseUrl`（可选，默认官方端点）
- **uses**：`network`、`secrets`
