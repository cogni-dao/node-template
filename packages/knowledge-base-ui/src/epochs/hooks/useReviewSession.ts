// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

"use client";
import { useQueryClient } from "@tanstack/react-query";
/** Purpose: Helps a human decide whether saved weights and complete totals are ready to sign.
 * Drafts live above workspace/error/paging/disclosure branches. Query data stays in TanStack.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEpochContext } from "../context";
import { ReviewRefusal, safeReviewError } from "../review-errors";
import {
  type FinishEpochWorkspaceData,
  finishWorkspaceKey,
} from "./useFinishEpochWorkspace";
import {
  type OverrideRead,
  type OverrideSubmission,
  overridesQueryKey,
  useReviewSubjectOverrides,
} from "./useReviewSubjectOverrides";

export interface ReviewDraft {
  readonly id: string;
  readonly editing: boolean;
  readonly units: string;
  readonly reason: string;
  readonly revision: number;
  readonly refusal: ReviewRefusal | null;
}
interface Marker {
  readonly submission: OverrideSubmission;
  readonly draftRevision: number | null;
  readonly draftId: string | null;
  readonly accepted: boolean;
  readonly reviewed?: boolean;
  readonly status: "writing" | "checking" | "blocked" | "conflict";
}
export type ReviewOperationResult =
  | "verified_acceptance"
  | "unverified_acceptance"
  | "refused"
  | "unknown_outcome"
  | "obsolete";
interface Proof {
  readonly identity: string;
  readonly workspace: string;
  readonly overrides: string;
}

const usable = (w: FinishEpochWorkspaceData | undefined, id: string | null) =>
  !!id &&
  !!w &&
  !w.lifecycleUnavailable &&
  w.selection?.kind === "finalize" &&
  w.selection.epoch.id === id &&
  w.epochView?.id === id &&
  w.epochView.status === "review";

export function useReviewSession(epochId: string | null) {
  const { state, queryKeyPrefix, isCurrentScope } = useEpochContext();
  const queryClient = useQueryClient();
  const overrides = useReviewSubjectOverrides(epochId);
  const pagesKey = JSON.stringify(state.contributorPages ?? {});
  const workspaceKey = useMemo(
    () =>
      finishWorkspaceKey(
        queryKeyPrefix,
        JSON.parse(pagesKey) as Record<string, number>,
      ),
    [queryKeyPrefix, pagesKey],
  );
  const overrideKey = useMemo(
    () => overridesQueryKey(queryKeyPrefix, epochId),
    [queryKeyPrefix, epochId],
  );
  const keyIdentity = JSON.stringify([workspaceKey, overrideKey]);
  const generation = useRef({ key: keyIdentity, value: 0 });
  if (generation.current.key !== keyIdentity)
    generation.current = {
      key: keyIdentity,
      value: generation.current.value + 1,
    };
  const identity = `${keyIdentity}:${generation.current.value}`;
  const [drafts, setDrafts] = useState<
    Record<string, Record<string, ReviewDraft>>
  >({});
  const [markers, setMarkers] = useState<Record<string, Marker | undefined>>(
    {},
  );
  const [notice, setNotice] = useState<ReviewRefusal | null>(null);
  const [authorityRefusals, setAuthorityRefusals] = useState<
    Record<string, ReviewRefusal | undefined>
  >({});
  const [retryAt, setRetryAt] = useState(0);
  const retryAtRef = useRef(0);
  const [checking, setChecking] = useState(false);
  const signingEpochs = useRef(new Set<string>());
  const [, setSigningTick] = useState(0);
  const signing = epochId !== null && signingEpochs.current.has(epochId);
  const [proof, setProof] = useState<Proof | null>(null);
  const proofRef = useRef<Proof | null>(null);
  const mounted = useRef(true);
  const writes = useRef(new Set<string>());
  const cycle = useRef<{ identity: string; promise: Promise<boolean> } | null>(
    null,
  );
  const live = useRef({
    identity,
    epochId,
    workspaceKey,
    overrideKey,
    signing,
    markers,
    drafts,
    authorityRefusals,
  });
  live.current = {
    identity,
    epochId,
    workspaceKey,
    overrideKey,
    signing,
    markers,
    drafts,
    authorityRefusals,
  };
  const current = useCallback(
    (captured: string) =>
      mounted.current && isCurrentScope() && live.current.identity === captured,
    [isCurrentScope],
  );
  const readsReady = useCallback(() => {
    const l = live.current;
    const p = proofRef.current;
    const w = queryClient.getQueryState<FinishEpochWorkspaceData>(
      l.workspaceKey,
    );
    const o = queryClient.getQueryState<OverrideRead>(l.overrideKey);
    return (
      !!p &&
      p.identity === l.identity &&
      usable(w?.data, l.epochId) &&
      w?.status === "success" &&
      w.fetchStatus === "idle" &&
      !w.isInvalidated &&
      w.data?.readId === p.workspace &&
      o?.status === "success" &&
      o.fetchStatus === "idle" &&
      !o.isInvalidated &&
      o.data?.readId === p.overrides
    );
  }, [queryClient]);
  const block = useCallback(() => {
    proofRef.current = null;
    setProof(null);
  }, []);

  const refresh = useCallback((): Promise<boolean> => {
    const l = live.current;
    const id = l.epochId;
    if (
      Date.now() < retryAtRef.current ||
      !id ||
      l.signing ||
      writes.current.has(id)
    )
      return Promise.resolve(false);
    if (cycle.current?.identity === l.identity) return cycle.current.promise;
    const captured = l.identity;
    block();
    setChecking(true);
    setNotice(null);
    const work = async () => {
      try {
        // Cancel + await only the two active keys. Cancellation can revert to old
        // success; the per-read nonce below rejects that retained result.
        await Promise.all([
          queryClient.cancelQueries({ queryKey: l.workspaceKey, exact: true }),
          queryClient.cancelQueries({ queryKey: l.overrideKey, exact: true }),
        ]);
        if (!current(captured)) return false;
        const oldWorkspace = queryClient.getQueryData<FinishEpochWorkspaceData>(
          l.workspaceKey,
        )?.readId;
        const oldOverrides = queryClient.getQueryData<OverrideRead>(
          l.overrideKey,
        )?.readId;
        const results = await Promise.allSettled([
          queryClient.refetchQueries(
            { queryKey: l.workspaceKey, exact: true, type: "active" },
            { throwOnError: true, cancelRefetch: false },
          ),
          queryClient.refetchQueries(
            { queryKey: l.overrideKey, exact: true, type: "active" },
            { throwOnError: true, cancelRefetch: false },
          ),
        ]);
        if (!current(captured)) return false;
        const failed = results.find(
          (r): r is PromiseRejectedResult => r.status === "rejected",
        );
        if (failed) throw failed.reason;
        const w = queryClient.getQueryState<FinishEpochWorkspaceData>(
          l.workspaceKey,
        );
        const o = queryClient.getQueryState<OverrideRead>(l.overrideKey);
        if (
          w?.status !== "success" ||
          w.fetchStatus !== "idle" ||
          w.isInvalidated ||
          !usable(w.data, l.epochId) ||
          !w.data?.readId ||
          w.data.readId === oldWorkspace ||
          o?.status !== "success" ||
          o.fetchStatus !== "idle" ||
          o.isInvalidated ||
          !o.data?.readId ||
          o.data.readId === oldOverrides
        )
          throw new ReviewRefusal("unavailable", "read");
        const nextProof = {
          identity: captured,
          workspace: w.data.readId,
          overrides: o.data.readId,
        };
        proofRef.current = nextProof;
        setProof(nextProof);
        const marker = live.current.markers[id];
        if (marker) {
          const sub = marker.submission;
          const saved = o.data.overrides.find(
            (item) => item.subjectRef === sub.subjectRef,
          );
          const matches =
            sub.kind === "reset"
              ? saved === undefined
              : saved?.overrideUnits != null &&
                BigInt(saved.overrideUnits) === BigInt(sub.units) &&
                saved.overrideReason === sub.reason;
          if (!matches) {
            setMarkers((all) => ({
              ...all,
              [id]: { ...marker, status: "conflict" },
            }));
            setNotice(new ReviewRefusal("conflict", "read"));
            return false;
          }
          setMarkers((all) => ({ ...all, [id]: undefined }));
          setDrafts((all) => {
            const entry = all[id]?.[sub.subjectRef];
            if (
              !entry ||
              entry.revision !== marker.draftRevision ||
              entry.id !== marker.draftId
            )
              return all;
            const subjects = { ...all[id] };
            delete subjects[sub.subjectRef];
            return { ...all, [id]: subjects };
          });
        }
        // Unrelated pages become stale without triggering hidden history reads.
        void queryClient.invalidateQueries({
          queryKey: queryKeyPrefix,
          predicate: (q) =>
            JSON.stringify(q.queryKey) !== JSON.stringify(l.workspaceKey) &&
            JSON.stringify(q.queryKey) !== JSON.stringify(l.overrideKey),
          refetchType: "none",
        });
        return true;
      } catch (error) {
        if (current(captured)) {
          block();
          const refusal = safeReviewError(error, "read");
          if (refusal.retryAt) {
            retryAtRef.current = refusal.retryAt;
            setRetryAt(refusal.retryAt);
          }
          setNotice(refusal);
          setMarkers((all) => {
            const marker = all[id];
            return marker
              ? { ...all, [id]: { ...marker, status: "blocked" } }
              : all;
          });
        }
        return false;
      } finally {
        if (current(captured)) setChecking(false);
        if (cycle.current?.identity === captured) cycle.current = null;
      }
    };
    // Assign before any awaited cancellation or observer callback can re-enter.
    const promise = Promise.resolve().then(work);
    cycle.current = { identity: captured, promise };
    return promise;
  }, [queryClient, queryKeyPrefix, block, current]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    block();
    setNotice(null);
    setChecking(false);
    if (epochId) void refresh();
    return () => {
      void queryClient.cancelQueries({ queryKey: workspaceKey, exact: true });
      void queryClient.cancelQueries({ queryKey: overrideKey, exact: true });
    };
  }, [
    identity,
    epochId,
    workspaceKey,
    overrideKey,
    refresh,
    block,
    queryClient,
  ]);
  useEffect(
    () =>
      queryClient.getQueryCache().subscribe((event) => {
        const l = live.current;
        const hash = JSON.stringify(event.query.queryKey);
        if (
          hash !== JSON.stringify(l.workspaceKey) &&
          hash !== JSON.stringify(l.overrideKey)
        )
          return;
        if (
          event.type === "updated" &&
          event.action.type === "fetch" &&
          !cycle.current &&
          !writes.current.has(l.epochId ?? "")
        ) {
          block();
          // Focus/reconnect/explicit reads share the same two-owner coordinator.
          void refresh();
        }
      }),
    [queryClient, refresh, block],
  );

  useEffect(() => {
    if (!retryAt) return;
    const timeout = setTimeout(
      () => {
        retryAtRef.current = 0;
        setRetryAt(0);
      },
      Math.max(0, retryAt - Date.now()),
    );
    return () => clearTimeout(timeout);
  }, [retryAt]);

  const startDraft = (subjectRef: string) => {
    const id = live.current.epochId;
    if (!id) return;
    const saved = overrides.overridesByRef.get(subjectRef);
    setDrafts((all) => {
      const existing = all[id]?.[subjectRef];
      return {
        ...all,
        [id]: {
          ...all[id],
          [subjectRef]: existing
            ? { ...existing, editing: true }
            : {
                id: crypto.randomUUID(),
                editing: true,
                units: saved?.overrideUnits ?? "",
                reason: saved?.overrideReason ?? "",
                revision: 0,
                refusal: null,
              },
        },
      };
    });
  };
  const changeDraft = (
    subjectRef: string,
    patch: Partial<Pick<ReviewDraft, "units" | "reason">>,
  ) => {
    const id = live.current.epochId;
    if (!id) return;
    setDrafts((all) => {
      const draft = all[id]?.[subjectRef];
      if (!draft) return all;
      return {
        ...all,
        [id]: {
          ...all[id],
          [subjectRef]: {
            ...draft,
            ...patch,
            revision: draft.revision + 1,
            refusal: null,
          },
        },
      };
    });
  };
  const cancelDraft = (subjectRef: string) => {
    const id = live.current.epochId;
    if (!id) return;
    setDrafts((all) => {
      const subjects = { ...all[id] };
      delete subjects[subjectRef];
      return { ...all, [id]: subjects };
    });
  };
  const canWrite = () => {
    const l = live.current;
    return (
      isCurrentScope() &&
      mounted.current &&
      readsReady() &&
      !!l.epochId &&
      !l.signing &&
      !cycle.current &&
      !writes.current.has(l.epochId) &&
      (!l.markers[l.epochId] ||
        (l.markers[l.epochId]?.status === "conflict" &&
          l.markers[l.epochId]?.reviewed === true)) &&
      !l.authorityRefusals[l.epochId] &&
      Date.now() >= retryAtRef.current
    );
  };
  const submit = async (
    subjectRef: string,
    kind: "save" | "reset",
  ): Promise<ReviewOperationResult> => {
    const l = live.current;
    if (!canWrite() || !l.epochId) return "refused";
    const id = l.epochId;
    const draft = l.drafts[id]?.[subjectRef];
    const savedOverride = overrides.overridesByRef.get(subjectRef);
    if (kind === "save" && (!draft || !/^\d+$/.test(draft.units.trim())))
      return "refused";
    const submission: OverrideSubmission = {
      subjectRef,
      kind,
      units: draft?.units.trim() ?? "",
      reason: draft?.reason.trim() || null,
    };
    const marker: Marker = {
      submission,
      draftRevision: draft?.revision ?? null,
      draftId: draft?.id ?? null,
      accepted: false,
      status: "writing",
    };
    writes.current.add(id);
    block();
    setNotice(null);
    // Make the acceptance marker visible synchronously to the coordinator too.
    const putMarker = (next: Marker | undefined) => {
      live.current.markers = { ...live.current.markers, [id]: next };
      setMarkers((all) => ({ ...all, [id]: next }));
    };
    putMarker(marker);
    let unknown = false;
    try {
      await overrides.submit(submission);
      if (!mounted.current || !isCurrentScope()) return "obsolete";
      putMarker({ ...marker, accepted: true, status: "checking" });
    } catch (error) {
      if (!mounted.current || !isCurrentScope()) return "obsolete";
      const refusal = safeReviewError(error, kind);
      if (
        refusal.category === "forbidden" ||
        refusal.category === "unauthenticated"
      )
        setAuthorityRefusals((all) => ({ ...all, [id]: refusal }));
      if (refusal.retryAt && current(l.identity)) {
        retryAtRef.current = refusal.retryAt;
        setRetryAt(refusal.retryAt);
      }
      unknown = refusal.category === "outcome_unknown";
      if (unknown) putMarker({ ...marker, status: "checking" });
      else {
        putMarker(undefined);
        setDrafts((all) => {
          const entry = all[id]?.[subjectRef];
          if (marker.draftId !== null && !entry) return all;
          if (
            entry &&
            (entry.revision !== marker.draftRevision ||
              entry.id !== marker.draftId)
          )
            return all;
          return {
            ...all,
            [id]: {
              ...all[id],
              [subjectRef]: {
                ...(entry ?? {
                  id: crypto.randomUUID(),
                  editing: false,
                  units: savedOverride?.overrideUnits ?? "",
                  reason: savedOverride?.overrideReason ?? "",
                  revision: 0,
                }),
                refusal,
              },
            },
          };
        });
        const submittedDraft = live.current.drafts[id]?.[subjectRef];
        if (
          current(l.identity) &&
          (marker.draftId === null ||
            (submittedDraft?.id === marker.draftId &&
              submittedDraft.revision === marker.draftRevision))
        ) {
          setNotice(refusal);
          // A definite input refusal preserves the last verified read proof only
          // after a complete refresh; no refusal implies current server state.
        }
        return "refused";
      }
    } finally {
      writes.current.delete(id);
    }
    if (!mounted.current || !isCurrentScope() || live.current.epochId !== id)
      return "obsolete";
    const verified = await refresh();
    return verified
      ? "verified_acceptance"
      : unknown
        ? "unknown_outcome"
        : "unverified_acceptance";
  };
  const marker = epochId ? markers[epochId] : undefined;
  const ready =
    !!proof &&
    readsReady() &&
    !checking &&
    (!marker || (marker.status === "conflict" && marker.reviewed === true)) &&
    !signing &&
    !authorityRefusals[epochId ?? ""] &&
    Date.now() >= retryAt;
  return {
    overrides,
    epochId,
    drafts: epochId ? (drafts[epochId] ?? {}) : {},
    marker,
    notice: authorityRefusals[epochId ?? ""] ?? notice,
    retryBlocked: Date.now() < retryAt,
    checking,
    ready,
    writesDisabled: !ready,
    startDraft,
    changeDraft,
    cancelDraft,
    submit,
    refresh,
    acknowledgeConflict: () => {
      const l = live.current;
      const id = l.epochId;
      const marker = id ? l.markers[id] : undefined;
      if (id && marker?.status === "conflict" && readsReady()) {
        const reviewed = { ...marker, reviewed: true };
        live.current.markers = { ...l.markers, [id]: reviewed };
        setMarkers((all) => ({ ...all, [id]: reviewed }));
        setNotice(null);
      }
    },
    canSign: () => canWrite(),
    beginSigning: () => {
      const id = live.current.epochId;
      if (!id || !canWrite()) return false;
      signingEpochs.current.add(id);
      live.current.signing = true;
      setSigningTick((n) => n + 1);
      return true;
    },
    endSigning: () => {
      if (epochId && mounted.current && isCurrentScope()) {
        signingEpochs.current.delete(epochId);
        live.current.signing =
          live.current.epochId !== null &&
          signingEpochs.current.has(live.current.epochId);
        setSigningTick((n) => n + 1);
      }
    },
  };
}
export type ReviewSession = ReturnType<typeof useReviewSession>;
