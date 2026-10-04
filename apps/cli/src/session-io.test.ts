import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@orosus/core";
import { inputHistoryTexts, INPUT_ECHO_EVENT } from "./session-io.ts";

/** 事件桩（inputHistoryTexts 只读 type/content/messages/text/sourceModule——其余字段桩值即可） */
const ev = (type: string, fields: Record<string, unknown> = {}): SessionEvent =>
  ({ v: 1, id: "e", parentId: null, seq: 0, ts: "", type, ...fields }) as SessionEvent;
const userMsg = (text: string): SessionEvent => ev("user/message", { content: [{ kind: "text", text }] });
const echoEv = (text: string): SessionEvent => ev(INPUT_ECHO_EVENT, { text });

/** 与 skills-ui skillInjectText 同构的合成体（2026-09-30 前的菜单 Enter 形态：无原话行） */
const LEGACY_MENU = (name: string, body: string): string =>
  `（用户通过菜单手动加载技能 "${name}"——请按该技能正文行事）\n<skill name="${name}">\n${body}\n</skill>`;

describe("输入历史播种 inputHistoryTexts（2026-10-03 拍板「↑ 召回 = 我输入的内容」——重开会话后技能正文整条被召回的读侧收口）", () => {

  it("① 普通消息与 steer 原文照收；host/date 系统行不进召回（2026-09-28 口径延续）", () => {
    const texts = inputHistoryTexts([
      userMsg("你好"),
      ev("agent/steering-message", { messages: [{ text: "追一句" }, { text: "系统提醒：今天是 2026-10-03。", sourceModule: "host/date" }] }),
    ]);
    expect(texts).toEqual(["你好", "追一句"]);
  });

  it("①b 钩子注入行不进召回（m5-hooks T2：host/hook 源与 host/date 同款跳过——↑ 召回 = 我输入的内容，注入不重放）", () => {
    const texts = inputHistoryTexts([
      userMsg("你好"),
      ev("agent/steering-message", { messages: [{ text: "[非用户输入] 钩子注入：项目知识。", sourceModule: "host/hook" }] }),
    ]);
    expect(texts).toEqual(["你好"]);
  });

  it("② 老会话技能合成体（旁注机制之前落盘、无 echo）：只召回原话行——标记行与 <skill> 正文不进召回（本 bug 主案）", () => {
    const texts = inputHistoryTexts([
      userMsg(`（用户通过菜单手动加载技能 "doc-review"——请按该技能正文行事）\n/skill : doc-review 2026-09-30-m5-media.md 全量\n<skill name="doc-review" args="2026-09-30-m5-media.md 全量">\n# 技能正文一大堆\n不该被召回\n</skill>`),
    ]);
    expect(texts).toEqual(["/skill : doc-review 2026-09-30-m5-media.md 全量"]);
  });

  it("③ 老菜单形态（2026-09-30 前：标记行后直接 <skill、无原话行）：无可召回内容，跳过不 push", () => {
    expect(inputHistoryTexts([userMsg(LEGACY_MENU("pdf", "正文"))])).toEqual([]);
  });

  it("④ 新会话旁注优先：@ 展开体的 user/message 紧随 host/input-echo → 召回输入框原文（展开体与附件不进召回）", () => {
    const texts = inputHistoryTexts([
      userMsg("看看\n\n[@a.txt]\n内容甲"),
      echoEv("看看 @a.txt"),
    ]);
    expect(texts).toEqual(["看看 @a.txt"]);
  });

  it("⑤ 旁注与转述旁注共存（数组序落盘）：扫描越过 host/vision-transcribe 取到 echo，chip 剥除后召回", () => {
    const texts = inputHistoryTexts([
      userMsg("看图"),
      ev("host/vision-transcribe", { model: "m", ok: true, text: "蓝色按钮" }),
      echoEv("看图 [image #2]"),
      ev("request/header", {}),
    ]);
    expect(texts).toEqual(["看图"]);
  });

  it("⑥ 图片 chip token 剥除（消息与旁注两路同口径）；剥后为空不 push", () => {
    expect(inputHistoryTexts([userMsg("看 [image #3]")])).toEqual(["看"]);
    expect(inputHistoryTexts([userMsg("[image #3]")])).toEqual([]);
    expect(inputHistoryTexts([userMsg("[image #3]（旁注路径同剥）"), echoEv("[image #4]"), ev("turn/start", {})])).toEqual([]);
  });
});
