"use client";

import { useCallback, useEffect, useState } from "react";

type UseAutomatedChainInput<TStep extends string> = {
  evidenceId?: string;
  steps: readonly TStep[];
  shouldAutoStart: boolean;
  runStep: (step: TStep) => Promise<void>;
  doneStoragePrefix?: string;
  onStepError?: (step: TStep, error: unknown) => void;
  onCompleted?: () => void;
};

export function useAutomatedChain<TStep extends string>(input: UseAutomatedChainInput<TStep>) {
  const [autoChainRunning, setAutoChainRunning] = useState(false);
  const [autoChainStarted, setAutoChainStarted] = useState(false);
  const [autoChainCompleted, setAutoChainCompleted] = useState(false);
  const [autoChainCurrentStep, setAutoChainCurrentStep] = useState<TStep | null>(null);
  const [autoChainFailedStep, setAutoChainFailedStep] = useState<TStep | null>(null);

  const doneStoragePrefix = input.doneStoragePrefix ?? "core:auto-chain:done";

  const getDoneKey = useCallback(
    (evidenceId: string) => `${doneStoragePrefix}:${evidenceId}`,
    [doneStoragePrefix]
  );

  const getStepDoneKey = useCallback(
    (evidenceId: string, step: TStep) => `${doneStoragePrefix}:${evidenceId}:step:${step}`,
    [doneStoragePrefix]
  );

  useEffect(() => {
    setAutoChainStarted(false);
    setAutoChainRunning(false);
    setAutoChainCurrentStep(null);
    setAutoChainFailedStep(null);

    if (!input.evidenceId) {
      setAutoChainCompleted(false);
      return;
    }

    const doneKey = getDoneKey(input.evidenceId);
    const done = typeof window !== "undefined" && window.localStorage.getItem(doneKey) === "1";
    setAutoChainCompleted(done);
  }, [getDoneKey, input.evidenceId]);

  const runAutomatedChain = useCallback(
    async (startAt = 0) => {
      if (!input.evidenceId) return;
      const candidateSteps = input.steps.slice(startAt);
      const steps =
        typeof window !== "undefined"
          ? candidateSteps.filter((step) => window.localStorage.getItem(getStepDoneKey(input.evidenceId!, step)) !== "1")
          : candidateSteps;
      if (steps.length === 0) return;

      setAutoChainStarted(true);
      setAutoChainRunning(true);
      setAutoChainFailedStep(null);

      for (const step of steps) {
        try {
          setAutoChainCurrentStep(step);
          await input.runStep(step);
          if (typeof window !== "undefined") {
            window.localStorage.setItem(getStepDoneKey(input.evidenceId, step), "1");
          }
        } catch (error) {
          setAutoChainRunning(false);
          setAutoChainCurrentStep(null);
          setAutoChainFailedStep(step);
          input.onStepError?.(step, error);
          return;
        }
      }

      const doneKey = getDoneKey(input.evidenceId);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(doneKey, "1");
      }
      setAutoChainRunning(false);
      setAutoChainCurrentStep(null);
      setAutoChainCompleted(true);
      input.onCompleted?.();
    },
    [getDoneKey, getStepDoneKey, input]
  );

  useEffect(() => {
    if (!input.evidenceId) return;
    if (!input.shouldAutoStart) return;
    if (autoChainCompleted || autoChainStarted || autoChainRunning || autoChainFailedStep) return;
    void runAutomatedChain(0);
  }, [
    autoChainCompleted,
    autoChainStarted,
    autoChainRunning,
    autoChainFailedStep,
    input.evidenceId,
    input.shouldAutoStart,
    runAutomatedChain
  ]);

  return {
    autoChainRunning,
    autoChainCompleted,
    autoChainCurrentStep,
    autoChainFailedStep,
    runAutomatedChain
  };
}
