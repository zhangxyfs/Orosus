import { defineConfig } from "tsdown";

// release-npm T2：单包发行物构建。20 个 workspace 包全 bundle（唯一例外 testing 纯测试件），
// 11 件外部运行时依赖全 external——必须正则形态（S0 实测：字符串裸名不匹配 @jsquash/webp/decode.js
// 等 import 的子路径形态，@jsquash/webp 与 @modelcontextprotocol/sdk 曾被整包误捆 16 文件 2473KB，
// 正则后 3 文件 1650KB）。worker 双入口按 D4=B（S0 定案：rolldown 1.0.0-beta.8 对
// new Worker(new URL("./x.ts")) 原样保留 .ts 引用、不出 chunk）——worker 产物平铺 dist 根，
// 供 T3 workerEntryUrl shim 探测（.js 优先 .ts 回退，G4）。
export default defineConfig({
  // entry 对象形态（键=产物名）：数组形态会把 entry 相对 cwd 的目录结构带进输出路径——worker 的
  // ../../packages/... 产物曾逃出 dist 写进 apps/packages/（实测坑），对象键强制平铺 dist 根
  entry: {
    main: "./src/main.ts",
    "imaging-worker": "../../packages/modules/tool-media/src/imaging-worker.ts",
    "media-worker": "../../packages/modules/provider-custom/src/media-worker.ts",
  },
  platform: "node",
  format: "esm",
  outDir: "./dist",
  dts: false,
  clean: true,
  outputOptions: {
    // bin 入口 shebang：tsdown 0.9.9 顶层无 banner 键（doc-review 二轮 A 勘误），rolldown OutputOptions
    // 才有、经 outputOptions 直通。AddonFunction 按 chunk 只给 main 注（worker chunk 不带）
    banner: (chunk) => (chunk.name === "main" ? "#!/usr/bin/env node" : ""),
  },
  noExternal: [/^@orosus\//],
  external: [
    /^jiti(\/|$)/,
    /^zod(\/|$)/,
    /^smol-toml(\/|$)/,
    /^cli-highlight(\/|$)/,
    /^marked(\/|$)/,
    /^jimp(\/|$)/,
    /^@jsquash\/webp(\/|$)/,
    /^wasm-feature-detect(\/|$)/,
    /^@modelcontextprotocol\/sdk(\/|$)/,
    /^turndown(\/|$)/,
    /^turndown-plugin-gfm(\/|$)/,
  ],
});
