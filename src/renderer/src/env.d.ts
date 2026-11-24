/// <reference types="vite/client" />
import type { AgentsApi } from "../../preload/index";

declare global {
  interface Window { agents: AgentsApi }
}
