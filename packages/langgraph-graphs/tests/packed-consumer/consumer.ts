import type { GuardDeps } from "@cogni/agent-grants";
type ToolSourcePort = InProcProviderDeps["tools"];
import { CORE_TOOL_BUNDLE } from "@cogni/ai-tools";
import {
  type AgentAuthorityPort,
  type CodingCallerPolicy,
  type CompletionUnitPort,
  createLangGraphInProcProvider,
  createNodeCatalog,
  INPROC_EVENTS,
  type InProcProviderDeps,
  type Persistence,
  type ProviderLogger,
  type RunScopePort,
  requiresInProcess,
  resolveNodeSourceContext,
  type SourceContext,
} from "@cogni/langgraph-graphs/inproc";
import { LANGGRAPH_CATALOG } from "@cogni/langgraph-graphs";

type NodeTool = { readonly type: "function"; readonly name: string };
const completion: CompletionUnitPort<NodeTool> = {
  executeCompletionUnit: () => ({
    stream: (async function* () {})(),
    final: Promise.resolve({ ok: true, content: "" }),
  }),
};
const tools: ToolSourcePort = {
  getBoundTool: () => undefined,
  listToolSpecs: () => [],
  hasToolId: () => false,
};
const scope: RunScopePort = {
  current: () => ({ accountId: "a", runAs: (_identity, fn) => fn() }),
};
const guardDeps: Omit<GuardDeps, "runAs"> = {
  withStore: async () => {
    throw new Error("none");
  },
  adminCheck: async () => "unavailable",
};
const authority: AgentAuthorityPort = { resolvePrincipal: async () => null, guardDeps };
const coding: CodingCallerPolicy = { isCodingActor: () => false, prerequisitesReady: () => true };
const log: ProviderLogger = console;
const sourceContext = (required: boolean): Promise<SourceContext> =>
  resolveNodeSourceContext(required, "node", undefined, undefined, undefined, undefined);
const persistence = (): Promise<Persistence> => Promise.resolve({});

const deps: InProcProviderDeps<NodeTool> = {
  catalog: createNodeCatalog(LANGGRAPH_CATALOG, { omit: ["work-closeout"] }),
  completion,
  tools,
  toolBundle: CORE_TOOL_BUNDLE,
  scope,
  authority,
  log,
  coding,
  sourceContext,
  persistence,
  mcpTools: async () => null,
  isChildModelAllowed: async () => false,
  traceId: () => undefined,
};
export const provider = createLangGraphInProcProvider(deps);
export const routed = requiresInProcess(LANGGRAPH_CATALOG.cogni!, CORE_TOOL_BUNDLE);
export const events: Readonly<Record<string, string>> = INPROC_EVENTS;
