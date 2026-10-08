type Attrs = Record<string, string | boolean | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: Array<Node | string | null | undefined | false> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key === "class") node.className = String(value);
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(child));
  }
  return node;
}

export function clear(node: HTMLElement): void {
  node.replaceChildren();
}

export function appendHighlighted(
  parent: HTMLElement,
  text: string,
  ranges: Array<[number, number]>,
  onMark?: (mark: HTMLElement, rangeIndex: number) => void,
): void {
  if (ranges.length === 0) {
    parent.textContent = text;
    return;
  }
  let cursor = 0;
  ranges.forEach((range, rangeIndex) => {
    const start = Math.max(cursor, Math.min(range[0], text.length));
    const end = Math.max(start, Math.min(range[1], text.length));
    if (start > cursor) parent.append(text.slice(cursor, start));
    const mark = document.createElement("mark");
    mark.textContent = text.slice(start, end);
    onMark?.(mark, rangeIndex);
    parent.append(mark);
    cursor = end;
  });
  if (cursor < text.length) parent.append(text.slice(cursor));
}

export async function copyText(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    return;
  } catch {
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.left = "-9999px";
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    if (!ok) throw new Error("copy failed");
  }
}

export function formatMegabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}
