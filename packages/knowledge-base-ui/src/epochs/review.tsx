// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni-dao/knowledge-base-ui/epochs/review`
 * Purpose: Helps a human decide whether verified epoch weights are ready to sign and finalize.
 * Scope: Composes existing governance hooks and actions. Does not perform server-side logic or construct transactions.
 * Invariants: OLDEST_FIRST, ONE_PRIMARY_ACTION, PINNED_APPROVERS_CAN_FINISH, WRITE_ROUTES_APPROVER_GATED.
 * Side-effects: IO (via existing review, finalize, and publish hooks)
 * Links: src/features/governance/hooks/useFinishEpochWorkspace.ts, task.5038
 * @public
 */

"use client";

import { useIsFetching } from "@tanstack/react-query";
import {
  CheckCircle2,
  ExternalLink,
  FileSignature,
  Loader2,
  Lock,
  Pencil,
  Pin,
  RotateCcw,
  Save,
  X,
} from "lucide-react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  receiptTitle,
  TYPE_ICONS,
  TYPE_LABELS,
} from "./components/ContributionRow";
import { useEpochContext } from "./context";
import { EpochDetail } from "./components/EpochDetail";
import { EpochReviewAction } from "./components/EpochReviewAction";
import { ExecuteDistributionPanel } from "./components/ExecuteDistributionPanel";
import { SourceBadge } from "./components/SourceBadge";
import {
  type FinishEpochSelection,
  isEligibleForFinishEpochWork,
  useFinishEpochWorkspace,
} from "./hooks/useFinishEpochWorkspace";
import { useOpenEpochReview } from "./hooks/useOpenEpochReview";
import {
  type ReviewDraft,
  type ReviewSession,
  useReviewSession,
} from "./hooks/useReviewSession";
import type { ReviewSubjectOverrideView } from "./hooks/useReviewSubjectOverrides";
import { useSignEpoch } from "./hooks/useSignEpoch";
import { applyOverridesToEpochView } from "./lib/compose-epoch";
import type { EpochContributor, EpochView, IngestionReceipt } from "./types";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Input,
  type Phase,
  PhaseList,
  TableCell,
  TableRow,
} from "./ui/index";

interface ReviewViewProps {
  readonly walletAddress: string | null;
  readonly isNodeAdmin: boolean;
  readonly operatorSetupUrl: string;
}

function workflowPhases(
  selection: FinishEpochSelection | null,
  lifecycleUnavailable: boolean,
  recentlyPublished: boolean,
): readonly Phase[] {
  if (recentlyPublished) {
    return [
      { label: "Open review", state: "done" },
      { label: "Sign and finalize", state: "done" },
      {
        label: "Publish",
        state: "done",
        detail: "Latest global settlement confirmed",
      },
    ];
  }
  if (!selection) {
    return [
      { label: "Open review", state: "done" },
      { label: "Sign and finalize", state: "done" },
      {
        label: "Publish",
        state: lifecycleUnavailable ? "error" : "done",
        detail: lifecycleUnavailable
          ? "Couldn’t verify the latest global settlement."
          : "The latest global settlement is live.",
      },
    ];
  }
  if (selection.kind === "open_review") {
    return [
      { label: "Open review", state: "active", detail: "Next action" },
      { label: "Sign and finalize", state: "pending" },
      { label: "Publish", state: "pending" },
    ];
  }
  if (selection.kind === "finalize") {
    return [
      { label: "Open review", state: "done" },
      { label: "Sign and finalize", state: "active", detail: "Next action" },
      { label: "Publish", state: "pending" },
    ];
  }
  return [
    { label: "Open review", state: "done" },
    { label: "Sign and finalize", state: "done" },
    {
      label: "Publish",
      state: "active",
      detail: "Publish the latest global settlement",
    },
  ];
}

export function ReviewView({
  walletAddress,
  isNodeAdmin,
  operatorSetupUrl,
}: ReviewViewProps): ReactElement {
  const workspace = useFinishEpochWorkspace();
  const lastUsable = useRef(workspace.data);
  if (workspace.data && !workspace.data.lifecycleUnavailable)
    lastUsable.current = workspace.data;
  const data = workspace.data?.lifecycleUnavailable
    ? (lastUsable.current ?? workspace.data)
    : workspace.data;
  const { isLoading, error } = workspace;
  const session = useReviewSession(
    data?.selection?.kind === "finalize" ? data.selection.epoch.id : null,
  );
  const openReview = useOpenEpochReview();
  const [publishedExplorerUrl, setPublishedExplorerUrl] = useState<
    string | null
  >(null);

  if (error && !data) {
    return (
      <div className="border-destructive bg-destructive/10 rounded-lg border p-6">
        <h2 className="text-destructive text-lg font-semibold">
          Error loading review data
        </h2>
        <p className="text-muted-foreground text-sm">
          Could not verify current review data.
        </p>
        <Button onClick={() => void workspace.refetch()}>
          Retry review data
        </Button>
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className="animate-pulse space-y-6">
        <div className="bg-muted h-8 w-64 rounded-md" />
        <div className="bg-muted h-64 rounded-lg" />
      </div>
    );
  }

  const { selection, epochView, lifecycleUnavailable } = data;
  const canAct = selection
    ? isEligibleForFinishEpochWork({
        selection,
        walletAddress,
        isNodeAdmin,
      })
    : false;
  const period = selection
    ? `${new Date(selection.epoch.periodStart).toLocaleDateString()} — ${new Date(
        selection.epoch.periodEnd,
      ).toLocaleDateString()}`
    : null;

  return (
    <main className="mx-auto w-full max-w-4xl space-y-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">Finish epoch</h1>
        <p className="text-muted-foreground max-w-2xl text-sm">
          One workspace for the next review, finalization, or publication step.
        </p>
      </header>

      {(error || workspace.data?.lifecycleUnavailable) && (
        <Alert role="alert">
          <AlertTitle>Could not verify current review data</AlertTitle>
          <AlertDescription>
            Cached values and your changes are kept. Refresh current values
            before acting.
          </AlertDescription>
          {session.epochId === null && (
            <Button onClick={() => void workspace.refetch()}>
              Retry review data
            </Button>
          )}
        </Alert>
      )}
      <section
        aria-labelledby="finish-progress-title"
        aria-live="polite"
        className="bg-card rounded-lg border p-4 sm:p-6"
      >
        <div className="mb-4 space-y-1">
          <h2 id="finish-progress-title" className="font-semibold">
            {selection ? `Epoch #${selection.epoch.id}` : "All epoch work"}
          </h2>
          {period ? (
            <p className="text-muted-foreground text-sm">{period}</p>
          ) : null}
        </div>
        <PhaseList
          phases={workflowPhases(
            selection,
            lifecycleUnavailable,
            publishedExplorerUrl !== null,
          )}
        />
      </section>

      {publishedExplorerUrl ? (
        <Alert>
          <AlertTitle>Latest settlement published</AlertTitle>
          <AlertDescription>
            The transaction is confirmed.{" "}
            <a
              href={publishedExplorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline-offset-4 hover:underline"
            >
              View transaction
            </a>
          </AlertDescription>
        </Alert>
      ) : !selection ? (
        lifecycleUnavailable ? (
          <Alert variant="destructive" role="alert">
            <AlertTitle>Couldn’t verify publication</AlertTitle>
            <AlertDescription>
              Review and finalization are caught up, but the latest global
              settlement could not be checked. No publish action is available.
            </AlertDescription>
          </Alert>
        ) : (
          <div className="bg-card flex items-start gap-3 rounded-lg border p-5">
            <CheckCircle2 className="text-success mt-0.5 size-5 shrink-0" />
            <div>
              <h2 className="font-semibold">All caught up</h2>
              <p className="text-muted-foreground mt-1 text-sm">
                There is no ended epoch to review and the latest global
                settlement is published.
              </p>
            </div>
          </div>
        )
      ) : (
        <div className="space-y-4">
          {!canAct ? <LockedActionNotice selection={selection} /> : null}

          {selection.kind === "open_review" && epochView ? (
            <div className="space-y-4">
              <EpochDetail
                epoch={epochView}
                membershipReady={workspace.membershipReady}
              />
              {canAct ? (
                <EpochReviewAction
                  status="open"
                  reviewReady
                  isNodeAdmin
                  isPending={
                    openReview.isPending ||
                    workspace.isFetching ||
                    !!error ||
                    !!workspace.data?.lifecycleUnavailable
                  }
                  error={openReview.error}
                  onOpen={() => {
                    if (
                      !workspace.isFetching &&
                      !error &&
                      !workspace.data?.lifecycleUnavailable
                    )
                      openReview.mutate(selection.epoch.id);
                  }}
                  onContinue={() => undefined}
                />
              ) : null}
            </div>
          ) : null}

          {selection.kind === "finalize" && epochView ? (
            canAct ? (
              <ReviewEpochSection
                key={epochView.id}
                epoch={epochView}
                session={session}
                membershipReady={workspace.membershipReady}
              />
            ) : (
              <EpochDetail
                epoch={epochView}
                membershipReady={workspace.membershipReady}
              />
            )
          ) : null}

          {selection.kind === "publish" ? (
            <div className="space-y-4">
              {selection.lifecycle ? (
                <p className="text-muted-foreground text-sm">
                  {selection.lifecycle.publishedLiabilityCount === null
                    ? "Publication coverage is unknown. The chain read will verify safety before any action appears."
                    : `${selection.lifecycle.publishedLiabilityCount} of ${selection.lifecycle.settledLiabilityCount} settled allocations are published.`}
                </p>
              ) : null}
              {canAct ? (
                <ExecuteDistributionPanel
                  epochId={selection.epoch.id}
                  operatorSetupUrl={operatorSetupUrl}
                  onConfirmed={setPublishedExplorerUrl}
                />
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </main>
  );
}

function LockedActionNotice({
  selection,
}: {
  readonly selection: FinishEpochSelection;
}): ReactElement {
  return (
    <div className="bg-card flex items-start gap-3 rounded-lg border p-4">
      <Lock className="text-muted-foreground mt-0.5 size-5 shrink-0" />
      <div>
        <h2 className="font-semibold">View only</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          {selection.kind === "open_review"
            ? "A current ledger approver must open this review."
            : "A current or pinned approver must complete this step."}
        </p>
      </div>
    </div>
  );
}

// ── Per-epoch review section ─────────────────────────────────────────────────

function ReviewEpochSection({
  epoch,
  session,
  membershipReady,
}: {
  readonly epoch: EpochView;
  readonly session: ReviewSession;
  readonly membershipReady: boolean;
}): ReactElement {
  const { state, sign, reset } = useSignEpoch(epoch.id);
  const { overrides } = session;
  const { queryKeyPrefix } = useEpochContext();
  const loadingDetails = useIsFetching({
    queryKey: [
      ...queryKeyPrefix,
      "epochs",
      epoch.id,
      epoch.status,
      "contributor",
    ],
  });
  // Draft context belongs to the edit, independently of changing membership pages.
  const draftContext = useRef(
    new Map<
      string,
      { claimantKey: string; receipt: IngestionReceipt; offset: number }
    >()
  );

  useEffect(() => {
    for (const id of draftContext.current.keys()) {
      if (!session.drafts[id] && session.marker?.submission.subjectRef !== id)
        draftContext.current.delete(id);
    }
  }, [session.drafts, session.marker]);

  // Recompute contributor sums with overrides applied
  const adjustedEpoch = useMemo(
    () => applyOverridesToEpochView(epoch, overrides.overridesByRef),
    [epoch, overrides.overridesByRef],
  );

  const handleSign = useCallback(() => {
    if (!session.canSign() || !session.beginSigning()) return;
    void sign().finally(session.endSigning);
  }, [sign, session]);

  const renderExpandedRows = useCallback(
    (
      contributor: EpochContributor,
      membershipPending = false,
      receiptOffset = 0
    ): ReactElement[] | null => {
      const ownsEditor = (id: string) => {
        const context = draftContext.current.get(id);
        return (
          !context ||
          context.claimantKey === contributor.claimantKey ||
          !epoch.contributors.some(
            (item) => item.claimantKey === context.claimantKey
          )
        );
      };
      const receipts = contributor.receipts.filter(
        (receipt) =>
          !session.drafts[receipt.receiptId]?.editing ||
          ownsEditor(receipt.receiptId)
      );
      for (const [id, context] of draftContext.current) {
        const retainEditor =
          session.drafts[id]?.editing ||
          (!membershipReady &&
            membershipPending &&
            session.marker?.submission.subjectRef === id);
        if (
          retainEditor &&
          context.claimantKey === contributor.claimantKey &&
          context.offset === receiptOffset &&
          !receipts.some((receipt) => receipt.receiptId === id)
        )
          // This is local edit/operation context, never a retired membership link.
          receipts.push({ ...context.receipt, artifactUrl: null });
      }
      return receipts.map((receipt) => (
        <ReviewReceiptRow
          key={receipt.receiptId}
          receipt={receipt}
          override={overrides.overridesByRef.get(receipt.receiptId) ?? null}
          draft={session.drafts[receipt.receiptId] ?? null}
          onStart={() => {
            draftContext.current.set(receipt.receiptId, {
              claimantKey: contributor.claimantKey,
              receipt,
              offset: receiptOffset,
            });
            session.startDraft(receipt.receiptId);
          }}
          onChange={(patch) => session.changeDraft(receipt.receiptId, patch)}
          onCancel={() => session.cancelDraft(receipt.receiptId)}
          onSave={() => session.submit(receipt.receiptId, "save")}
          onRemove={() => session.submit(receipt.receiptId, "reset")}
          isSaving={session.writesDisabled}
        />
      ));
    },
    [epoch.contributors, membershipReady, overrides, session]
  );

  const activeOverrideCount = overrides.overridesByRef.size;

  return (
    <div className="space-y-4">
      {!session.ready && (
        <Alert role={session.checking ? "status" : "alert"}>
          <AlertTitle>
            {session.marker?.status === "writing"
              ? "Saving weight…"
              : session.marker?.accepted
                ? session.checking
                  ? "Saved. Checking current values…"
                  : "Saved. Could not verify current values."
                : session.marker
                  ? "The write result is unknown."
                  : overrides.error
                    ? "Could not load weight overrides"
                    : session.checking
                      ? "Checking current values…"
                      : "Review values need verification"}
          </AlertTitle>
          <AlertDescription>
            {session.notice?.status ? `HTTP ${session.notice.status}. ` : ""}
            {session.notice?.message ??
              "Weights and complete totals must both be verified before acting."}
          </AlertDescription>
          {!session.checking && session.marker?.status !== "writing" && (
            <Button
              disabled={session.retryBlocked}
              onClick={() => void session.refresh()}
            >
              Retry refresh
            </Button>
          )}
          {session.marker?.status === "conflict" && (
            <Button onClick={session.acknowledgeConflict}>
              Review current values
            </Button>
          )}
        </Alert>
      )}
      {activeOverrideCount > 0 && membershipReady && !loadingDetails && (
        <div className="border-warning/30 bg-warning/5 flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
          <Pencil className="text-warning h-3.5 w-3.5" />
          <span className="text-warning">
            {activeOverrideCount} active weight{" "}
            {activeOverrideCount === 1 ? "override" : "overrides"}
          </span>
          <span className="text-muted-foreground">
            — expand contributions to view or edit
          </span>
        </div>
      )}

      {overrides.data && (
        <EpochDetail
          epoch={adjustedEpoch}
          membershipReady={membershipReady}
          renderExpandedRows={renderExpandedRows}
        />
      )}

      <div className="bg-card flex flex-wrap items-center gap-3 rounded-lg border p-4">
        {state.phase === "IDLE" && (
          <Button onClick={handleSign} disabled={!session.ready}>
            <FileSignature className="mr-2 h-4 w-4" />
            Sign & Finalize
          </Button>
        )}

        {state.isInFlight && (
          <Button disabled>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {state.phase === "FETCHING_DATA" && "Preparing..."}
            {state.phase === "AWAITING_SIGNATURE" && "Awaiting wallet..."}
            {state.phase === "SUBMITTING" && "Submitting..."}
          </Button>
        )}

        {state.phase === "SUCCESS" && (
          <div className="text-success flex items-center gap-2 text-sm">
            <CheckCircle2 className="h-4 w-4" />
            <output>
              Epoch finalized. Statement {state.result?.statementId}.
              {state.result?.cumulativeDistribution
                ? " Settlement ready to publish."
                : " No distribution to publish."}
            </output>
          </div>
        )}

        {state.phase === "ERROR" && (
          <div className="flex items-center gap-3">
            <div className="text-destructive text-sm">{state.errorMessage}</div>
            <Button size="sm" onClick={reset}>
              Try Again
            </Button>
          </div>
        )}

        <p className="text-muted-foreground w-full text-xs">
          Verify the deployment environment shown in your wallet. This signature
          cannot be reused in another environment.
        </p>
      </div>
    </div>
  );
}

// ── Receipt row with inline override editing ────────────────────────────────

function ReviewReceiptRow({
  receipt,
  override,
  draft,
  onStart,
  onChange,
  onCancel,
  onSave,
  onRemove,
  isSaving,
}: {
  readonly receipt: IngestionReceipt;
  readonly override: ReviewSubjectOverrideView | null;
  readonly draft: ReviewDraft | null;
  readonly onStart: () => void;
  readonly onChange: (
    patch: Partial<Pick<ReviewDraft, "units" | "reason">>,
  ) => void;
  readonly onCancel: () => void;
  readonly onSave: () => Promise<unknown>;
  readonly onRemove: () => Promise<unknown>;
  readonly isSaving: boolean;
}): ReactElement {
  const isEditing = draft?.editing ?? false;
  const editUnits = draft?.units ?? "";
  const editReason = draft?.reason ?? "";
  const writeError = draft?.refusal ?? null;
  const handleStartEdit = onStart;
  const handleCancel = onCancel;
  const handleSave = onSave;
  const handleRemove = onRemove;

  const hasOverride = override !== null;
  const Icon = TYPE_ICONS[receipt.eventType] ?? Pin;
  const title = receiptTitle(receipt);
  const score = receipt.units;

  // Editing mode: use a colSpan row for the inline form
  if (isEditing) {
    return (
      <TableRow className="bg-primary/5 hover:bg-primary/5">
        <TableCell colSpan={6} className="p-2">
          <div className="space-y-2">
            {writeError && (
              <p role="alert">
                {writeError.status ? `HTTP ${writeError.status}. ` : ""}
                {writeError.message}
              </p>
            )}
            <div className="flex min-w-0 items-center gap-2 text-sm">
              <Icon className="text-muted-foreground h-3.5 w-3.5" />
              <SourceBadge source={receipt.source as "github" | "discord"} />
              <span className="text-muted-foreground text-xs">
                {TYPE_LABELS[receipt.eventType] ?? receipt.eventType}
              </span>
              {title && (
                <>
                  <span className="text-muted-foreground/40">·</span>
                  <span className="text-foreground/80 truncate text-xs">
                    {title}
                  </span>
                </>
              )}
            </div>
            <div className="flex flex-col items-stretch gap-2 pl-1 sm:flex-row sm:items-end">
              <div className="min-w-0 flex-1">
                <label
                  htmlFor={`override-units-${receipt.receiptId}`}
                  className="text-muted-foreground mb-1 block text-xs"
                >
                  Override weight (units)
                </label>
                <Input
                  id={`override-units-${receipt.receiptId}`}
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={editUnits}
                  onChange={(e) => onChange({ units: e.target.value })}
                  onClick={(e) => e.stopPropagation()}
                  placeholder="e.g. 500"
                />
              </div>
              <div className="min-w-0 flex-1">
                <label
                  htmlFor={`override-reason-${receipt.receiptId}`}
                  className="text-muted-foreground mb-1 block text-xs"
                >
                  Reason (optional)
                </label>
                <Input
                  id={`override-reason-${receipt.receiptId}`}
                  type="text"
                  value={editReason}
                  onChange={(e) => onChange({ reason: e.target.value })}
                  onClick={(e) => e.stopPropagation()}
                  placeholder="e.g. trivial fix"
                />
              </div>
              <Button
                size="sm"
                variant="outline"
                className="min-h-11 w-full sm:w-auto"
                onClick={(e) => {
                  e.stopPropagation();
                  void handleSave();
                }}
                disabled={
                  isSaving ||
                  (!!draft?.refusal &&
                    draft.refusal.category !== "throttled") ||
                  !editUnits.trim() ||
                  !/^\d+$/.test(editUnits.trim())
                }
              >
                <Save className="mr-1 h-3 w-3" />
                {writeError?.category === "throttled" ? "Retry save" : "Save"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="min-h-11 w-full sm:w-auto"
                aria-label="Cancel weight adjustment"
                onClick={(e) => {
                  e.stopPropagation();
                  handleCancel();
                }}
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          </div>
        </TableCell>
      </TableRow>
    );
  }

  return (
    <TableRow
      className={
        hasOverride
          ? "border-warning/20 bg-warning/5 hover:bg-warning/10"
          : "hover:bg-muted/20"
      }
    >
      {/* Chevron column — empty */}
      <TableCell className="w-8 px-2" />
      {/* # column — type icon */}
      <TableCell className="w-10 text-center">
        <Icon className="text-muted-foreground mx-auto h-3.5 w-3.5" />
      </TableCell>
      {/* Contributor column — source + type + title + override badge */}
      <TableCell>
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <SourceBadge source={receipt.source as "github" | "discord"} />
          <span className="text-muted-foreground shrink-0 text-xs">
            {TYPE_LABELS[receipt.eventType] ?? receipt.eventType}
          </span>
          {title && (
            <>
              <span className="text-muted-foreground/40">·</span>
              {receipt.artifactUrl ? (
                <a
                  href={receipt.artifactUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group text-foreground/80 hover:text-foreground flex min-w-0 items-center gap-1 text-xs"
                  onClick={(e) => e.stopPropagation()}
                >
                  <span className="truncate">{title}</span>
                  <ExternalLink className="text-muted-foreground h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
                </a>
              ) : (
                <span className="text-foreground/80 truncate text-xs">
                  {title}
                </span>
              )}
            </>
          )}
          {hasOverride && override.overrideReason && (
            <Badge intent="secondary" size="sm" className="h-5 shrink-0 px-1.5">
              {override.overrideReason}
            </Badge>
          )}
        </div>
      </TableCell>
      {/* Share column — empty */}
      <TableCell className="text-right" />
      {/* Score column — includes edit/reset buttons */}
      <TableCell className="text-right">
        {writeError && (
          <p role="alert">
            {writeError.status ? `HTTP ${writeError.status}. ` : ""}
            {writeError.message}
          </p>
        )}
        <div className="flex items-center justify-end gap-2">
          {score != null && hasOverride ? (
            <span className="font-mono text-xs">
              <span className="text-muted-foreground/50 line-through">
                {score}
              </span>
              <span className="text-muted-foreground/40">{" → "}</span>
              <span className="text-warning">{override.overrideUnits}</span>
            </span>
          ) : score != null ? (
            <span className="text-muted-foreground font-mono text-xs">
              {score}
            </span>
          ) : null}
          <div className="flex shrink-0 items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              className="min-h-11 min-w-11 px-2"
              aria-label="Adjust weight"
              onClick={(e) => {
                e.stopPropagation();
                handleStartEdit();
              }}
              title="Adjust weight"
            >
              <Pencil className="h-3 w-3" />
            </Button>
            {hasOverride && (
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground hover:text-destructive min-h-11 min-w-11"
                aria-label="Reset to original weight"
                onClick={(e) => {
                  e.stopPropagation();
                  void handleRemove();
                }}
                disabled={isSaving}
                title="Reset to original"
              >
                <RotateCcw className="h-3 w-3" />
              </Button>
            )}
          </div>
        </div>
      </TableCell>
    </TableRow>
  );
}
