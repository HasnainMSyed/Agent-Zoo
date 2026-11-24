/// <reference types="vite/client" />
import type { AgentsApi } from "../../preload/index";
import type { DetailedHTMLProps, HTMLAttributes } from "react";

declare global {
  interface Window { agents: AgentsApi }
}

// Electron's <webview> tag (the Browser pane).
declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & { src?: string; partition?: string; allowpopups?: string };
    }
  }
}
