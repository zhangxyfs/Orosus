# provider-glm

- **提供**：provider 槽 `provider:glm`（`{ stream, defaultModel: "glm-5.3" }`，裸名 `model = "glm"` 即用）
- **消费**：无
- **配置**：`[provider-glm]` —— `apiKey`（必填，`"$ENV:ZHIPU_API_KEY"` 占位）、`baseUrl`（可选，默认智谱 Anthropic 兼容端点）
- **uses**：`network`、`secrets`
- 注：模型 ID 原样透传，`[1m]` 等方言后缀归智谱文档解释；团队套餐 Key 与个人 Key 不通用（配错由 401 带内暴露）
