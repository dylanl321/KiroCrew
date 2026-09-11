/**
 * Shared aws-control fixtures for capture scripts: one healthy account with a
 * provisioned drive and a granted consent, the state every backup/drive frame
 * starts from. Capture scripts layer their scenario's own routes on top.
 */

export const ACC = '111122223333'
export const AWS_CONTROL_BASE = '/api/apps/aws-control'

const nullSummary = { storage: null, sites: null, tasks: null, costMonthToDate: null }

export const ACCOUNTS_FIXTURE = {
  accounts: [{
    account: ACC, name: 'prod-main', health: 'ok', summary: nullSummary,
    profiles: [
      { name: 'prod-main', region: 'us-west-2', kind: 'sso', identityOk: true, account: ACC, arn: `arn:aws:sts::${ACC}:assumed-role/Admin/dev`, detail: '', default: true },
    ],
  }],
  totals: { accounts: 1, profiles: 1, profilesHealthy: 1 },
  generatedAt: '2026-09-03T22:00:00Z',
}

const GiB = 1024 ** 3

export const DRIVE_FIXTURE = {
  exists: true, bucket: `kirocrew-drive-${ACC}-usw2`, region: 'us-west-2',
  usage: {
    bytes: 1.1 * GiB, objects: 42,
    sections: {
      drive: { objects: 30, bytes: 0.6 * GiB },
      library: { objects: 4, bytes: 0.1 * GiB },
      backup: { objects: 8, bytes: 0.4 * GiB },
    },
  },
}

export const consentFixture = (svc) => ({
  service: svc, serviceLabel: svc === 's3' ? 'Amazon S3' : 'AWS Cost Explorer',
  profile: 'prod-main', credentialSource: 'profile prod-main', region: 'us-west-2',
  account: ACC, arn: `arn:aws:sts::${ACC}:assumed-role/Admin/dev`,
  identityResolved: true, identityDetail: '', granted: true, reason: '',
  revokedOnAccountChange: false,
  grant: { account: ACC, region: 'us-west-2', profile: 'prod-main', granted_at: '2026-08-20T09:00:00Z' },
})
