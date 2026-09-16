import { defineModule, type ModuleDefinition } from "@orosus/contracts/module";
import { providerSlotKey, type Chunk, type ProviderRequest, type StreamFn } from "@orosus/contracts/provider";

/** fake provider：按脚本逐请求产出 chunk；requests 收集全部请求供断言（§12 M1 测试基建）。 */
export function fakeProvider(script: Chunk[][]): { stream: StreamFn; requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  let i = 0;
  return {
    requests,
    stream: (req) => {
      requests.push(req);
      const chunks = script[Math.min(i++, script.length - 1)] ?? [{ type: "finish", kind: "stop" } as Chunk];
      return (async function* () {
        for (const c of chunks) yield c;
      })();
    },
  };
}

/** fake provider 模块：经保留槽注册（§6.4 同一路径）。 */
export function fakeProviderModule(name: string, script: Chunk[][]): ModuleDefinition {
  const { stream } = fakeProvider(script);
  return defineModule({
    name: `provider-${name}`,
    version: "0.1.0",
    description: `fake provider ${name}`,
    api: 1,
    activate(ctx) {
      ctx.provide(providerSlotKey(name), stream);
    },
  });
}

/** 快速造模块（测试用）。 */
export function fakeModule(name: string, extra: Partial<ModuleDefinition> = {}): ModuleDefinition {
  return defineModule({ name, version: "0.1.0", description: name, api: 1, activate() {}, ...extra });
}
