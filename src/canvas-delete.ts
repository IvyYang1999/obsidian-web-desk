export type DeletableCanvasObjectKind = "card" | "image" | "textbox" | "rating" | "group" | "arrow";

export interface DeletableCanvasObject {
  key: string;
  kind: DeletableCanvasObjectKind;
  id: string;
}

export interface CanvasObjectDeletionPlan {
  cardIds: string[];
  imageIds: string[];
  textBoxIds: string[];
  ratingIds: string[];
  groupIds: string[];
  arrowIds: string[];
}

/**
 * 两种画布共享的 Delete 解释器：只把仍存在的选中引用按对象类型拆分。
 * 实际持久化由各宿主负责，但语义始终是“移出当前画布”，不是删除源文件。
 */
export function planCanvasObjectDeletion(
  objects: DeletableCanvasObject[],
  selected: ReadonlySet<string>,
): CanvasObjectDeletionPlan {
  const plan: CanvasObjectDeletionPlan = {
    cardIds: [],
    imageIds: [],
    textBoxIds: [],
    ratingIds: [],
    groupIds: [],
    arrowIds: [],
  };
  for (const object of objects) {
    if (!selected.has(object.key)) continue;
    if (object.kind === "card") plan.cardIds.push(object.id);
    else if (object.kind === "image") plan.imageIds.push(object.id);
    else if (object.kind === "textbox") plan.textBoxIds.push(object.id);
    else if (object.kind === "rating") plan.ratingIds.push(object.id);
    else if (object.kind === "group") plan.groupIds.push(object.id);
    else plan.arrowIds.push(object.id);
  }
  return plan;
}
