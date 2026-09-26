import { defineModule } from "@orosus/contracts/module";
import type { SessionTreeNode } from "@orosus/contracts/module";

/** 会话树批 T12：树视图驾驶舱——看树（/session-tree__view 全屏弹窗）、跳枝（Enter）、
 *  建枝（/session-tree__branch <序号|sid> 在该节点的分叉点开新枝；缺省 = 当前末尾）。
 *  三缝（ctx.session.fork/tree/switchTo）的第一位真实消费者。
 *  键位注记：方案的裸键 b 建枝在控件窗契约里没有自定义键通道（DialogEvent 只有 input/select/activate
 *  三型——中途扩契约违攒批纪律），首版以第二条命令承担；裸键进顺延台账（等控件窗自定义键契约窗口）。 */

/** 渲染排序（序号解析与弹窗列表同源——两处必须同一顺序，避免两套序号）：深度浅在前（父先于子）、
 *  同层按创建时间；孤立节点（父不在集）殿后——断链异常态放尾部不干扰主树阅读。深度经 parentSession
 *  上溯计算（visited 防环、孤立节点父缺席即止）。 */
export function orderedTreeNodes(nodes: SessionTreeNode[]): SessionTreeNode[] {
  const byId = new Map(nodes.map((n) => [n.sessionId, n]));
  const depthCache = new Map<string, number>();
  const depthOf = (n: SessionTreeNode): number => {
    const cached = depthCache.get(n.sessionId);
    if (cached !== undefined) return cached;
    let depth = 0;
    const seen = new Set<string>([n.sessionId]);
    let p = n.parentSession !== null ? byId.get(n.parentSession) : undefined;
    while (p !== undefined && !seen.has(p.sessionId)) {
      depth++;
      seen.add(p.sessionId);
      p = p.parentSession !== null ? byId.get(p.parentSession) : undefined;
    }
    depthCache.set(n.sessionId, depth);
    return depth;
  };
  const orphan = (n: SessionTreeNode): boolean => n.parentSession !== null && !byId.has(n.parentSession);
  return [...nodes].sort((a, b) => {
    const oa = orphan(a) ? 1 : 0;
    const ob = orphan(b) ? 1 : 0;
    if (oa !== ob) return oa - ob; // 连通树先、孤立殿后
    const da = depthOf(a);
    const db = depthOf(b);
    if (da !== db) return da - db;
    return a.createdAtMs - b.createdAtMs;
  });
}

/** 树渲染纯函数（设计空白 9/10）：每节点一行「缩进两格每层 + 标题（自身 N 条）」；
 *  当前所在枝（根 → 当前会话的整条路径）行内 ▸ 标记；未命名节点显「新会话」不裸显 sid（2026-09-23 拍板）；
 *  孤立节点（父不在快照集——含存量跨桶链的他桶父）带「根缺失」标注原样保留（T7 口径：不修复不剔除）。 */
export function renderTreeLines(nodes: SessionTreeNode[], currentSessionId?: string): string[] {
  const byId = new Map(nodes.map((n) => [n.sessionId, n]));
  const activePath = new Set<string>(); // 当前枝 = 当前节点上溯到根的路径集合（含自己）
  {
    let c = currentSessionId !== undefined ? byId.get(currentSessionId) : undefined;
    const seen = new Set<string>();
    while (c !== undefined && !seen.has(c.sessionId)) {
      activePath.add(c.sessionId);
      seen.add(c.sessionId);
      c = c.parentSession !== null ? byId.get(c.parentSession) : undefined;
    }
  }
  return orderedTreeNodes(nodes).map((n) => {
    let indent = 0;
    const seen = new Set<string>([n.sessionId]);
    let p = n.parentSession !== null ? byId.get(n.parentSession) : undefined;
    while (p !== undefined && !seen.has(p.sessionId)) {
      indent++;
      seen.add(p.sessionId);
      p = p.parentSession !== null ? byId.get(p.parentSession) : undefined;
    }
    const marker = activePath.has(n.sessionId) ? "▸ " : "  ";
    const title = n.label ?? "新会话";
    const orphanNote = n.parentSession !== null && !byId.has(n.parentSession) ? " · 根缺失" : "";
    return `${"  ".repeat(indent)}${marker}${title}（自身 ${n.ownEvents} 条）${orphanNote}`;
  });
}

/** 渲染带序号清单（弹窗 list 项 = 「N. 行文本」——序号即 branch 参数，看树与建枝同一坐标系）。 */
export function numberedTreeLines(nodes: SessionTreeNode[], currentSessionId?: string): string[] {
  return renderTreeLines(nodes, currentSessionId).map((l, i) => `${i + 1}. ${l}`);
}

/** branch 参数解析：序号（按 view 渲染顺序，1-based）或 sid → 目标会话 id；解析不到 undefined
 *  （缺省参数由调用方处理 = 当前投影尾分叉）。 */
export function resolveBranchTarget(nodes: SessionTreeNode[], arg: string): string | undefined {
  const trimmed = arg.trim();
  if (trimmed === "") return undefined;
  if (/^\d+$/.test(trimmed)) {
    const node = orderedTreeNodes(nodes)[Number(trimmed) - 1];
    return node?.sessionId;
  }
  return nodes.some((n) => n.sessionId === trimmed) ? trimmed : undefined;
}

export default defineModule({
  name: "session-tree",
  version: "0.1.0",
  description: "会话树驾驶舱——看树（view）、跳枝（Enter）、建枝（branch）",
  api: 1,
  mounts: ["contribute:command", "session.fork", "session.switch"], // 决策点 7：fork/switch 有门；tree 只读无门；命令注册占 contribute:command 位
  defaultEnabled: true, // 设计空白 12：内建清单挂载、默认启用
  activate(ctx) {
    const ensureTree = async (): Promise<SessionTreeNode[] | undefined> => {
      if (ctx.session.tree === undefined) {
        ctx.log.warn("session-tree.no-tree-port", "当前宿主无 tree 读口（老宿主/无头）——判空降级");
        return undefined;
      }
      return ctx.session.tree();
    };
    ctx.contribute.command("session-tree__view", async (_args, ui) => {
      const nodes = await ensureTree();
      if (nodes === undefined) return "当前宿主不支持会话树（无 tree 读口）";
      const lines = numberedTreeLines(nodes, ctx.session.id);
      if (lines.length === 0) return "（暂无会话——发送第一条消息即创建）";
      const ordered = orderedTreeNodes(nodes);
      const openFallback = (): void => {
        ui.viewText?.("会话树", lines.join("\n"), { layout: "full" }); // 行模式/无控件窗宿主的回落
      };
      if (ui.dialog === undefined) { openFallback(); return ""; }
      const handle = ui.dialog({
        title: "会话树 —— ↑↓ 选择 · Enter 跳入该枝 · Esc 关闭",
        layout: "full",
        widgets: [
          { id: "tree", kind: "list", interactive: true, items: lines },
          { id: "hint", kind: "text", text: "在此分叉：/session-tree__branch <序号|sid>（缺省 = 当前末尾）", style: "muted" },
        ],
        onEvent: (e) => {
          if (e.type === "activate" && e.id === "tree" && e.index !== undefined) {
            const target = ordered[e.index];
            if (target === undefined || target.sessionId === ctx.session.id) return undefined;
            if (ctx.session.switchTo === undefined) return undefined;
            void ctx.session.switchTo(target.sessionId).then((ok) => {
              if (!ok) ctx.log.warn("session-tree.switch-rejected", "宿主拒绝切换（会话不存在或不在当前项目桶——#17 桶闸）", { target: target.sessionId });
            });
          }
          return undefined; // 切换受理后本模块随旧 harness 销毁——窗由宿主随图拆（m5 T7 卸载关窗语义）
        },
      });
      if (handle === undefined) openFallback();
      return "";
    });
    ctx.contribute.command("session-tree__branch", async (args, ui) => {
      if (ctx.session.fork === undefined) return "当前宿主不支持分叉（无 fork 口）";
      const nodes = await ensureTree();
      if (nodes === undefined) return "当前宿主不支持会话树（无 tree 读口）";
      let at: string | undefined;
      if (args.trim() !== "") {
        const target = resolveBranchTarget(nodes, args);
        if (target === undefined) return `未找到目标会话「${args.trim()}」（/session-tree__view 看树取序号或 sid）`;
        at = nodes.find((n) => n.sessionId === target)!.sourceEntryId ?? undefined; // 选中节点的分叉点（v1.4 定案语义）
      }
      try {
        const { sessionId } = await (at !== undefined ? ctx.session.fork({ atEntryId: at }) : ctx.session.fork());
        await ui.notice?.(`已分出新枝 ${sessionId}——/session-tree__view 查看`, { durationMs: 8000 });
        return "";
      } catch (err) {
        // h.fork 校验：atEntryId 不在当前投影（选中节点在别的枝上）——先跳过去再分叉（方案 T12 原文案）
        return `分叉点不在当前会话的投影内（${String(err)}）——先 /session-tree__view 回车跳到该枝，再在末尾分叉`;
      }
    });
  },
});
