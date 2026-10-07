export {
	chainFor,
	createT,
	formatTemplate,
	isParamName,
	normalizeLocaleTag,
	pluralCategory,
	resolveMessage,
	type LocaleTag,
	type Messages,
	type TFunction,
	type TInstance,
	type TParamValue,
	type TParams,
} from "./runtime.ts";
export { floorCatalogs, floorEnUS, floorKeys, floorZhCN, floorZhTW } from "./floor.ts";

import { createT } from "./runtime.ts";
import { floorCatalogs } from "./floor.ts";
import type { TFunction } from "./runtime.ts";

/** 地板 t（core/内核自渲染面专用）：只认三语地板目录，缺键 → fallback 参数 → key。 */
export function createFloorT(tag: string): TFunction {
	return createT({ tag, getTable: (t) => floorCatalogs[t] });
}
