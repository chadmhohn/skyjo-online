import {
  validateReleaseAudit
} from '../../../scripts/release-audit-lib.mjs';

function report(severity?: 'moderate' | 'high' | 'critical') {
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  const vulnerabilities: Record<string, unknown> = {};
  if (severity) {
    counts[severity] = 1;
    counts.total = 1;
    vulnerabilities.example = { name: 'example', severity, via: [] };
  }
  return {
    auditReportVersion: 2,
    vulnerabilities,
    metadata: {
      vulnerabilities: counts
    }
  };
}

describe('release dependency audit gate', () => {
  it('accepts a report with no moderate, high, or critical findings', () => {
    expect(validateReleaseAudit(report())).toEqual({ lowCount: 0 });
  });

  it.each(['moderate', 'high', 'critical'] as const)('rejects a %s finding', (severity) => {
    expect(() => validateReleaseAudit(report(severity))).toThrow(/moderate, high, or critical/i);
  });
});
