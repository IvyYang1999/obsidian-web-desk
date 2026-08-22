export interface EmbedMarkerReplacement {
  content: string;
  marker: string;
  replaced: boolean;
  alreadyCurrent: boolean;
}

/**
 * 用上一次成功写入的内容定位当前代码块。每次成功后把 fresh 作为下一次 marker，
 * 避免同一画布第二次编辑仍拿首次渲染内容查找而静默丢失。
 */
export function replaceEmbedMarker(
  content: string,
  marker: string,
  fresh: string,
): EmbedMarkerReplacement {
  if (!marker) {
    const alreadyCurrent = content.includes(fresh);
    return {
      content,
      marker: alreadyCurrent ? fresh : marker,
      replaced: false,
      alreadyCurrent,
    };
  }
  const index = content.indexOf(marker);
  if (index !== -1) {
    return {
      content: content.slice(0, index) + fresh + content.slice(index + marker.length),
      marker: fresh,
      replaced: true,
      alreadyCurrent: false,
    };
  }
  if (content.includes(fresh)) {
    return { content, marker: fresh, replaced: false, alreadyCurrent: true };
  }
  return { content, marker, replaced: false, alreadyCurrent: false };
}
