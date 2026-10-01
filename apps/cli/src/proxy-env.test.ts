import { describe, it, expect } from "vitest";
import { maybeEnableEnvProxy } from "./proxy-env.ts";

describe("批 D：maybeEnableEnvProxy（2026-10-01 拍板 A+B——宿主自动接线）", () => {
  it("① 代理变量在场 + 用户未设 + Node ≥24 → 自动设 NODE_USE_ENV_PROXY=1", () => {
    const env: NodeJS.ProcessEnv = { HTTPS_PROXY: "http://127.0.0.1:7890" };
    expect(maybeEnableEnvProxy(env, 24)).toBe(true);
    expect(env.NODE_USE_ENV_PROXY).toBe("1");
  });

  it("② 用户显式 =0（明示直连）→ 尊重不动；③ 无代理变量 → 不设；④ Node 22 → 不设（NODE_USE_ENV_PROXY 是 24+ 的开关）", () => {
    expect(maybeEnableEnvProxy({ HTTPS_PROXY: "x", NODE_USE_ENV_PROXY: "0" }, 24)).toBe(false);
    expect(maybeEnableEnvProxy({ NODE_USE_ENV_PROXY: "0" }, 24)).toBe(false);
    expect(maybeEnableEnvProxy({}, 24)).toBe(false);
    expect(maybeEnableEnvProxy({ HTTP_PROXY: "x" }, 22)).toBe(false);
  });

  it("⑤ 小写与 http 形态同认（provider-custom menu.ts:188 同一变量族）", () => {
    const env: NodeJS.ProcessEnv = { https_proxy: "http://p:1" };
    expect(maybeEnableEnvProxy(env, 26)).toBe(true);
    const env2: NodeJS.ProcessEnv = { http_proxy: "http://p:1" };
    expect(maybeEnableEnvProxy(env2, 24)).toBe(true);
  });
});
