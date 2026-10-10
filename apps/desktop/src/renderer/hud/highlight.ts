const squash = (text: string) => text.replace(/\s+/g, " ");

/** Wraps the flagged sentence in the bubble, even when it spans bold or code spans. */
export function markSentence(bubble: Element, sentence: string) {
  bubble.querySelectorAll("mark.msg-risky").forEach((mark) => mark.replaceWith(...mark.childNodes));
  bubble.normalize();
  const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT);
  const nodes: { node: Text; start: number }[] = [];
  let joined = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push({ node: node as Text, start: joined.length });
    joined += node.textContent ?? "";
  }
  let flat = "";
  const rawIndex: number[] = [];
  for (let i = 0; i < joined.length; i += 1) {
    const blank = /\s/.test(joined[i]);
    if (blank && flat.endsWith(" ")) continue;
    flat += blank ? " " : joined[i];
    rawIndex.push(i);
  }
  const target = squash(sentence).trim();
  const found = target ? flat.indexOf(target) : -1;
  if (found < 0) return false;
  const at = rawIndex[found];
  const end = rawIndex[found + target.length - 1] + 1;
  for (const { node, start } of nodes) {
    const text = node.textContent ?? "";
    const from = Math.max(at, start) - start;
    const to = Math.min(end, start + text.length) - start;
    if (to <= from) continue;
    const range = document.createRange();
    range.setStart(node, from);
    range.setEnd(node, to);
    const mark = document.createElement("mark");
    mark.className = "msg-risky";
    range.surroundContents(mark);
  }
  return true;
}
