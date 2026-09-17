# provider-kimi

- **提供**：provider 槽 `provider:kimi`（`{ stream, defaultModel: "kimi-k3" }`，裸名 `model = "kimi"` 即用）
- **消费**：无
- **配置**：`[provider-kimi]` —— `apiKey`（必填，`"$ENV:MOONSHOT_API_KEY"` 占位）、`baseUrl`（可选，默认官方 Anthropic 兼容端点；`.ai` 域等区域端点经覆写）
- **uses**：`network`、`secrets`
- 注：Kimi 的 OpenAI 协议模型线（kimi-k2.7-code 系）走 provider-openai + baseUrl 覆写，同一把 key 两处可用
