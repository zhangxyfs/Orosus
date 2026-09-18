import type { Chunk } from "@orosus/contracts/provider";
import type { Harness, SessionEvent } from "@orosus/core";

/** 单事件 → 终端文案（M3 补强 T8：从 main.ts 抽出的可测渲染面——write 注入 stdout，装配层测试经真 harness 事件流驱动）。
 *  压缩/裁剪对用户可见（三轮 P1：此前零渲染——自动压缩时界面毫无提示、失败的 /compact 零反馈）；四家参考均有可见提示。 */
export function renderEvent(e: SessionEvent): string {
  if (e.type === "assistant/chunk") {
    const c = e.chunk as Chunk;
    if (c.type === "text/delta") return c.text;
    if (c.type === "finish" && c.kind === "error") {
      // 401/403 提示（模型发现 T5，走查缺陷③提示面）：校验用输入值、运行用合并链（显式 env > process.env > secrets.env）
      // ——同名环境变量覆盖刚写入的 secrets 是最常见根因，给用户排查方向
      const hint = /HTTP 40[13]/.test(c.errorMessage ?? "")
        ? "\n[提示] 密钥被拒——若刚更新过 secrets.env，检查同名环境变量是否覆盖（优先级：显式 env > process.env > secrets.env）\n"
        : "";
      return `\n[模型错误] ${c.errorMessage ?? ""}${hint}`;
    }
    return "";
  }
  if (e.type === "tool/call") return `\n[tool] ${String(e.name)} ${JSON.stringify(e.args)}\n`;
  if (e.type === "tool/result") return `[tool ${e.isError === true ? "错误" : "完成"}]\n`;
  if (e.type === "turn/compaction") return `\n[已压缩：前 ${Number(e.droppedCount ?? 0)} 条历史已摘要，完整原文在会话文件中]\n`;
  if (e.type === "turn/prune") return `\n[已裁剪 ${Array.isArray(e.prunes) ? (e.prunes as unknown[]).length : 0} 个超长工具结果（原文保留在会话文件中）]\n`;
  if (e.type === "turn/end") return "\n";
  return "";
}

/** 挂接渲染（main.ts 的接线面）：事件流 → renderEvent → write（缺省 process.stdout）；onEvent 供 /fork 记 lastEventId。 */
export function attachRender(h: Harness, write: (s: string) => void, onEvent?: (id: string) => void): void {
  void (async () => {
    for await (const e of h.events()) {
      onEvent?.(e.id);
      const out = renderEvent(e);
      if (out !== "") write(out);
    }
  })();
}
