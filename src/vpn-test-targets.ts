import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

type VpnTestPlanTarget = { id: string; enabled?: boolean } & Record<string, unknown>;
type VpnTestPlan = { testTargets?: unknown } & Record<string, unknown>;

/** Return the canonical path of the test runner plan. */
export function vpnTestPlanPath(): string {
  return path.resolve(process.cwd(), "vpn-testing", "test-plan.json");
}

/** Persist one configured test host's enabled state without changing the rest of the plan. */
export async function setVpnTestTargetEnabled(targetId: string, enabled: boolean, filePath = vpnTestPlanPath()): Promise<{ id: string; enabled: boolean }> {
  const plan = JSON.parse(await readFile(filePath, "utf8")) as VpnTestPlan;
  if (!Array.isArray(plan.testTargets)) throw new Error(`test plan has no testTargets: ${filePath}`);
  let found = false;
  const testTargets = plan.testTargets.map((value, index) => {
    if (!value || typeof value !== "object" || typeof (value as VpnTestPlanTarget).id !== "string") {
      throw new Error(`test plan testTargets[${index}] has no ID`);
    }
    const target = value as VpnTestPlanTarget;
    if (target.id !== targetId) return target;
    found = true;
    return { ...target, enabled };
  });
  if (!found) throw new Error(`unknown test target: ${targetId}`);

  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify({ ...plan, testTargets }, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporaryPath, filePath);
  } catch (error: unknown) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
  return { id: targetId, enabled };
}
