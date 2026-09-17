# provider-openai

- **提供**：provider 槽 `provider:openai`（`StreamFn`，无 defaultModel）
- **消费**：无
- **配置**：`[provider-openai]` —— `apiKey`（可选：本地/内网端点免 key）、`baseUrl`（可选，默认官方端点；覆写即接 DeepSeek/GLM paas/Kimi OpenAI 线/Ollama/vLLM 等兼容端点）
- **uses**：`network`、`secrets`
