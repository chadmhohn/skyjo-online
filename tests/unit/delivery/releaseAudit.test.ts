import {
  ALLOWED_MODERATE_ADVISORIES,
  ALLOWED_MODERATE_PACKAGES,
  REACT_ROUTER_EXCEPTION_EXPIRES_AT,
  validateReleaseAudit
} from '../../../scripts/release-audit-lib.mjs';

function report() {
  return {
    auditReportVersion: 2,
    vulnerabilities: {
      'react-router': {
        name: 'react-router',
        severity: 'moderate',
        via: [
          { severity: 'moderate', url: ALLOWED_MODERATE_ADVISORIES[0] },
          { severity: 'moderate', url: ALLOWED_MODERATE_ADVISORIES[2] }
        ]
      },
      'react-router-dom': {
        name: 'react-router-dom',
        severity: 'moderate',
        via: [{ severity: 'moderate', url: ALLOWED_MODERATE_ADVISORIES[1] }, 'react-router']
      }
    },
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 2, high: 0, critical: 0, total: 2 }
    }
  };
}

describe('v0.3.0 dependency exception gate', () => {
  it('accepts only the exact reviewed React Router moderate set before expiry', () => {
    expect(ALLOWED_MODERATE_PACKAGES).toEqual(['react-router', 'react-router-dom']);
    expect(validateReleaseAudit(report(), { now: Date.parse('2026-07-26T12:00:00.000Z') })).toEqual({
      advisoryCount: 3,
      expiresAt: REACT_ROUTER_EXCEPTION_EXPIRES_AT,
      moderatePackageCount: 2
    });
  });

  it('rejects high or critical findings, new moderates, advisory drift, and expiry', () => {
    const high = report();
    high.metadata.vulnerabilities.high = 1;
    expect(() => validateReleaseAudit(high)).toThrow(/high or critical/i);

    const newModerate = report();
    (newModerate.vulnerabilities as Record<string, unknown>).other = {
      name: 'other',
      severity: 'moderate',
      via: []
    };
    newModerate.metadata.vulnerabilities.moderate = 3;
    expect(() => validateReleaseAudit(newModerate)).toThrow(/new, removed, or renamed/i);

    const changedAdvisory = report();
    changedAdvisory.vulnerabilities['react-router'].via[0].url = 'https://github.com/advisories/GHSA-xxxx-xxxx-xxxx';
    expect(() => validateReleaseAudit(changedAdvisory)).toThrow(/allowlist/i);

    expect(() => validateReleaseAudit(report(), {
      now: Date.parse(REACT_ROUTER_EXCEPTION_EXPIRES_AT) + 1
    })).toThrow(/expired/i);
  });
});
