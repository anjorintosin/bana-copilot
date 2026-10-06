import { parseLadder } from "@meeting-copilot/types";

export function prettyKind(kind: string) {
  const labels: Record<string, string> = {
    coding: "Coding",
    system_design: "System design",
    behavioral: "Behavioral",
    motivation: "Background",
    technical: "Technical",
    product: "Product",
    metrics: "Metrics",
    case: "Case",
    finance: "Finance",
    sales: "Sales",
    design: "Design",
    general: "Interview",
    code: "On screen",
  };
  return labels[kind] ?? "Interview";
}

export function escapeHtml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const TEX_SYMBOLS: Record<string, string> = {
  le: "≤",
  leq: "≤",
  ge: "≥",
  geq: "≥",
  ne: "≠",
  neq: "≠",
  cdot: "·",
  times: "×",
  to: "→",
  rightarrow: "→",
  infty: "∞",
  sum: "Σ",
  in: "∈",
  approx: "≈",
};

const SUPERSCRIPT: Record<string, string> = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", n: "ⁿ", k: "ᵏ",
};

/** Small subset of TeX that models emit inline ($$O(n\log^2 n)$$); not a full renderer. */
export function texToText(tex: string) {
  return tex
    .replace(/\\(?:text|mathrm|operatorname)\{([^}]*)\}/g, "$1")
    .replace(/\\(log|ln|max|min|lim)\b/g, " $1")
    .replace(/\\([a-zA-Z]+)/g, (raw, name: string) => TEX_SYMBOLS[name] ?? raw)
    .replace(/\^\{([^}]+)\}|\^([0-9nk])/g, (raw, group?: string, single?: string) => {
      const chars = (group ?? single ?? "").split("");
      return chars.every((c) => SUPERSCRIPT[c]) ? chars.map((c) => SUPERSCRIPT[c]).join("") : raw;
    })
    .replace(/[{}]/g, "")
    .replace(/\\,|\\;|\\ /g, " ")
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .trim();
}

/** `2*26*26`, `L * S * 26` → `2×26×26`, `L × S × 26`; leaves `**bold**`, `*italic*`, and `code` alone. */
export function timesSigns(text: string) {
  return text
    .split(/(`[^`]*`)/)
    .map((part, i) =>
      i % 2 ? part : part.replace(/([\w)\]²³])( ?)\*\2(?=[\w(\[])/g, (_m, lead: string, gap: string) => `${lead}${gap}×${gap}`),
    )
    .join("");
}

function renderInline(text: string) {
  const math: string[] = [];
  const stash = (tex: string) => {
    math.push(texToText(tex));
    return `\u0000${math.length - 1}\u0000`;
  };
  const withMath = timesSigns(text)
    .replace(/\$\$([^$]+)\$\$/g, (_m, tex: string) => stash(tex))
    .replace(/\\\((.+?)\\\)/g, (_m, tex: string) => stash(tex))
    .replace(/(^|[^\w$])\$(?!\s)([^$\n]*?[a-zA-Z\\^][^$\n]*?)(?<!\s)\$(?!\w)/g, (_m, lead: string, tex: string) => `${lead}${stash(tex)}`);
  return escapeHtml(withMath)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\u0000(\d+)\u0000/g, (_m, i: string) => `<span class="math">${escapeHtml(math[Number(i)] ?? "")}</span>`);
}

function renderProse(text: string) {
  const lines = text.replace(/\r/g, "").split("\n");
  let html = "";
  let list: "ul" | "ol" | "" = "";
  const closeList = () => {
    if (list) html += list === "ul" ? "</ul>" : "</ol>";
    list = "";
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || /^[-*]{3,}$/.test(line)) {
      closeList();
      continue;
    }
    const heading = line.match(/^#{1,4}\s+(.+)$/);
    const boldTitle = line.match(/^\*\*([^*]+)\*\*:?$/);
    if (heading || boldTitle) {
      closeList();
      html += `<p class="ans-h">${renderInline((heading?.[1] ?? boldTitle?.[1] ?? "").replace(/:$/, ""))}</p>`;
      continue;
    }
    const bullet = line.match(/^[-*•]\s+(.+)$/);
    if (bullet) {
      if (list !== "ul") {
        closeList();
        html += `<ul class="ans-list">`;
        list = "ul";
      }
      html += `<li>${renderInline(bullet[1])}</li>`;
      continue;
    }
    const numbered = line.match(/^(\d+)[.)]\s+(.+)$/);
    if (numbered) {
      if (list !== "ol") {
        closeList();
        html += `<ol class="ans-list">`;
        list = "ol";
      }
      html += `<li><span class="ans-num">${numbered[1]}.</span> ${renderInline(numbered[2])}</li>`;
      continue;
    }
    closeList();
    html += `<p>${renderInline(line)}</p>`;
  }
  closeList();
  return html;
}

function renderCode(code: string, lang = "") {
  const label = lang || "code";
  return `<div class="code-block"><div class="code-head"><span>${escapeHtml(label)}</span><button type="button" class="copy-btn">Copy</button></div><pre><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre></div>`;
}

export function splitGist(text: string) {
  const ladder = parseLadder(text);
  const body = [ladder.say, ladder.push, ladder.trap].filter(Boolean).join("\n\n");
  return { gist: ladder.gist, body: body || text };
}

function renderBody(source: string) {
  if (!source.trim()) return "";
  const parts: { type: "code" | "prose"; lang?: string; text: string }[] = [];
  const fence = /```([a-zA-Z0-9_+-]*)\r?\n?([\s\S]*?)```/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(source))) {
    if (match.index > last) {
      parts.push({ type: "prose", text: source.slice(last, match.index) });
    }
    parts.push({
      type: "code",
      lang: match[1] || "code",
      text: match[2],
    });
    last = match.index + match[0].length;
  }
  let rest = source.slice(last);
  const open = rest.indexOf("```");
  if (open >= 0) {
    if (open > 0) parts.push({ type: "prose", text: rest.slice(0, open) });
    const after = rest.slice(open + 3);
    const nl = after.indexOf("\n");
    const maybeLang = (nl >= 0 ? after.slice(0, nl) : after).trim();
    const hasLang = /^[a-zA-Z0-9_+-]+$/.test(maybeLang);
    parts.push({
      type: "code",
      lang: hasLang ? maybeLang : "code",
      text: hasLang && nl >= 0 ? after.slice(nl + 1) : after,
    });
    rest = "";
  }
  if (rest) parts.push({ type: "prose", text: rest });

  let html = "";
  for (const part of parts) {
    if (part.type === "code") html += renderCode(part.text, part.lang);
    else html += renderProse(part.text);
  }
  return html;
}

function isTitleGist(gist: string) {
  const t = gist.trim();
  if (!t) return true;
  if (/^(hello|helo|hi|hey|thanks|ok|okay)\b/i.test(t)) return true;
  if (/^(understanding|explaining|overview|introduction|what is)\b/i.test(t)) return true;
  return false;
}

function spokenText(text: string) {
  const ladder = parseLadder(text);
  const parts = [
    ladder.gist && !isTitleGist(ladder.gist) ? ladder.gist : "",
    ladder.say,
    ladder.push,
  ].filter(Boolean);
  return parts.join("\n\n") || text;
}

export function formatAnswer(text: string) {
  return renderBody(spokenText(text)) || escapeHtml(text);
}

/** Clipboard text: keeps line breaks and list numbers, drops markdown marks, turns TeX into plain math. */
export function answerPlainText(text: string) {
  let inFence = false;
  return spokenText(text)
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return timesSigns(line)
        .replace(/\$\$([^$]+)\$\$/g, (_m, tex: string) => texToText(tex))
        .replace(/\\\((.+?)\\\)/g, (_m, tex: string) => texToText(tex))
        .replace(/^#{1,4}\s+/, "")
        .replace(/\*\*(.+?)\*\*/g, "$1")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/^(\s*)[*•]\s+/, "$1- ");
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
