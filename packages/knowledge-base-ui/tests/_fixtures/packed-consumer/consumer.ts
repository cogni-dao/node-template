import type * as Root from "@cogni-dao/knowledge-base-ui";
import type * as Knowledge from "@cogni-dao/knowledge-base-ui/knowledge";
import type * as Goals from "@cogni-dao/knowledge-base-ui/goals";
import type * as WorkItem from "@cogni-dao/knowledge-base-ui/work-item";
import type * as Graph from "@cogni-dao/knowledge-base-ui/graph-3d";
import type {
  EpochWallet,
  EpochsClient,
} from "@cogni-dao/knowledge-base-ui/epochs";
const neverRead = (): never => {
  throw new Error("fixture");
};
const wallet: EpochWallet = {
  useAccount: () => ({ isConnected: false }),
  useChainId: () => 1,
  useSwitchChain: () => ({ switchChain: () => {} }),
  useReadContract: neverRead,
  useWriteContract: () => ({
    writeContract: () => {},
    data: undefined,
    isPending: false,
    error: null,
  }),
  useWaitForTransactionReceipt: () => ({ isLoading: false, isSuccess: false }),
  distributorAbi: [],
  ConnectWalletComponent: () => null,
  getChainName: () => "test",
  getTransactionExplorerUrl: () => null,
};
const endpoint = (id: string) => id;
const client: EpochsClient = {
  dataScope: "test",
  request: async () => new Response(),
  wallet,
  endpoints: {
    epochs: "",
    lifecycle: "",
    collect: "",
    projections: endpoint,
    claimants: endpoint,
    activity: endpoint,
    overrides: endpoint,
    review: endpoint,
    signData: endpoint,
    finalize: endpoint,
    distribution: endpoint,
  },
};
type Entries = [
  typeof Root,
  typeof Knowledge,
  typeof Goals,
  typeof WorkItem,
  typeof Graph,
];
export type { Entries };
export { client };
