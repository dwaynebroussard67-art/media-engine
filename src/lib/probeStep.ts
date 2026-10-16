// src/lib/probeStep.ts
//
// The tiny step recorder shared by every setup probe (storage, render,
// database, catalog). One shape, so the setup UI can render any probe's
// timeline with one component and nothing has to agree on ad-hoc JSON.
//
// Contract: runStep NEVER throws. A probe that blows up is a failed step with
// the error text attached — silent failure is forbidden everywhere in this
// system, including in the tools that check the system.

export interface ProbeStep {
  name: string;
  ok: boolean;
  detail: string;
  ms: number;
}

export async function runStep(
  name: string,
  fn: () => Promise<string>,
): Promise<{ step: ProbeStep; ok: boolean }> {
  const start = Date.now();
  try {
    const detail = await fn();
    return { step: { name, ok: true, detail, ms: Date.now() - start }, ok: true };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { step: { name, ok: false, detail, ms: Date.now() - start }, ok: false };
  }
}
