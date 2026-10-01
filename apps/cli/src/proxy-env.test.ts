import { describe, it, expect } from "vitest";
import { maybeEnableEnvProxy, readWindowsSystemProxy, proxyDisplayText, detectTunProxy } from "./proxy-env.ts";

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

describe("代理态双源检测（2026-10-01 走查修准「开了代理却显直连」——Windows 系统代理写注册表不设 env）", () => {
  const regOut = (name: string, value: string): string =>
    `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\r\n    ${name}    REG_${name === "ProxyEnable" ? "DWORD" : "SZ"}    ${value}\r\n`;

  it("① 系统代理整体形：ProxyEnable=1 + ProxyServer=127.0.0.1:7890 → 取 host", async () => {
    const p = await readWindowsSystemProxy({ platform: "win32", query: (n) => Promise.resolve(n === "ProxyEnable" ? regOut(n, "0x1") : regOut(n, "http=127.0.0.1:8080;https=127.0.0.1:7890")) });
    expect(p).toBe("127.0.0.1:7890"); // per-protocol 形态优先 https 段
  });

  it("② per-protocol 无 https 段退 http 段；整体形原样透传", async () => {
    const onlyHttp = (server: string) => readWindowsSystemProxy({ platform: "win32", query: (n) => Promise.resolve(n === "ProxyEnable" ? regOut(n, "0x1") : regOut(n, server)) });
    expect(await onlyHttp("http=127.0.0.1:8080")).toBe("127.0.0.1:8080");
    expect(await onlyHttp("127.0.0.1:7890")).toBe("127.0.0.1:7890");
  });

  it("③ ProxyEnable=0 / 注册表读失败 / 非 win32 → undefined", async () => {
    expect(await readWindowsSystemProxy({ platform: "win32", query: (n) => Promise.resolve(n === "ProxyEnable" ? regOut(n, "0x0") : regOut(n, "x")) })).toBeUndefined();
    expect(await readWindowsSystemProxy({ platform: "win32", query: () => Promise.reject(new Error("reg 不在")) })).toBeUndefined();
    expect(await readWindowsSystemProxy({ platform: "linux", query: () => Promise.resolve(regOut("ProxyEnable", "0x1")) })).toBeUndefined();
  });

  it("④ proxyDisplayText 四档：env > TUN > 系统代理 > 直连（TUN = 透明路由流量真走；系统代理本进程未走）", () => {
    expect(proxyDisplayText("http://127.0.0.1:7890", "10.0.0.2:8888", "Mihomo")).toBe("已启用 · 127.0.0.1:7890");
    expect(proxyDisplayText(undefined, "10.0.0.2:8888", "Mihomo")).toBe("TUN · Mihomo（透明路由）");
    expect(proxyDisplayText(undefined, "127.0.0.1:7890", undefined)).toBe("系统代理 · 127.0.0.1:7890（本进程未走）");
    expect(proxyDisplayText(undefined, undefined, undefined)).toBe("直连 · 未检测到代理");
    expect(proxyDisplayText("127.0.0.1:7890", undefined, undefined)).toBe("已启用 · 127.0.0.1:7890"); // 裸 host:port 形态
  });

  it("⑤ detectTunProxy：关键词网卡名命中 / fake-ip 网段 198.18.x 命中 / 组网网卡与 WLAN 不误伤 / 非 win32 不判", () => {
    const iface = (name: string, addr: string) => ({ [name]: [{ address: addr, family: "IPv4" as const, internal: false, mac: "", netmask: "", cidr: "", scopeid: undefined }] });
    expect(detectTunProxy({ ...iface("Mihomo", "198.18.0.1"), ...iface("WLAN", "192.168.3.12") }, "win32")).toBe("Mihomo");
    expect(detectTunProxy({ ...iface("以太网 3", "198.18.0.1") }, "win32")).toBe("以太网 3"); // 名字不带关键词但持 fake-ip 段
    expect(detectTunProxy({ ...iface("sing-box", "172.19.0.1"), ...iface("ZeroTier One [f37]", "10.72.145.189") }, "win32")).toBe("sing-box");
    expect(detectTunProxy({ ...iface("ZeroTier One [f37]", "10.72.145.189"), ...iface("WLAN", "192.168.3.12"), ...iface("NodeBabyLink", "10.222.222.1") }, "win32")).toBeUndefined();
    expect(detectTunProxy(iface("utun0", "198.18.0.1"), "darwin")).toBeUndefined(); // macOS utun 恒在场——不判（win32 限定）
  });
});
