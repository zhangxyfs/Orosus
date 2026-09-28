import { defineModule, MODULE_API_VERSION, type ModuleDefinition } from "@orosus/contracts/module";
import { providerSlotKey, type Chunk, type ProviderRequest, type StreamFn } from "@orosus/contracts/provider";

/** fake provider：按脚本逐请求产出 chunk；requests 收集全部请求供断言（§12 M1 测试基建）。
 *  两条缺省行为（CT-05 钉，与真实适配器契约对齐）：
 *  ①响应取消——generator 每 yield 前查 req.signal，已 abort 改产 finish{kind:"aborted"} 收尾
 *   （stream-openai/anthropic 同款取消语义），不再续播脚本剩余段；
 *  ②脚本耗尽后钳位静默重复末段（多发请求不炸——jobs.test.ts「末段重复无害」既有口径，保留）。 */
export function fakeProvider(script: Chunk[][]): { stream: StreamFn; requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  let i = 0;
  return {
    requests,
    stream: (req) => {
      requests.push(req);
      const chunks = script[Math.min(i++, script.length - 1)] ?? [{ type: "finish", kind: "stop" } as Chunk];
      return (async function* () {
        for (const c of chunks) {
          if (req.signal.aborted) {
            yield { type: "finish", kind: "aborted" }; // CT-05：abort 后带内收尾，剩余段不播
            return;
          }
          yield c;
        }
      })();
    },
  };
}

/** fake provider 模块：经保留槽注册（§6.4 同一路径）。api 引用 MODULE_API_VERSION 同源（CT-06）——
 *  契约主版本升档后 fake 基建不再静默停在旧代。 */
export function fakeProviderModule(name: string, script: Chunk[][]): ModuleDefinition {
  const { stream } = fakeProvider(script);
  return defineModule({
    name: `provider-${name}`,
    version: "0.1.0",
    description: `fake provider ${name}`,
    api: MODULE_API_VERSION,
    activate(ctx) {
      ctx.provide(providerSlotKey(name), stream);
    },
  });
}

/** 快速造模块（测试用）。api 引用 MODULE_API_VERSION 同源（CT-06）。 */
export function fakeModule(name: string, extra: Partial<ModuleDefinition> = {}): ModuleDefinition {
  return defineModule({ name, version: "0.1.0", description: name, api: MODULE_API_VERSION, activate() {}, ...extra });
}
