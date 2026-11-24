import { memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard refused */ }
  };
  return (
    <div className="codeblock">
      <div className="codeblock-bar"><span>{lang || "text"}</span><button onClick={copy}>{copied ? "Copied" : "Copy"}</button></div>
      <pre><code>{code}</code></pre>
    </div>
  );
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
        pre: ({ children }) => <>{children}</>,
        code({ className, children }) {
          const code = String(children ?? "");
          const lang = /language-(\w+)/.exec(className ?? "")?.[1];
          if (!lang && !code.includes("\n")) return <code className="inline">{code}</code>;
          return <CodeBlock code={code.replace(/\n$/, "")} lang={lang} />;
        },
        a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
      }}>{text}</ReactMarkdown>
    </div>
  );
});
