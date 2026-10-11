/** web 批 T17 伴生测试：F10 已归档页的排序/筛选/分组纯函数（assets/archived-view.js——node 直测零
 *  DOM 依赖，GC5 测试先行）。口径：原型 :3045-3108（搜索 = 标题不区分大小写子串；工作区筛选 =
 *  cwd 精确等值；三排序 = 归档时间倒序 / 创建时间倒序 / 标题字母 localeCompare zh-CN；分组 =
 *  按 cwd 首次出现序聚合）。三算子正交：任意组合 = 先筛选、再排序、后分组（archivedView 组合口）。
 *  数据源形状：GET /api/archived → {items:[{sid,title,cwd,archivedAt,createdAt}]}（session-actions.ts）。 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import "./assets/archived-view.js"; // 副作用挂 globalThis.OrosusArchived（经典脚本零构建——node/浏览器同源导出）

interface Item {
  sid: string;
  title: string;
  cwd: string;
  archivedAt: number;
  createdAt: number;
}
interface ArchivedApi {
  filterArchived: (items: Item[], q: string, ws: string) => Item[];
  sortArchived: (items: Item[], sort: string) => Item[];
  groupArchived: (items: Item[]) => Array<{ key: string; name: string; items: Item[] }>;
  archivedView: (items: Item[], state: { q?: string; ws?: string; sort?: string }) => Array<{ key: string; name: string; items: Item[] }>;
}
const AV = (globalThis as { OrosusArchived?: ArchivedApi }).OrosusArchived!;
const ASSETS_DIR = fileURLToPath(new URL("./assets/", import.meta.url));

/* 种子：两工作区 / 标题含大小写与中文 / 双时间乱序交叉——覆盖三排序的分异面 */
const SEED: Item[] = [
  { sid: "s1", title: "调研 WebGL 渲染管线", cwd: "D:/proj/alpha", archivedAt: 300, createdAt: 100 },
  { sid: "s2", title: "web-server 重构", cwd: "D:/proj/beta", archivedAt: 100, createdAt: 500 },
  { sid: "s3", title: "Alpha 环境部署", cwd: "D:/proj/alpha", archivedAt: 500, createdAt: 300 },
  { sid: "s4", title: "数据库迁移脚本", cwd: "D:/proj/beta", archivedAt: 200, createdAt: 400 },
  { sid: "s5", title: "", cwd: "D:/proj/alpha", archivedAt: 400, createdAt: 200 }, // 空标题（未命名会话）
];

describe("web T17：已归档视图纯函数（F10——三排序×筛选×分组正交）", () => {
  it("① 文件存在 + index.html 接线（序在 app.js 之前）", () => {
    expect(existsSync(join(ASSETS_DIR, "archived-view.js"))).toBe(true);
    const html = readFileSync(join(ASSETS_DIR, "index.html"), "utf8");
    const iAv = html.indexOf("/assets/archived-view.js");
    expect(iAv).toBeGreaterThan(0);
    expect(iAv).toBeLessThan(html.indexOf("/assets/app.js"));
  });

  it("② 筛选：q 标题子串（不区分大小写）· ws 工作区精确等值 · 双条件合取 · 纯函数不改入参", () => {
    const q1 = AV.filterArchived(SEED, "web", "");
    expect(q1.map((i) => i.sid)).toEqual(["s1", "s2"]); // WebGL 命中 + web-server 命中
    const q2 = AV.filterArchived(SEED, "ALPHA", ""); // 大写查询命中小写标题
    expect(q2.map((i) => i.sid)).toEqual(["s3"]);
    const ws = AV.filterArchived(SEED, "", "D:/proj/beta");
    expect(ws.map((i) => i.sid)).toEqual(["s2", "s4"]);
    const both = AV.filterArchived(SEED, "迁移", "D:/proj/beta");
    expect(both.map((i) => i.sid)).toEqual(["s4"]);
    expect(AV.filterArchived(SEED, "不存在", "")).toEqual([]);
    const frozen = JSON.parse(JSON.stringify(SEED));
    AV.filterArchived(SEED, "web", "D:/proj/alpha");
    expect(SEED).toEqual(frozen); // 入参零改动
  });

  it("③ 三排序：archived 归档时间倒序（缺省序）· created 创建时间倒序 · alpha 标题字母（zh-CN）", () => {
    expect(AV.sortArchived(SEED, "archived").map((i) => i.sid)).toEqual(["s3", "s5", "s1", "s4", "s2"]);
    expect(AV.sortArchived(SEED, "created").map((i) => i.sid)).toEqual(["s2", "s4", "s3", "s5", "s1"]);
    const alpha = AV.sortArchived(SEED, "alpha").map((i) => i.title);
    /* 原型同款 localeCompare(·,'zh-CN')（Node ICU：拉丁相对序 A<w、中文拼音序 调<数、跨文种相对位
     * 随 ICU 版本——只断言稳定不变式，不断言跨文种绝对位）。空标题（未命名会话）恒殿后。 */
    expect(alpha.indexOf("Alpha 环境部署")).toBeLessThan(alpha.indexOf("web-server 重构")); // 拉丁字母序
    expect(alpha.indexOf("调研 WebGL 渲染管线")).toBeLessThan(alpha.indexOf("数据库迁移脚本")); // 拼音 d<sh
    expect(alpha[alpha.length - 1]).toBe(""); // 空标题排尾
    expect(AV.sortArchived(SEED, "unknown-key").map((i) => i.sid)).toEqual(
      AV.sortArchived(SEED, "archived").map((i) => i.sid),
    ); // 未知键回缺省排序
    const frozen = JSON.parse(JSON.stringify(SEED));
    AV.sortArchived(SEED, "alpha");
    expect(SEED).toEqual(frozen); // 入参零改动（排序在拷贝上做）
  });

  it("④ 分组：按 cwd 聚合、组名 = basename、组序 = 排序后首次出现序、条目恰出现一次", () => {
    const sorted = AV.sortArchived(SEED, "archived"); // s3,s5,s1(alpha) / s4,s2(beta)
    const groups = AV.groupArchived(sorted);
    expect(groups.map((g) => g.key)).toEqual(["D:/proj/alpha", "D:/proj/beta"]);
    expect(groups.map((g) => g.name)).toEqual(["alpha", "beta"]);
    expect(groups[0]!.items.map((i) => i.sid)).toEqual(["s3", "s5", "s1"]);
    expect(groups[1]!.items.map((i) => i.sid)).toEqual(["s4", "s2"]);
    const flat = groups.flatMap((g) => g.items);
    expect(flat).toHaveLength(SEED.length);
    for (const seed of SEED) expect(flat.filter((f) => f.sid === seed.sid)).toHaveLength(1); // 无丢失无重复
    expect(AV.groupArchived([])).toEqual([]);
  });

  it("⑤ 正交性：3 排序 × {无/有 ws 筛选} × {无/有 q 筛选} 全组合 = 手工管线逐一致", () => {
    for (const sort of ["archived", "created", "alpha"]) {
      for (const ws of ["", "D:/proj/alpha"]) {
        for (const q of ["", "web", "迁移"]) {
          const got = AV.archivedView(SEED, { q, ws, sort });
          const manual = AV.groupArchived(AV.sortArchived(AV.filterArchived(SEED, q, ws), sort));
          expect(got.map((g) => g.key + ":" + g.items.map((i) => i.sid).join(","))).toEqual(
            manual.map((g) => g.key + ":" + g.items.map((i) => i.sid).join(",")),
          );
          // 空结果形态：groups = []（前端据此出「没有匹配」提示）
          if (AV.filterArchived(SEED, q, ws).length === 0) expect(got).toEqual([]);
        }
      }
    }
  });

  it("⑥ 组合口缺省态：无 state / 空串 = 不过滤不排序外（archived 缺省序）", () => {
    const got = AV.archivedView(SEED, {});
    expect(got.flatMap((g) => g.items).map((i) => i.sid)).toEqual(AV.sortArchived(SEED, "archived").map((i) => i.sid));
  });

  it("⑦ app.js 消费面：F10 页经 OrosusArchived 组合口渲染（源码锚定）", () => {
    const src = readFileSync(join(ASSETS_DIR, "app.js"), "utf8");
    expect(src.includes("OrosusArchived")).toBe(true);
    expect(src.includes("archivedView")).toBe(true);
  });

  it("⑧ F3 偏好 revert 闭包零 this 形态（审查 Important——strict-mode 裸调用 this === undefined 会 TypeError，回滚失效）", () => {
    const src = readFileSync(join(ASSETS_DIR, "app.js"), "utf8");
    // revert 闭包以裸函数调用（postPref 内 revert()）——function () { this.value = … } 在顶层 IIFE
    // 'use strict' 下 this === undefined，赋值抛 TypeError：select 停在失败值与盘上真值脱同步。
    // 负断言：该闭包形态在 app.js 绝迹（change 监听器体内的 this.value = prev 合法——this 是元素，不在匹配面）。
    expect(src.includes("function () { this.value ="), "revert 闭包不得用 this").toBe(false);
    // 正锚定：五键 revert 均改捕获元素（el.value = 原值）
    for (const anchor of ["el.value = vision", "el.value = search", "el.value = sub.model", "el.value = sub.approvalMode", "el.value = turnCur"]) {
      expect(src.includes(anchor), `revert 须捕获元素：${anchor}`).toBe(true);
    }
  });
});
