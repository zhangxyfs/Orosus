import { defineModule } from "@orosus/contracts/module";

export default defineModule({
  name: "tool-peers",
  version: "0.1.0",
  description: "会话互相感知——同项目会话占用查询（声明+推导）与共享记忆",
  api: 1,
  defaultEnabled: false, // v2：默认卸载（D12）——走 settings「记忆」双开关启用（T6b）
  mounts: ["contribute:tool", "contribute:promptSection", "hook:session/start"],
  activate(_ctx) {
    // T2/T4/T5/T6 逐步填充
  },
});
