import { defineModule } from "@orosus/contracts/module";
import { PeersEnv } from "./env.ts";
import { createPeersTools } from "./tools.ts";

export default defineModule({
  name: "tool-peers",
  version: "0.1.0",
  description: "会话互相感知——同项目会话占用查询（声明+推导）与共享记忆",
  api: 1,
  defaultEnabled: false, // v2：默认卸载（D12）——走 settings「记忆」双开关启用（T6b）
  mounts: ["contribute:tool", "contribute:promptSection", "hook:session/start"],
  activate(ctx) {
    // T6 定稿 config schema 后换 cfg 驱动门控；T4 先硬编码默认接线
    const env = new PeersEnv({ workspaceMemory: false, sessionPeers: true, injectIndex: true, windowMinutes: 10, leaseMinutes: 30 });
    for (const t of createPeersTools(env, ctx.llm)) ctx.contribute.tool(t);
  },
});
