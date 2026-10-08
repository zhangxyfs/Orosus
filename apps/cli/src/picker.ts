import type { KeyEvent } from "./keys.ts";
import { moveUp, clearLine, reverse, dispLines } from "./ansi.ts";
import { fg, dim } from "./theme.ts";
import { ESC_CANCELLED } from "./i18n/protocol-strings.ts";
import { t } from "./i18n/app.ts";

/** 尾部完整括注组定位（两段式拆分③）：串尾（忽略尾随空白）是 `（…）`/`(…)` 整组时返回
 *  { coreStart }——组前还有内容才算两段（整项即括号组不算）。只认同类配对（全角配全角）。 */
function trailingParenStart(s: string): number | undefined {
	const t = s.replace(/[ \t]+$/, "");
	const close = t.endsWith("）") ? "）" : t.endsWith(")") ? ")" : undefined;
	if (close === undefined) return undefined;
	const open = close === "）" ? "（" : "(";
	let depth = 0;
	for (let i = t.length - 1; i >= 0; i--) {
		const ch = t[i]!;
		if (ch === close) depth++;
		else if (ch === open) {
			depth--;
			if (depth === 0) return i > 0 ? i : undefined; // i=0 → 整项即括号组
		}
	}
	return undefined;
}

/** choose/pick 列表项两段式渲染（2026-09-28 用户拍板：子界面与斜杠主菜单同形——标题白、副题/说明灰）。
 *  拆分三形态（只翻译样式、可见字符不增删）：
 *  ① 多行项首行 = 标题、其余折单行为说明（/provider「名称\n（URL）」——2026-09-24 压平前案的形态升级）；
 *  ② 首个「——」后为说明（审批三档/搜索后端「标题——说明」形态）———— 落在尾部括注组内则让位③
 *    （设置菜单「技能（查看 / 启停——…）」的 —— 本就是说明的一部分）；
 *  ③ 尾部完整括注组（…）/（…）为说明（「标题（说明）」形态——设置菜单/厂商目录/数据源）。
 *  「 ✓」当前值尾标保持 2026-09-25 拍板：纯标题项整项青玉；带说明项 = 标题青玉 + 说明灰 + 尾标青玉。
 *  已含 ANSI 的行原样返回（调用方自拼样式的行——技能列表/任务列表）；纯标题项原样返回。 */
export function pickLabel(raw: string, opts?: { current?: boolean }): string {
	if (raw.includes("\x1b[")) return raw;
	const cm = /^(.*?)[ \t]*✓[ \t]*$/.exec(raw);
	const cur = opts?.current === true || cm !== null;
	const core = cm?.[1] ?? raw;
	// 形态拆分（在去掉 ✓ 尾标的核心上找——尾标不属于标题也不属于说明）
	let title = "";
	let desc = "";
	let spaced = false; // true = 标题与说明间补一个空格（主菜单「label ——desc」同形）；括注直贴不补
	const nl = core.indexOf("\n");
	if (nl >= 0) {
		title = core.slice(0, nl).trimEnd();
		desc = core.slice(nl + 1).replace(/\s*\n\s*/g, " ").trim();
		spaced = true;
	} else {
		const ps = trailingParenStart(core);
		const di = core.indexOf("——");
		if (di > 0 && (ps === undefined || di < ps)) {
			title = core.slice(0, di).trimEnd();
			desc = core.slice(di).trimStart();
			spaced = true;
		} else if (ps !== undefined && core.slice(0, ps).trim() !== "") {
			title = core.slice(0, ps); // 括注直贴：保留标题尾的原有空格（折平项「名 （URL）」不丢字距）
			desc = core.slice(ps).trimStart();
		} else {
			title = core;
		}
	}
	if (desc === "") {
		// 纯标题项：✓ 尾标只在串里本来就有时还原（控件窗选中行 current 不发明数据里没有的尾标）
		if (cm === null) return cur ? fg("accent", core) : raw;
		return cur ? fg("accent", `${core} ✓`) : raw;
	}
	const titleSeg = cur ? fg("accent", title) : title;
	const markSeg = cm !== null ? ` ${fg("accent", "✓")}` : "";
	return `${titleSeg}${spaced ? " " : ""}${dim(desc)}${markSeg}`;
}

/** 视口计算（TUI 批 T2/B5 厂商目录分页）——纯函数：窗口由选中项派生（选中项置底边滚入、
 *  首部贴顶、尾部贴底），pick 渲染每帧经它取 [start, end)；PageUp/PageDown 把选中项
 *  ±height 后窗口随之滚动。height ≥ count 时恒整窗（{0, count}）。 */
export function viewportOf(count: number, selected: number, height: number): { start: number; end: number } {
  const h = Math.max(1, Math.min(height, Math.max(count, 1)));
  const start = Math.min(Math.max(0, selected - h + 1), Math.max(0, count - h));
  return { start, end: Math.min(count, start + h) };
}

/** 键盘菜单（TUI 批 T1/B5 第 2 层）——上下键反色高亮、回车确认、Esc 取消（reject 表达，
 *  menu.ts 侧映射为机制③统一文案）、≤9 项数字直达（设计空白：>9 项数字键让位导航）。
 *  T2 起支持滚动视口：io.height 注入且项数超窗时只画 [start, end) + 顶部范围提示行
 *  （…（第 X–Y 项，共 N 项）——帧高恒定，重绘算术不漂移），PageUp/PageDown 整屏翻页。
 *  非 TTY 回落现状编号读序号（脚本/CI 消费方零破坏，退化矩阵登记）。
 *  空表显式拒绝「无可选项」（CR-05：回车返回 0/环绕 NaN 都是伪装合法下标——items[NaN] 落给
 *  调用方是 undefined；非 TTY 编号回落 `n <= 0` 永假无限重问挂死脚本/CI）。
 *  重绘 = 「上移 N 行 + 逐行清行 + 重写」——T4 起序列常量走 ansi.ts 公共件
 *  （moveUp/clearLine/reverse——字节形态不变，测试零改动）；N 按视觉行数（CR-06：CJK 双宽
 *  折行后逻辑行数 ≠ 视觉行数，按 lines.length 少移即错位残影——ansi.ts 头注硬约定）。
 *  列宽经 io.columns 注入；缺省读真终端 process.stdout.columns（每帧现读，resize 即生效），
 *  再缺省 80（非 TTY/哑终端/测试面）——宿主接线不改造也能拿到正确口径。
 *  m5-ask-multi：第 3 参 opts 传入 = chooseEx 增强面（kimi 键路同款——「✎ 其他」行恒在、multi
 *  再加「✓ 确定」尾行 D16），返回形状变为 { picked: number[]; custom?: string } | undefined
 *  （picked = 勾选项原始下标集、custom = 自定义已结算文本〔恰一条〕、undefined = Esc）；
 *  无 opts = 现状签名 Promise<number | undefined> 一字不动（/sessions 等 33 处消费面零破坏）。
 *  非 TTY 回落（D13）：单选收序号或非数字文本（=自定义答案）；多选收逗号分隔（序号/文本混排）。 */
export function pick(items: string[], io: {
    isTTY: boolean;
    height?: number;
    /** 终端列宽（CR-06 视觉行数口径的折行宽度）；缺省 process.stdout.columns ?? 80 */
    columns?: number;
    runModal<T>(fn: (readKey: () => Promise<KeyEvent>) => Promise<T>): Promise<T>;
    write(s: string): void;
    numberQuestion(q: string): Promise<string>; // 非 TTY 回落路径（现状编号版）
  }, opts: { multi?: boolean }): Promise<{ picked: number[]; custom?: string } | undefined>;
export function pick(items: string[], io: {
    isTTY: boolean;
    height?: number;
    /** 终端列宽（CR-06 视觉行数口径的折行宽度）；缺省 process.stdout.columns ?? 80 */
    columns?: number;
    runModal<T>(fn: (readKey: () => Promise<KeyEvent>) => Promise<T>): Promise<T>;
    write(s: string): void;
    numberQuestion(q: string): Promise<string>; // 非 TTY 回落路径（现状编号版）
  }): Promise<number | undefined>;
export function pick(items: string[], io: {
    isTTY: boolean;
    height?: number;
    /** 终端列宽（CR-06 视觉行数口径的折行宽度）；缺省 process.stdout.columns ?? 80 */
    columns?: number;
    runModal<T>(fn: (readKey: () => Promise<KeyEvent>) => Promise<T>): Promise<T>;
    write(s: string): void;
    numberQuestion(q: string): Promise<string>; // 非 TTY 回落路径（现状编号版）
  }, opts?: { multi?: boolean }): Promise<number | undefined | { picked: number[]; custom?: string } | undefined> {
  // CR-05：空表入口即拒（TTY/非 TTY 两路同断）——伪装合法下标与死循环都在身后绝路
  if (items.length === 0) return Promise.reject(new Error(t("menu.err.noItems")));
  const multi = opts?.multi === true;
  if (!io.isTTY) {
    return (async () => {
      for (;;) {
        const raw = (await io.numberQuestion(t("menu.choose.ask"))).trim();
        if (opts === undefined) {
          const n = Number(raw);
          if (Number.isInteger(n) && n >= 1 && n <= items.length) return n - 1;
          continue;
        }
        if (!multi) {
          // D13 单选：序号即选项；非数字文本 = 自定义答案（「其他」等价口）；空——再问
          const n = Number(raw);
          if (Number.isInteger(n) && n >= 1 && n <= items.length) return { picked: [n - 1] };
          if (raw !== "") return { picked: [], custom: raw };
          continue;
        }
        // D13 多选：逗号分隔（中英逗号都可）、序号/文本混排；空——再问。多条文本并作单槽
        // custom（D3——UI 单槽同纪律，文本段以「，」接回）
        if (raw === "") continue;
        const picked: number[] = [];
        const texts: string[] = [];
        for (const part of raw.split(/[,，]/)) {
          const p = part.trim();
          if (p === "") continue;
          const n = Number(p);
          if (Number.isInteger(n) && n >= 1 && n <= items.length) picked.push(n - 1);
          else texts.push(p);
        }
        if (picked.length === 0 && texts.length === 0) continue;
        return { picked: [...new Set(picked)], ...(texts.length > 0 ? { custom: texts.join("，") } : {}) };
      }
    })();
  }
  return io.runModal(async (readKey) => {
    let selected = 0;
    // m5-ask-multi 增强面状态（opts 面专用——老面不触达）；走查修：单选 checked 恒 ≤1 元素=圆圈位
    const checked: number[] = [];
    let customText = ""; // 输入态草稿（Esc 回列表保留——kimi otherDrafts 同款）
    let customCommitted: string | undefined; // 单槽（D3）；单选=圆圈落到其他行
    let editing = false;
    let flash = ""; // 行模式「toast」：零选确定行 Enter 换帧闪现一拍（帧高不变——重绘算术安全）
    // 行域 = 项 + 其他 + 确定（走查修后单选/多选同构恒两合成行）——「其他」恒占 items.length、
    // 「确定」恒占 +1；老面（无 opts）无合成行
    const rowsTotal = opts === undefined ? items.length : items.length + 2;
    // 视口仅在注入 height 且项数超窗时激活——否则整列渲染（T1 行为原样；增强面按行域计）
    const vpHeight = io.height !== undefined && io.height > 0 && rowsTotal > io.height ? io.height : undefined;
    // 标记字形（走查修 2026-10-08）：多选 ☐/accent■（☑ 观感大一圈被否）、单选 ○/accent●；
    // 已标记项文字同染 accent（pickLabel current 口——标题青玉、说明仍灰）
    const markOf = (on: boolean): string => (on ? fg("accent", multi ? "■" : "●") : multi ? "☐" : "○");
    const radioSelect = (i: number): void => {
      if (checked.length === 1 && checked[0] === i) { checked.length = 0; return; } // 再按同项=取消（撤回）
      checked.length = 0;
      checked.push(i); // 圆圈移位（唯一性）——选普通项即移出自定义
      customCommitted = undefined;
    };
    const rowLabel = (i: number): string => {
      if (opts === undefined) return pickLabel(items[i]!); // 老面：零前缀零标记——渲染逐字节原样
      if (i === items.length) { // 其他行（✎ 自有——三家 Other 行都无图标）
        const committed = customCommitted;
        return `${markOf(committed !== undefined)} ✎ ${committed !== undefined ? fg("accent", committed) : t("pick.other.label")}`;
      }
      if (i === items.length + 1) return `✓ ${t("pick.multi.confirm")}`; // D16 提交口
      const on = checked.includes(i);
      return `${markOf(on)} ${pickLabel(items[i]!, { current: on })}`;
    };
    // 底部提示行文案按可用能力动态拼装（设计空白——防 >9 项/视口态提示撒谎）
    const hint = t("pick.line.foot"); // m5-i18n T6：脚注整句走键（分能力动态拼装走查后再拆）
    const frameLines = (): string[] => {
      const win = vpHeight === undefined ? { start: 0, end: rowsTotal } : viewportOf(rowsTotal, selected, vpHeight);
      const lines: string[] = [];
      if (vpHeight !== undefined) lines.push(t("pick.line.range", { n: `${win.start + 1}–${win.end}`, m: rowsTotal }));
      for (let i = win.start; i < win.end; i++) {
        lines.push(i === selected ? reverse(rowLabel(i)) : rowLabel(i));
      }
      if (editing) lines.push(`${t("pick.custom.input")}${customText}`); // 输入态：提示行上插自行输入行
      lines.push(flash !== "" ? flash : editing ? t("pick.custom.foot") : opts !== undefined ? t("pick.line.multiFoot") : hint);
      return lines;
    };
    let drawn = 0; // 上一帧的视觉行数（moveUp 的唯一口径）
    const render = (): void => {
      const lines = frameLines();
      // CR-06：视觉行数口径（ansi.ts 头注硬约定）——CJK 双宽使超宽逻辑行折成多个物理行，
      // 按 lines.length 上移会少移 → 重绘错位 + 折行残影。dispLines 剥 ANSI 后按列宽折算
      const rows = dispLines(lines.join("\n"), io.columns ?? process.stdout.columns ?? 80);
      if (drawn > 0) io.write(moveUp(drawn));
      for (const l of lines) io.write(`${clearLine}${l}\n`);
      drawn = rows;
    };
    render();
    for (;;) {
      const k = await readKey();
      flash = ""; // 闪现一拍即清
      if (editing) {
        // 输入态自收（keys.ts readKey——Esc 歧义已在解析器 30ms 窗口解决，此处只收完整事件）
        if (k.type === "esc") editing = false; // 返回列表非取消整窗（草稿保留）
        else if (k.type === "enter") {
          const v = customText.trim();
          if (v !== "") {
            customCommitted = v; // 单槽覆盖（D3）/单选圆圈移到其他行
            if (!multi) checked.length = 0; // 圆圈唯一——自定义入选即移出普通项
            editing = false; // 走查修：单选输入 Enter 回列表不再即答——确定行统一提交（撤回）
          } // 空输入 Enter 无效（kimi :344——不丢已输内容）
        } else if (k.type === "char") customText += k.ch;
        else if (k.type === "paste") customText += k.text.replace(/\s*\n\s*/g, " "); // 粘贴整段并入（换行压平）
        else if (k.type === "backspace") {
          const cp = customText.codePointAt(customText.length - 1) ?? 0;
          customText = customText.slice(0, customText.length - (cp > 0xffff ? 2 : 1)); // CTU-10 同款整对删代理对
        }
        render();
        continue;
      }
      if (k.type === "esc") throw new Error(ESC_CANCELLED);
      if (k.type === "enter") {
        if (opts === undefined) return selected;
        if (selected < items.length) {
          if (multi) { // 普通项 Enter = 方框勾选（cc SelectMulti「Enter toggles selection」同款）
            const at = checked.indexOf(selected);
            if (at >= 0) checked.splice(at, 1); else checked.push(selected);
          } else {
            radioSelect(selected); // 走查修：圆圈选定（再按取消、选他项移位）——不即答
          }
          render();
          continue;
        }
        if (selected === items.length) { // 其他行
          if (customCommitted !== undefined) { customCommitted = undefined; render(); continue; } // 对称撤销（kimi :301-307——走查修后两态共用）
          editing = true;
          render();
          continue;
        }
        // 确定行：零选 toast 不关窗（D5——行模式无浮动 toast，闪现提示行一拍）；走查修后单选多选统一
        if (checked.length === 0 && customCommitted === undefined) flash = t("pick.multi.emptyToast");
        else return { picked: [...checked], ...(customCommitted !== undefined ? { custom: customCommitted } : {}) };
        render();
        continue;
      }
      // D7 + 走查修：空格标记、光标不动（仅普通项——合成行无效）；multi 数字直达让位（防误触）
      if (opts !== undefined && k.type === "char" && k.ch === " ") {
        if (selected < items.length) {
          if (multi) {
            const at = checked.indexOf(selected);
            if (at >= 0) checked.splice(at, 1); else checked.push(selected);
          } else {
            radioSelect(selected);
          }
        }
        render();
        continue;
      }
      if (k.type === "arrow" && k.dir === "up") selected = (selected - 1 + rowsTotal) % rowsTotal;
      else if (k.type === "arrow" && k.dir === "down") selected = (selected + 1) % rowsTotal;
      else if (k.type === "page" && k.dir === "up") selected = Math.max(0, selected - (vpHeight ?? rowsTotal));
      else if (k.type === "page" && k.dir === "down") selected = Math.min(rowsTotal - 1, selected + (vpHeight ?? rowsTotal));
      else if (!multi && k.type === "char" && items.length <= 9 && /^[1-9]$/.test(k.ch)) {
        // 数字直达：老面照旧即答；ex 单选=圆圈选定（走查修后不即答）；multi 让位（D7——防误触）
        const n = Number(k.ch);
        if (n <= items.length) {
          if (opts === undefined) return n - 1;
          radioSelect(n - 1);
        }
        render();
        continue; // 超界数字——无状态变化也重绘一帧（与 opts 面其余键路一致）
      } else continue; // 其余按键忽略——不重绘
      render();
    }
  });
}
