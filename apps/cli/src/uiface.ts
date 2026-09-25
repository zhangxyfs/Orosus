/** CLI 命令交互面装配（m5 T2 起）：readline 基座（menu.ts）+ 全屏 FullApp 适配层。
 *  独立成件（不在 main.ts 顶层脚本里）是为了装配行为可测——viewtext.test.ts 的「装配层接线测试」
 *  直接吃本件（main.ts 是顶层脚本，import 即跑 CLI，测试进不去）。
 *  行模式降级语义：viewText 落 console 多行（内容承载不丢弃）；insertText/attachImage 等注入口
 *  静默丢弃（决策点 9——行模式无文内 chip 机制）。 */

import type { CommandUi, PopupKey, PopupLayout } from "@orosus/contracts/module";
import { createReadlineUi } from "./menu.ts";

/** 装配层需要的 FullApp 最小面（结构类型兼容——FullApp 实例直接可传）。 */
export interface FullAppFace {
  viewText(title: string, text: string, opts?: { layout?: PopupLayout; keys?: Record<string, PopupKey>; owner?: string }): void;
  insertAtCursor(text: string): void;
  showToast(text: string): void;
}

export interface CliUiDeps {
  question(q: string): Promise<string>;
  secretQuestion(q: string): Promise<string>;
  pick?(title: string, items: string[]): Promise<number>;
  notice?(text: string, opts?: { durationMs?: number }): void;
  /** 当前全屏应用；undefined = 行模式。调用期现读——activeApp 的生命周期晚于本对象。 */
  activeApp(): FullAppFace | undefined;
  /** 全屏期贴图链路（宿主图片注册表 + chip token 生成）；路径校验归宿主（不存在 → toast）。 */
  attachImage?(app: FullAppFace, path: string): void;
}

export function createCliUi(deps: CliUiDeps): CommandUi {
  return {
    ...createReadlineUi({
      question: deps.question,
      secretQuestion: deps.secretQuestion,
      ...(deps.pick !== undefined ? { pick: deps.pick } : {}),
      ...(deps.notice !== undefined ? { notice: deps.notice } : {}),
    }),
    viewText: (title, text, opts) => {
      const app = deps.activeApp();
      if (app === undefined) {
        // 行模式降级：无弹窗可弹，标题 + 逐行落 console（内容承载不丢弃）
        console.log(`== ${title} ==`);
        for (const l of text.split("\n")) console.log(l);
        return;
      }
      app.viewText(title, text, opts);
    },
    // 注入两法（m5 T4）：活 getter——行模式/无全屏期读出来是 undefined（决策点 9 静默丢弃 = 缺省不存在，
    // 模块判空降级）；getter 语义要求消费侧不得展开拍平（kernel ownerTagUi 已用描述符保真拷贝）。
    get insertText(): CommandUi["insertText"] {
      const app = deps.activeApp();
      return app === undefined ? undefined : (text: string) => app.insertAtCursor(text);
    },
    get attachImage(): CommandUi["attachImage"] {
      const app = deps.activeApp();
      if (app === undefined || deps.attachImage === undefined) return undefined;
      return (path: string) => deps.attachImage!(app, path);
    },
  };
}
