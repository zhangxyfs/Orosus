/** web 批 T1 伴生测试：`orosus web` 骨架——鉴权三道门 / 实例复用与接管 / 端口换号 / URL 横幅 / 引导门。
 *  按任务简报 ①-⑩ 编号逐条对应（断言文案与 brief 逐字锚定）。
 *  真起 server 真发请求（startWebServer / fetch / node:http request）；runWebSubcommand 的长驻路径
 *  用「并发启动 + 轮询横幅 + shutdownWebServer 触发清退」收口——与 SIGINT 清退序同一函数口。 */
import { afterEach, describe, expect, it } from "vitest";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createTcpServer, type AddressInfo, type Server as TcpServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { isWebSubcommand, runWebSubcommand } from "./mod.ts";
import { instanceFilePath, writeInstance } from "./instance.ts";
import { pickFreePort, shutdownWebServer, startWebServer } from "./server.ts";

/** 轮询等待（25ms 步进；超时抛错——banner 等异步里程碑用）。 */
const waitFor = async (pred: () => boolean, ms = 5_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("waitFor 超时");
};

/** 保证已死的 pid：起一个即退的 node 子进程取 pid（进程表复用窗口内不可能复活）。 */
const deadPid = async (): Promise<number> => {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const code = await new Promise<number>((resolve) => child.once("exit", (c) => resolve(c ?? 0)));
  expect(code).toBe(0);
  return child.pid ?? -1;
};

/** 引导门放行形态的 config.toml：model 指向已配置槽位（needsProviderSetup → false）。 */
const writeProviderConfig = (home: string): void => {
  writeFileSync(join(home, "config.toml"), 'model = "demo/model-x"\n\n[provider-custom.providers.demo]\nbaseUrl = "http://127.0.0.1:9"\n', "utf8");
};

describe("web T1：`orosus web` 子命令 + server 骨架", () => {
  const homes: string[] = [];
  const tmpHome = (): string => {
    const h = mkdtempSync(join(tmpdir(), "orosus-web-t1-"));
    homes.push(h);
    return h;
  };

  afterEach(() => {
    shutdownWebServer("test-cleanup"); // 幂等——失败用例兜底清退，防 SIGINT 挂钩与 server 泄漏到后续用例
    while (homes.length > 0) {
      const h = homes.pop()!;
      try { rmSync(h, { recursive: true, force: true }); } catch { /* Windows 句柄迟到则留给系统 tmp 清理 */ }
    }
  });

  it("isWebSubcommand：仅识别首词 web", () => {
    expect(isWebSubcommand(["web"])).toBe(true);
    expect(isWebSubcommand(["web", "--port", "8080", "--no-open"])).toBe(true);
    expect(isWebSubcommand(["webs"])).toBe(false);
    expect(isWebSubcommand(["upgrade"])).toBe(false);
    expect(isWebSubcommand([])).toBe(false);
  });

  it("①②③⑩ token 门 / Host 白名单 / health 应答 / 畸形请求护栏", async () => {
    const home = tmpHome();
    const { server, port, token } = await startWebServer({ cwd: process.cwd(), home });
    const base = `http://127.0.0.1:${port}`;
    const authed = { "x-orosus-token": token };
    try {
      // ③ GET /api/health 带 token → 200 {ok:true}（?token= 同源可用——浏览器首开 URL 形态）
      const okRes = await fetch(`${base}/api/health`, { headers: authed });
      expect(okRes.status).toBe(200);
      expect(await okRes.json()).toMatchObject({ ok: true });
      const qRes = await fetch(`${base}/api/health?token=${token}`);
      expect(qRes.status).toBe(200);

      // ① token 错 → 401
      const badRes = await fetch(`${base}/api/health`, { headers: { "x-orosus-token": "deadbeef" } });
      expect(badRes.status).toBe(401);

      // ② Host 头 evil.com → 403（Host 白名单先于 token——DNS rebinding 防线；node:http request 直设 host 头，
      //    免 fetch 规范禁改 Host 的实现差异）；带端口的本地 Host 形态合法
      const hostProbe = (host: string): Promise<number> => new Promise((resolve, reject) => {
        const req = httpRequest({ host: "127.0.0.1", port, path: "/api/health", headers: { host, ...authed } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end();
      });
      expect(await hostProbe("evil.com")).toBe(403);
      expect(await hostProbe(`127.0.0.1:${port}`)).toBe(200);

      // ⑩ 坏 %-escape 路径 → 400（per-request catch 兜底），且进程存活——健康探测照常 200
      const malRes = await fetch(`${base}/api/%zz%e9%ad%87`, { headers: authed });
      expect(malRes.status).toBe(400);
      const aliveRes = await fetch(`${base}/api/health`, { headers: authed });
      expect(aliveRes.status).toBe(200);
    } finally {
      server.close();
      server.closeAllConnections?.();
    }
  });

  it("④ 实例文件活 pid + health 应答 → 复用既有实例退出 0（不起第二个 server）", async () => {
    const home = tmpHome();
    writeProviderConfig(home); // 过引导门（G16 在复用判定之前）
    const fakeToken = "a".repeat(64);
    // 假「活实例」：真起一个 /api/health 应答 server + 实例文件指向它（pid = 本测试进程 = 活）
    const fake = createHttpServer((req, res) => {
      if (req.url === "/api/health" && req.headers["x-orosus-token"] === fakeToken) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      }
    });
    await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", () => resolve()));
    const fakePort = (fake.address() as AddressInfo).port;
    writeInstance(home, { v: 1, pid: process.pid, port: fakePort, startedAt: Date.now(), token: fakeToken });

    const lines: string[] = [];
    const code = await runWebSubcommand(["web", "--no-open"], { out: (l) => lines.push(l), env: { OROSUS_HOME: home } });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain(`http://127.0.0.1:${fakePort}`); // 复用打印同 URL
    fake.close();
    fake.closeAllConnections?.();
  });

  it("⑤ 死 pid 实例文件 → 接管重写且 token 沿用（不重铸）+ 清退删实例文件", async () => {
    const home = tmpHome();
    writeProviderConfig(home);
    const oldToken = "b".repeat(64);
    writeInstance(home, { v: 1, pid: await deadPid(), port: 5317, startedAt: 1_000, token: oldToken });

    const lines: string[] = [];
    const run = runWebSubcommand(["web", "--no-open"], { out: (l) => lines.push(l), env: { OROSUS_HOME: home } });
    // 接管完成 = 实例文件被本进程重写（pid 换成 process.pid）
    await waitFor(() => {
      try { return (JSON.parse(readFileSync(instanceFilePath(home), "utf8")) as { pid?: unknown }).pid === process.pid; }
      catch { return false; }
    });
    const after = JSON.parse(readFileSync(instanceFilePath(home), "utf8")) as { pid: number; port: number; token: string };
    shutdownWebServer("test");
    expect(await run).toBe(0);
    expect(after.token).toBe(oldToken); // 沿用不重铸——重启后旧标签页可重试恢复（G15 链）
    expect(after.pid).toBe(process.pid); // 接管重写
    expect(lines.join("\n")).toContain(`http://127.0.0.1:${after.port}`);
    expect(existsSync(instanceFilePath(home))).toBe(false); // 清退序删实例文件（Ctrl+C 后即删——手测同面）
  });

  it("⑥ 端口换号：pickFreePort 避占 + startWebServer 实际端口 ≠ 请求值", async () => {
    const holder: TcpServer = createTcpServer();
    await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", () => resolve()));
    const heldPort = (holder.address() as AddressInfo).port;
    try {
      const picked = await pickFreePort(heldPort);
      expect(picked).not.toBe(heldPort);

      const { server, port, token } = await startWebServer({ port: heldPort, cwd: process.cwd(), home: tmpHome() });
      try {
        expect(port).not.toBe(heldPort); // 换号成功且返回实际端口
        const res = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { "x-orosus-token": token } });
        expect(res.status).toBe(200); // 真听上并能应答
      } finally {
        server.close();
        server.closeAllConnections?.();
      }
    } finally {
      holder.close();
    }
  });

  it("⑦ URL 横幅三要素（完整 URL / 手动指路 / 终端存亡提示）", async () => {
    const home = tmpHome();
    writeProviderConfig(home);
    const lines: string[] = [];
    const run = runWebSubcommand(["web", "--no-open"], { out: (l) => lines.push(l), env: { OROSUS_HOME: home } });
    await waitFor(() => lines.some((l) => l.includes("http://127.0.0.1")));
    shutdownWebServer("test");
    expect(await run).toBe(0);
    const out = lines.join("\n");
    expect(out).toMatch(/http:\/\/127\.0\.0\.1:\d+/); // ① 要素：完整 URL
    expect(out).toContain("如果浏览器没有自动打开，请手动复制上方网址到浏览器");
    expect(out).toContain("保持本终端开启——关闭终端将同时关闭网页端");
  });

  it("⑧ --port 显式被占 → 换号提示「已被占用，已换用」", async () => {
    const home = tmpHome();
    writeProviderConfig(home);
    const holder: TcpServer = createTcpServer();
    await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", () => resolve()));
    const heldPort = (holder.address() as AddressInfo).port;
    try {
      const lines: string[] = [];
      const run = runWebSubcommand(["web", "--no-open", "--port", String(heldPort)], { out: (l) => lines.push(l), env: { OROSUS_HOME: home } });
      await waitFor(() => lines.some((l) => l.includes("http://127.0.0.1")));
      shutdownWebServer("test");
      expect(await run).toBe(0);
      expect(lines.join("\n")).toContain("已被占用，已换用");
    } finally {
      holder.close();
    }
  });

  it("⑨ 引导门（G16）：未引导 → 退出 1 指路终端；写入 provider 配置后正常起服", async () => {
    const home = tmpHome(); // 无 config.toml
    const emptyCwd = tmpHome(); // 项目层也无配置（隔离仓库自身 .orosus 项目层）
    const lines: string[] = [];
    const code = await runWebSubcommand(["web", "--no-open"], {
      out: (l) => lines.push(l),
      env: { OROSUS_HOME: home },
      cwd: emptyCwd,
    });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("请先在终端运行 orosus 完成首次引导");
    expect(existsSync(instanceFilePath(home))).toBe(false); // 不启 server——无实例文件（无端口监听）

    // 写入 provider 配置后正常起服：真发 health 请求确认监听
    writeProviderConfig(home);
    const lines2: string[] = [];
    const run = runWebSubcommand(["web", "--no-open"], { out: (l) => lines2.push(l), env: { OROSUS_HOME: home }, cwd: emptyCwd });
    await waitFor(() => lines2.some((l) => l.includes("http://127.0.0.1")));
    const inst = JSON.parse(readFileSync(instanceFilePath(home), "utf8")) as { port: number; token: string };
    const res = await fetch(`http://127.0.0.1:${inst.port}/api/health`, { headers: { "x-orosus-token": inst.token } });
    expect(res.status).toBe(200);
    shutdownWebServer("test");
    expect(await run).toBe(0);
  });
});
