/** 协议推断（D34）：照 kimi-code 实证映射收敛到两族——type 已知直用；未知显式拒绝；缺省关键词推断；兜底猜 openai 标 guessed。 */
export type WireResolution =
  | { kind: "ok"; wire: "anthropic" | "openai"; guessed: boolean }
  | { kind: "invalid"; reason: string };

const KNOWN = new Set(["anthropic", "openai"]);

export function resolveWire(entry: { type?: unknown; npm?: unknown; id?: unknown }): WireResolution {
  const t = entry.type;
  if (typeof t === "string" && KNOWN.has(t)) return { kind: "ok", wire: t as "anthropic" | "openai", guessed: false };
  if (typeof t === "string" && t !== "") {
    return { kind: "invalid", reason: `未知显式协议类型 "${t}"（专有 SDK 或两族外协议，拒绝导入——D34）` };
  }
  const npm = String(entry.npm ?? "").toLowerCase();
  const id = String(entry.id ?? "").toLowerCase();
  if (npm.includes("anthropic") || id.includes("anthropic") || id.includes("claude")) return { kind: "ok", wire: "anthropic", guessed: true };
  if (npm.includes("openai") || id.includes("openai")) return { kind: "ok", wire: "openai", guessed: true };
  if (npm.includes("amazon-bedrock") || npm.includes("cohere")) return { kind: "invalid", reason: "专有 SDK（bedrock/cohere），拒绝导入" };
  return { kind: "ok", wire: "openai", guessed: true }; // 无线索兜底（标 guessed）
}

/** baseUrl 适配：anthropic 族 glue 自拼 /v1/messages，目录 api 字段常带 /v1 尾巴——剥掉。 */
export function adaptBaseUrl(baseUrl: string, wire: "anthropic" | "openai"): string {
  return wire === "anthropic" ? baseUrl.replace(/\/v1\/?$/, "") : baseUrl;
}
