// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/work-items`
 * Purpose: Work item port interfaces, domain types, evaluation validation/ranking, and status transitions.
 * Scope: Public barrel export. Does not contain I/O or adapter code.
 * Invariants: Domain types and injected-port composition; no runtime configuration.
 * Side-effects: none
 * Links: docs/spec/development-lifecycle.md, docs/spec/identity-model.md
 * @public
 */

export type { WorkItemsContentPort, WorkItemsPort } from "./content.js";
export type {
  HistoryCite,
  HistoryDiffRow,
  HistoryEntry,
  HistoryFieldDiff,
  ShapeHistoryOptions,
} from "./history.js";
export type { HistoryOutput } from "./history-contract.js";
export type {
  CiteRef,
  EntryResolver,
  EntryResolverRule,
  ResolvedEntry,
} from "./cites.js";
export {
  CITE_COMMIT_PATTERN,
  CITE_CONTRIBUTION_PATTERN,
  CITE_ID_PATTERN,
  CITE_MAX,
  CitesInvalidError,
  CitesUnsupportedError,
  citeIssues,
  EntryResolverUnavailableError,
  EntryUnresolvedError,
} from "./cites.js";
export {
  ChangeReasonSchema,
  HistoryEntrySchema,
  HistoryOutputSchema,
  workItemsHistoryOperation,
} from "./history-contract.js";
export type { WorkItemPatchInput } from "./patch-contract.js";
export type {
  JudgedMove,
  MetricBaselinePort,
  MoveDirection,
  MoveContext,
  MoveInput,
  MoveReading,
  MoveReadingPort,
  MovedState,
  MoveUnknownReason,
  WorkItemMove,
} from "./moves.js";
export {
  judgeItemMoves,
  judgeMove,
  judgeMoves,
  judgeMoveSummaries,
  readMoveContext,
  withMoveContext,
  MOVE_METRIC_ID_MAX,
  MOVE_OBSERVATION_ID_PATTERN,
  MOVES_DEADLINE_MS,
  MOVES_MAX,
  MetricBaselineUnavailableError,
  MoveMetricGoneError,
  MovesInvalidError,
  MovesUnsupportedError,
  moveIssues,
  parseStoredMoves,
  pinMoves,
} from "./moves.js";
export {
  CiteRefSchema,
  MoveInputSchema,
  WorkItemMovesInputSchema,
  WorkItemPatchInputSchema,
  WorkItemPatchStatusSchema,
  WorkItemScoresInputSchema,
} from "./patch-contract.js";
export type {
  HistoryReadLog,
  WorkItemHistoryResult,
  WorkItemHistoryStore,
} from "./history-read.js";
export { readWorkItemHistory } from "./history-read.js";
export {
  CHANGE_REASON_MAX_CHARS,
  CHANGE_REASON_MAX_WORDS,
  CHANGE_REASON_REQUIRED_MESSAGE,
  ChangeReasonInvalidError,
  checkChangeReason,
  formatCitesTrailer,
  HISTORY_MAX_VERSIONS,
  HISTORY_READ_ROWS,
  normalizeChangeReason,
  parseCitesTrailer,
  parseWorkItemCommitMessage,
  shapeHistory,
} from "./history.js";
export {
  WorkItemRevisionConflictError,
  WorkItemScoresInvalidError,
  WorkItemsCapacityError,
  WorkItemWriteOutcomeUnknownError,
} from "./errors.js";

export type {
  WorkItemLease,
  WorkItemLeaseOwner,
  WorkItemLeasePort,
} from "./leases.js";
export type { WorkItemCommandPort, WorkItemQueryPort } from "./ports.js";
export type {
  WorkItemScoresIssue,
  WorkItemScoresIssueCode,
  WorkItemScoresParseResult,
} from "./scores.js";
export {
  EASE_ITERATIONS,
  parseWorkItemScores,
  rankScore,
  WORK_ITEM_SCORE_AXIS_ID,
  WORK_ITEM_SCORE_EV_MAX_CHARS,
  WORK_ITEM_SCORE_EVIDENCE_FROM,
  WORK_ITEM_SCORE_MAX,
  WORK_ITEM_SCORE_MIN,
  WORK_ITEM_SCORES_MAX_AXES,
  WORK_ITEM_SCORES_MAX_BYTES,
} from "./scores.js";
export { isValidTransition, VALID_TRANSITIONS } from "./transitions.js";
export type {
  ActorKind,
  ExternalRef,
  RelationType,
  Revision,
  SubjectRef,
  WorkItem,
  WorkItemId,
  WorkItemScore,
  WorkItemScores,
  WorkItemStatus,
  WorkItemType,
  WorkQuery,
  WorkRelation,
} from "./types.js";
export { toWorkItemId } from "./types.js";
export type {
  WorkItemWriteErrorResponse,
  WorkItemWriteOperation,
} from "./write-errors.js";
export {
  WORK_ITEM_WRITE_ERROR_NAMES,
  workItemWriteErrorResponse,
} from "./write-errors.js";
export type {
  WorkItemCreateWire,
  WorkItemPatchWire,
} from "./write-input.js";
export {
  toWorkItemsCreateInput,
  toWorkItemsPatchInput,
  WORK_ITEM_CREATE_FIELDS,
} from "./write-input.js";
export { withWorkItemLeases } from "./with-leases.js";

export {
  WORK_ITEM_SORT_FIELDS,
  WORK_ITEM_SORT_DIRECTIONS,
  normalizeWorkItemOrder,
  compareWorkItems,
} from "./query-order.js";
export type {
  WorkItemSortBy,
  WorkItemSortDirection,
  WorkItemOrder,
} from "./query-order.js";

export { toWorkItemDto } from "./types.js";

export * from "./contracts.js";

export type {
  ListWorkBoardColumns,
  ListWorkSummaries,
  LoadWorkBoardOptions,
  WorkBoardColumnPages,
  WorkBoardColumn,
  WorkBoardColumns,
  WorkBoardQueryParse,
} from "./board.js";
export {
  loadWorkBoardColumns,
  parseWorkBoardSearchParams,
  WORK_BOARD_COLUMN_STATES,
  WORK_BOARD_READ_BUDGET_MS,
  WORK_BOARD_STATUSES,
  WorkBoardColumnSchema,
  WorkBoardColumnsSchema,
  workBoardColumnQuery,
} from "./board.js";
export type {
  ParsedWorkSummaryQuery,
  WorkSummaryIssue,
  WorkSummaryPage,
  WorkSummaryPageInfo,
  WorkSummaryQuery,
  WorkSummaryQueryParse,
  WorkSummaryReadOptions,
} from "./summary-query.js";
export {
  parseWorkSummarySearchParams,
  WORK_BOARD_COLUMN_PAGE,
  WORK_SUMMARY_LIST_MAX,
  WORK_SUMMARY_VALUE_MAX,
  WORK_SUMMARY_PAGE_DEFAULT,
  WORK_SUMMARY_PAGE_MAX,
  WORK_SUMMARY_TEXT_MAX,
  WORK_TEXT_SCAN_MAX_ROWS,
  WorkSummaryPageInfoSchema,
  WorkSummaryPageSchema,
  WorkSummaryQuerySchema,
  workSummaryQueryToSearchParams,
} from "./summary-query.js";
export type {
  WorkBoardRequestOptions,
  WorkReadErrorBody,
  WorkReadErrorCode,
  WorkReadResult,
  WorkReadTelemetry,
  WorkSummariesRequestOptions,
} from "./read-handlers.js";
export {
  classifyWorkReadError,
  handleWorkBoardRequest,
  handleWorkSummariesRequest,
  WORK_READ_CLIENT_CLOSED,
  WORK_READ_ERROR_CODES,
} from "./read-handlers.js";
