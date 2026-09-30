// T17（m4-3c）：Alt + N 添加/修改窗纯逻辑——草稿互转 / KEY=VALUE 解析（edit 保原值语义）/
// 手动校验链（含 Windows 路径守卫透传）/ JSON 五种错误文案（原型屏 6 全稿逐条对上）/ 控件清单结构。
import { describe, it, expect } from "vitest";
import {
  draftToJson, jsonToDraft, parseKeyValueLines, buildManualValues, parseJsonPaste, buildAddWidgets, emptyDraft,
} from "./mcp-add-window.ts";

describe("T17 添加窗——草稿互转（两页签共享体）", () => {
  it("① 手动 → JSON：stdio 拆 command/args、远程带 url、env/超时随行", () => {
    const d = { ...emptyDraft(), name: "my", cmd: "npx -y pkg --port 9", env: "A=1\nB=2", timeout: "90", cwd: "D:/x" };
    const text = draftToJson(d);
    const back = JSON.parse(text) as { mcpServers: Record<string, Record<string, unknown>> };
    expect(back.mcpServers.my).toEqual({ command: "npx", args: ["-y", "pkg", "--port", "9"], env: { A: "1", B: "2" }, cwd: "D:/x", timeoutMs: 90_000 });
    const remote = draftToJson({ ...emptyDraft(), name: "r", cmd: "https://x/sse", transport: "sse", headers: "Authorization=Bearer t" });
    const backR = JSON.parse(remote) as { mcpServers: Record<string, Record<string, unknown>> };
    expect(backR.mcpServers.r).toEqual({ url: "https://x/sse", transport: "sse" });
  });

  it("② JSON → 手动：URL/命令/env/超时回填；坏 JSON 原样不动", () => {
    const next = jsonToDraft(JSON.stringify({ mcpServers: { s: { command: "node", args: ["x.mjs"], env: { K: "v" }, timeoutMs: 30_000 } } }), emptyDraft());
    expect(next.name).toBe("s");
    expect(next.cmd).toBe("node x.mjs");
    expect(next.env).toBe("K=v");
    expect(next.timeout).toBe("30");
    const keep = { ...emptyDraft(), name: "保住" };
    expect(jsonToDraft("{ 坏", keep).name).toBe("保住");
  });
});

describe("T17 添加窗——KEY=VALUE 多行解析", () => {
  it("③ 每行一条成对；edit 模式裸 KEY = 保持原值；坏行报人话", () => {
    expect(parseKeyValueLines("A=1\nB = 2", "add").pairs).toEqual({ A: "1", B: "2" });
    const edit = parseKeyValueLines("TOKEN\nNEW=3", "edit");
    expect(edit.pairs).toEqual({ NEW: "3" });
    expect(edit.keepOnly).toEqual(["TOKEN"]);
    expect(parseKeyValueLines("不是键值行", "add").error).toContain("KEY=VALUE");
  });
});

describe("T17 添加窗——手动校验链（buildManualValues）", () => {
  const opts = { mode: "add" as const, existingNames: ["已有"] };
  it("④ 名称必填/重名不覆盖；stdio 命令守卫透传（未引号 Windows 路径拒绝）；URL 形态校验；超时正数", () => {
    expect(buildManualValues(emptyDraft(), opts).error).toContain("名称");
    expect(buildManualValues({ ...emptyDraft(), name: "已有" }, opts).error).toContain("不覆盖");
    const guard = buildManualValues({ ...emptyDraft(), name: "x", cmd: "C:\\Program Files\\a.exe --p" }, opts);
    expect(guard.error).toContain("加引号");
    expect(buildManualValues({ ...emptyDraft(), name: "x", cmd: "npx -y p" }, opts).values).toEqual({ command: "npx", args: ["-y", "p"] });
    expect(buildManualValues({ ...emptyDraft(), name: "x", cmd: "ftp://x", transport: "http" }, opts).error).toContain("http");
    expect(buildManualValues({ ...emptyDraft(), name: "x", cmd: "https://x/mcp", transport: "sse" }, opts).values).toEqual({ url: "https://x/mcp", transport: "sse" });
    expect(buildManualValues({ ...emptyDraft(), name: "x", cmd: "npx", timeout: "-3" }, opts).error).toContain("超时");
  });

  it("⑤ edit 模式：重名校验排除自身；env 只带改动的键（keepOnly 不进表）", () => {
    const edit = buildManualValues(
      { ...emptyDraft(), name: "gh", cmd: "npx -y p", env: "TOKEN\nEXTRA=2" },
      { mode: "edit", existingNames: ["gh", "别的"] },
    );
    expect(edit.values).toEqual({ command: "npx", args: ["-y", "p"], env: { EXTRA: "2" } }); // TOKEN 保原值不进表
  });
});

describe("T17 添加窗——JSON 五种错误（原型屏 6 注记全稿逐条对上）", () => {
  it("⑥ ①坏 JSON ②多个 server ③缺启动方式 ④重名（命令层验） ⑤空包裹", () => {
    expect(parseJsonPaste("{ 坏").error).toBe("这不是合法的 JSON——检查引号、逗号是否配对完整");
    expect(parseJsonPaste('{"a": {"command": "x"}, "b": {"url": "https://x"}}').error).toBe("一次只能装一个 server——这段里有 2 个（a、b），删到剩一个再保存");
    expect(parseJsonPaste('{"a": {"env": {}}}').error).toBe("server 条目缺启动方式——command（本地命令）或 url（远程地址）至少要有一个");
    expect(parseJsonPaste('{"mcpServers": {}}').error).toBe("mcpServers 里面是空的——没有可安装的 server");
    const ok = parseJsonPaste('{"mcpServers": {"m": {"command": "npx", "args": ["-y", "p"], "env": {"K": "v"}}}}');
    expect(ok.name).toBe("m");
    expect(ok.values).toEqual({ command: "npx", args: ["-y", "p"], env: { K: "v" } });
  });
});

describe("T17 添加窗——控件清单结构（三档联动）", () => {
  it("⑦ stdio 档高级区 = env/cwd/timeout；HTTP 档 = env/headers/timeout（无 cwd）；edit 名称锁定行；页签与错误行", () => {
    const stdio = buildAddWidgets({ tab: "manual", mode: "add", transport: "stdio", advOpen: true, err: "", ok: "" });
    const ids = stdio.map((w) => w.id);
    expect(ids).toContain("cwd");
    expect(ids).not.toContain("headers");
    const http = buildAddWidgets({ tab: "manual", mode: "add", transport: "http", advOpen: true, err: "", ok: "" });
    expect(http.map((w) => w.id)).toContain("headers");
    expect(http.map((w) => w.id)).not.toContain("cwd");
    const edit = buildAddWidgets({ tab: "manual", mode: "edit", transport: "stdio", advOpen: false, err: "", ok: "", editName: "gh" });
    expect(edit.map((w) => w.id)).toContain("name-lock");
    expect(edit.map((w) => w.id)).not.toContain("name");
    const json = buildAddWidgets({ tab: "json", mode: "add", transport: "stdio", advOpen: false, err: "✕ 测", ok: "" });
    expect(json.map((w) => w.id)).toContain("json");
    expect(json.some((w) => w.id === "msg")).toBe(true);
  });
});
