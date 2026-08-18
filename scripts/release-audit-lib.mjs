export const REACT_ROUTER_EXCEPTION_EXPIRES_AT = '2026-09-30T23:59:00.000Z';
export const ALLOWED_MODERATE_ADVISORIES = Object.freeze([
  'https://github.com/advisories/GHSA-337j-9hxr-rhxg',
  'https://github.com/advisories/GHSA-wrjc-x8rr-h8h6'
]);
export const ALLOWED_MODERATE_PACKAGES = Object.freeze(['react-router', 'react-router-dom']);

function sorted(values) {
  return [...values].sort();
}

function sameStrings(actual, expected) {
  const left = sorted(actual);
  const right = sorted(expected);
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function validateReleaseAudit(report, { now = Date.now() } = {}) {
  if (!report || report.auditReportVersion !== 2 || !report.vulnerabilities || !report.metadata?.vulnerabilities) {
    throw new Error('npm audit did not return the expected version-two report.');
  }
  const counts = report.metadata.vulnerabilities;
  if (counts.high !== 0 || counts.critical !== 0) {
    throw new Error('Release audit contains a high or critical vulnerability.');
  }
  if (!Number.isFinite(now) || now > Date.parse(REACT_ROUTER_EXCEPTION_EXPIRES_AT)) {
    throw new Error('The reviewed React Router moderate exception has expired.');
  }

  const moderateEntries = Object.values(report.vulnerabilities)
    .filter((entry) => entry?.severity === 'moderate');
  const moderatePackages = moderateEntries.map((entry) => entry.name);
  if (counts.moderate !== ALLOWED_MODERATE_PACKAGES.length || !sameStrings(moderatePackages, ALLOWED_MODERATE_PACKAGES)) {
    throw new Error('Release audit contains a new, removed, or renamed moderate vulnerability package.');
  }
  const advisoryUrls = new Set();
  for (const entry of moderateEntries) {
    for (const cause of entry.via || []) {
      if (typeof cause === 'object' && cause?.severity === 'moderate' && typeof cause.url === 'string') {
        advisoryUrls.add(cause.url);
      }
    }
  }
  if (!sameStrings(advisoryUrls, ALLOWED_MODERATE_ADVISORIES)) {
    throw new Error('Release audit moderate advisories do not match the reviewed React Router allowlist.');
  }
  return {
    advisoryCount: advisoryUrls.size,
    expiresAt: REACT_ROUTER_EXCEPTION_EXPIRES_AT,
    moderatePackageCount: moderateEntries.length
  };
}
