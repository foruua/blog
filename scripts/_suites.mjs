const SUITE_GROUPS = {
  media: ['test-media', 'test-avatar'],
  content: ['test-p2', 'test-admin', 'test-themes', 'test-search', 'test-page-cache', 'test-regressions', 'test-lifecycle', 'test-maintenance', 'test-minify', 'test-shell-consistency', 'test-audit-browser'],
  comments: ['test-comments', 'test-mail'],
  background: ['test-feeds', 'test-feed-dns', 'test-links', 'test-friends-links-improvements', 'test-background'],
  operations: ['test-backup', 'test-health', 'test-hardening', 'test-review', 'test-deploy-release', 'test-operations', 'test-monitor', 'test-mail-queue'],
  browser: ['test-pjax', 'test-palette'],
};

export const FUNCTIONAL_SUITES = Object.values(SUITE_GROUPS).flat();
export const BROWSER_SUITES = ['test-media-browser', 'test-popup-buttons', 'test-dialog-scroll',
  'test-lightbox', 'test-hero-a11y', 'test-ui-improvements', 'test-ui-contract'];
