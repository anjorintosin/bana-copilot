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

function isCodeLine(line: string) {
  const t = line.trim();
  if (!t) return false;
  if (/^```/.test(t)) return true;
  if (/^\s*([{}();[\]]+)$/.test(line)) return true;
  if (/[{};]\s*$/.test(t)) return true;
  if (
    /^\s*(async\s+)?(function|for|if|else|else if|return|const|let|var|while|class|switch|case|break|continue|try|catch|finally|throw|new|await|import|export|def|print\()\b/.test(
      line,
    )
  ) {
    return true;
  }
  return /(?:===|!==|=>|&&|\|\||\+\+|charCount\s*\[|\[\w+\]\s*=)/.test(t);
}

function renderProse(text: string) {
  const lines = text.split(/\n+/);
  let html = "";
  for (const raw of lines) {
    let line = raw.trim();
    if (!line) continue;
    line = line.replace(/^[-*•]\s+/, "").replace(/^\d+[.)]\s+/, "");
    line = line.replace(/\*\*(.+?)\*\*/g, "$1");
    html += `<p>${escapeHtml(line)}</p>`;
  }
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
    parts.push({ type: "code", lang: match[1] || "code", text: match[2] });
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

  if (parts.length === 1 && parts[0].type === "prose") {
    const lines = parts[0].text.split("\n");
    const grouped: { type: "code" | "prose"; text: string }[] = [];
    for (const line of lines) {
      const code = isCodeLine(line);
      const prev = grouped[grouped.length - 1];
      if (code) {
        if (prev?.type === "code") prev.text += `\n${line}`;
        else grouped.push({ type: "code", text: line });
      } else if (!line.trim() && prev?.type === "code") {
        prev.text += "\n";
      } else if (prev?.type === "prose") {
        prev.text += `\n${line}`;
      } else {
        grouped.push({ type: "prose", text: line });
      }
    }
    const codeChars = grouped
      .filter((p) => p.type === "code")
      .reduce((n, p) => n + p.text.length, 0);
    if (codeChars >= 40) {
      parts.length = 0;
      parts.push(
        ...grouped.map((p) =>
          p.type === "code"
            ? { type: "code" as const, lang: "javascript", text: p.text }
            : { type: "prose" as const, text: p.text },
        ),
      );
    }
  }

  let html = "";
  for (const part of parts) {
    if (part.type === "code") html += renderCode(part.text, part.lang);
    else html += renderProse(part.text);
  }
  return html;
}

export function formatAnswer(text: string) {
  const ladder = parseLadder(text);
  const say = ladder.say || (!ladder.push && !ladder.trap && !ladder.gist ? text : "");
  let html = ladder.gist ? `<p class="gist">${escapeHtml(ladder.gist)}</p>` : "";
  html += renderBody(say);
  if (ladder.push) {
    html += `<div class="ladder-push"><p class="ladder-label">If they push</p>${renderBody(ladder.push)}</div>`;
  }
  if (ladder.trap) {
    html += `<p class="ladder-trap">Don't: ${escapeHtml(ladder.trap.replace(/^don't:\s*/i, ""))}</p>`;
  }
  return html || escapeHtml(text);
}
