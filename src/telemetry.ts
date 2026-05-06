// Telemetry has been removed from this fork.
// All exports are kept as no-ops so existing call sites compile without changes.

export interface PartnerAudit {
  risk: 'safe' | 'low' | 'medium' | 'high' | 'critical' | 'unknown';
  alerts?: number;
  score?: number;
  analyzedAt: string;
}

export type SkillAuditData = Record<string, PartnerAudit>;
export type AuditResponse = Record<string, SkillAuditData>;

export function setVersion(_version: string): void {}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function fetchAuditData(..._args: unknown[]): Promise<AuditResponse | null> {
  return null;
}

export function track(_data: Record<string, unknown>): void {}

export async function flushTelemetry(): Promise<void> {}
