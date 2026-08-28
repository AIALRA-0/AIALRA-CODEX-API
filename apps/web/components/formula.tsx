"use client";

import katex from "katex";

export function Formula({ source, label }: { source: string; label: string }) {
  try {
    const html = katex.renderToString(source, {
      displayMode: true,
      output: "htmlAndMathml",
      strict: "error",
      throwOnError: true,
      trust: false,
    });
    return (
      <div className="formula" aria-label={label} dangerouslySetInnerHTML={{ __html: html }} />
    );
  } catch {
    return (
      <pre className="formula formula-fallback" aria-label={`${label}，公式渲染失败，显示原文`}>
        {source}
      </pre>
    );
  }
}
