module.exports = {
  ci: {
    collect: {
      staticDistDir: './dist',
      isSinglePageApplication: true,
      numberOfRuns: 3,
      url: ['http://localhost/', 'http://localhost/single-player'],
      settings: {
        chromeFlags: '--headless --no-sandbox --disable-dev-shm-usage',
        clearStorageTypes: ['all'],
        formFactor: 'mobile',
        screenEmulation: {
          mobile: true,
          width: 390,
          height: 844,
          deviceScaleFactor: 2,
          disabled: false
        },
        throttlingMethod: 'simulate'
      }
    },
    assert: {
      aggregationMethod: 'median-run',
      assertions: {
        'categories:performance': ['error', { minScore: 0.9 }],
        'categories:accessibility': ['error', { minScore: 0.95 }],
        'categories:best-practices': ['error', { minScore: 0.95 }],
        'largest-contentful-paint': ['error', { maxNumericValue: 2500 }],
        'cumulative-layout-shift': ['error', { maxNumericValue: 0.1 }],
        'total-blocking-time': ['error', { maxNumericValue: 200 }]
      }
    },
    upload: {
      target: 'filesystem',
      outputDir: './test-results/lighthouse'
    }
  }
};
