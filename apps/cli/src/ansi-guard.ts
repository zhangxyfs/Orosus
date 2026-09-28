/**
 * 外部文字的危险转义序列净化（CR-01，2026-09-28 用户拍板「只堵危险子集」）。
 *
 * 背景：终端控制码（ANSI 转义序列）里，颜色/样式（SGR，`Esc[…m`）无害且常见（ls --color 等），
 * 但光标移动/清屏/OSC 指令（改终端标题、OSC 52 写剪贴板、OSC 8 伪装链接）能让外部文字
 * （模型正文、工具输出）在用户终端里「执行命令」——搅乱画面、伪造提示行、偷剪贴板。
 *
 * 策略：入口净化——模型正文/工具参数/工具结果/历史回显/错误文案进显示管线前，剥掉一切
 * ESC 序列中**非 SGR** 的成员（CSI 光标类、OSC、DCS/APC/PM、两字符 ESC 序列、未闭合截断形），
 * 再清掉残散 C0 控制字符（保留 \n \r \t）；SGR 颜色码原样保留。渲染管线自产 ANSI 不受影响
 * （本函数只喂外部来源）。会话文件仍存原文（审计源），净化只发生在显示层。
 */
// 一切 ESC 起始序列：CSI（Esc[ 参数 中间字节 final）、OSC（Esc] … BEL/ST，终止符可缺=截断形）、
// DCS（EscP … ST）、其余 ESC 序列（Esc + 中间字节* + final——含 Esc7/8 存取光标、EscM 反卷、Escc 复位）；
// 末位负向前瞻 = 孤儿 ESC（后面不是任何序列引导符的裸 ESC / 被拆包的残头——只剥 ESC 本身，余文无害）
// eslint-disable-next-line no-control-regex -- 本文件的职能就是识别控制序列（\x1b/\x07 是匹配对象本身）——仓内终端断言同款豁免
const ESC_SEQ = /\x1b(?:\[[0-9;:<=>?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|P[\x20-\x7e]*\x1b\\|[ -/]*[0-~]|(?![\\[\]PX^_]))/g;
// SGR 判定（保留面）：Esc[…m——参数与中间字节与 CSI 同形、final 恒为 m
// eslint-disable-next-line no-control-regex -- 同上：识别对象是控制序列本身
const SGR = /^\x1b\[[0-9;:<=>?]*[ -/]*m$/;
// 残散 C0 + DEL：序列剥完后还留下的控制字符（含被拆包的孤儿 BEL）——保留 \t \n \r 与 ESC
//（ESC 已由上一遍处理：合法序列整体决策、孤儿 ESC 单剥——这里再剥会误杀保留的 SGR 序列头）
// eslint-disable-next-line no-control-regex -- 同上：识别对象是控制字符本身
const STRAY_CTRL = /[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g;

export function stripDangerEsc(s: string): string {
  return s
    .replace(ESC_SEQ, (seq) => (SGR.test(seq) ? seq : ""))
    .replace(STRAY_CTRL, "");
}
