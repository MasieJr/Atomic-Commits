// Keep finalization testable without importing the CLI or starting a live proof.
// Raw report/close errors are deliberately never returned or logged here.
export interface ProofCFinalizationRun {
  finish(error?: unknown): Promise<void>;
  close(): Promise<void>;
}

export interface ProofCFinalizationOutcome {
  finishFailed: boolean;
  signalCleanupFailed: boolean;
  closeFailed: boolean;
}

export const PROOF_C_FINISH_ERROR = "Payment proof C ran but could not finalize its run report.";
export const PROOF_C_SIGNAL_CLEANUP_ERROR = "Payment proof C could not remove its signal handlers.";
export const PROOF_C_CLOSE_ERROR = "Payment proof C could not release its run lock.";

export async function finalizeProofCRun(
  run: ProofCFinalizationRun,
  failure: unknown,
  removeSignalHandlers: () => void,
): Promise<ProofCFinalizationOutcome> {
  const result: ProofCFinalizationOutcome = {
    finishFailed: false,
    signalCleanupFailed: false,
    closeFailed: false,
  };
  try {
    await run.finish(failure);
  } catch {
    result.finishFailed = true;
  }
  try {
    removeSignalHandlers();
  } catch {
    result.signalCleanupFailed = true;
  }
  try {
    await run.close();
  } catch {
    result.closeFailed = true;
  }
  return result;
}
