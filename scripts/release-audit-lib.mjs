export function validateReleaseAudit(report) {
  if (!report || report.auditReportVersion !== 2 || !report.vulnerabilities || !report.metadata?.vulnerabilities) {
    throw new Error('npm audit did not return the expected version-two report.');
  }
  const counts = report.metadata.vulnerabilities;
  if (counts.moderate !== 0 || counts.high !== 0 || counts.critical !== 0) {
    throw new Error('Release audit contains a moderate, high, or critical vulnerability.');
  }

  return {
    lowCount: counts.low
  };
}
