import { describe, it, expect } from "vitest";
import { NATIVE_SEARCH_FACES, matchNativeSearchFace } from "./search-endpoints.ts";

describe("已知可搜端点表（2026-09-24 对齐 Reasonix——openai 档 webSearch 请求改道依据）", () => {
  it("① 用户在配三家全命中：deepseek 裸 origin 与 /v1、kimi /coding/v1、zhipu coding paas 路径", () => {
    expect(matchNativeSearchFace("https://api.deepseek.com")?.anthropicRoot).toBe("https://api.deepseek.com/anthropic");
    expect(matchNativeSearchFace("https://api.deepseek.com/v1")?.anthropicRoot).toBe("https://api.deepseek.com/anthropic");
    expect(matchNativeSearchFace("https://api.kimi.com/coding/v1")?.anthropicRoot).toBe("https://api.kimi.com/coding");
    expect(matchNativeSearchFace("https://open.bigmodel.cn/api/coding/paas/v4")?.anthropicRoot).toBe("https://open.bigmodel.cn/api/anthropic");
  });

  it("② 已验证三家 verified=true；表共 16 条覆盖 Reasonix 全部 12 家可搜档", () => {
    const verified = NATIVE_SEARCH_FACES.filter((f) => f.verified);
    expect(verified.map((f) => f.chatBase).toSorted()).toEqual([
      "https://api.deepseek.com",
      "https://api.kimi.com/coding",
      "https://open.bigmodel.cn/api/coding",
    ]);
    expect(NATIVE_SEARCH_FACES).toHaveLength(16);
  });

  it("②b 全家覆盖钉（2026-09-24 用户拍板——Reasonix 经用户群验证的可搜端点全部收编）：12 家 16 chat 面全命中", () => {
    const chatFaces = [
      "https://api.deepseek.com/v1", // deepseek
      "https://api.longcat.chat/openai/v1", // longcat
      "https://api.kimi.com/coding/v1", // kimi
      "https://api.xiaomimimo.com/v1", // mimo 主端点
      "https://token-plan-cn.xiaomimimo.com/v1", // mimo 三区域
      "https://token-plan-sgp.xiaomimimo.com/v1",
      "https://token-plan-ams.xiaomimimo.com/v1",
      "https://api.minimaxi.com/v1", // minimax cn
      "https://api.minimax.io/v1", // minimax global
      "https://open.bigmodel.cn/api/coding/paas/v4", // 智谱 glm
      "https://api.z.ai/api/coding/paas/v4", // z.ai
      "https://opencode.ai/zen/go/v1", // opencode zen
      "https://coding.dashscope.aliyuncs.com/v1", // qwen cn
      "https://coding-intl.dashscope.aliyuncs.com/v1", // qwen intl
      "https://api.stepfun.com/v1", // 阶跃
      "https://ai-gateway.vercel.sh/v1", // vercel 网关
    ];
    for (const url of chatFaces) {
      expect(matchNativeSearchFace(url)).toBeDefined();
    }
  });

  it("③ 归一与边界：大小写/尾斜杠归一；未知端点、非法 URL、域名伪装（evil.io）不命中", () => {
    expect(matchNativeSearchFace("HTTPS://API.KIMI.COM/Coding/V1/")?.chatBase).toBe("https://api.kimi.com/coding");
    expect(matchNativeSearchFace("https://unknown.example/v1")).toBeUndefined();
    expect(matchNativeSearchFace("not a url")).toBeUndefined();
    expect(matchNativeSearchFace("https://api.deepseek.com.evil.io/v1")).toBeUndefined(); // origin 段整体比对防前缀伪装
    expect(matchNativeSearchFace("https://api.kimi.com/codingx/v1")).toBeUndefined(); // 路径段边界（/ 前缀不吞）
  });
});
