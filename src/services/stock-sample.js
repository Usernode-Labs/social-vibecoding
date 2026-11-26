'use strict';

// The fixed sample photos the stock photo search route answers with until a
// real service is wired in (request #7042, the first part of #6457).
//
// Every row has the shape a real result will have, so an app written against
// the samples keeps working when real photos arrive. Nothing here is a real
// photo or a real person: the photographers are named "Sample Photographer
// ...", and every link is on example.com, a reserved address that loads
// nothing, so no made-up name is ever shown beside somebody's real picture.

const STOCK_PROVIDERS = Object.freeze(['pexels', 'pixabay']);

const STOCK_LICENSES = Object.freeze({
  pexels: 'Pexels License',
  pixabay: 'Pixabay Content License',
});

// One map of every code the route can answer with, so the version that calls
// real services reuses these instead of inventing its own. The three
// provider_* codes are not returned yet: nothing calls a provider.
const STOCK_ERRORS = Object.freeze({
  invalid_query: Object.freeze({ status: 400, message: 'q is required (1-100 characters).' }),
  invalid_provider: Object.freeze({ status: 400, message: 'provider must be pexels, pixabay or all.' }),
  invalid_page: Object.freeze({ status: 400, message: 'page must be a whole number, 1 or more.' }),
  rate_limited: Object.freeze({ status: 429, message: 'Too many searches. Try again in a minute.' }),
  provider_not_configured: Object.freeze({ status: 503, message: 'This photo service is not set up.' }),
  provider_unavailable: Object.freeze({ status: 502, message: 'The photo service did not answer.' }),
  provider_rate_limited: Object.freeze({ status: 429, message: 'The photo service is busy. Try again later.' }),
});

const SAMPLE_BASE = 'https://example.com/stock-sample';

function sampleRow(provider, n, subject, photographer, width, height) {
  const key = `sample-${n}`;
  const base = `${SAMPLE_BASE}/${provider}/${key}`;
  return Object.freeze({
    id: `${provider}:${key}`,
    provider,
    thumbUrl: `${base}/thumb-${subject}.jpg`,
    previewUrl: `${base}/preview-${subject}.jpg`,
    originalUrl: `${base}/original-${subject}.jpg`,
    width,
    height,
    photographer: `Sample Photographer ${photographer}`,
    photographerUrl: `${SAMPLE_BASE}/${provider}/photographers/sample-${photographer.toLowerCase()}`,
    sourcePageUrl: `${base}/${subject}`,
    license: STOCK_LICENSES[provider],
  });
}

const STOCK_SAMPLE = Object.freeze([
  sampleRow('pexels', 1, 'mountain-lake', 'One', 4000, 2667),
  sampleRow('pexels', 2, 'coffee-cup', 'Two', 3000, 4000),
  sampleRow('pixabay', 1, 'city-street', 'Three', 5184, 3456),
  sampleRow('pexels', 3, 'bookshelf', 'Four', 3840, 2560),
  sampleRow('pixabay', 2, 'sunflower-field', 'Five', 6000, 4000),
  sampleRow('pexels', 4, 'bicycle', 'Six', 2400, 3600),
]);

module.exports = { STOCK_PROVIDERS, STOCK_LICENSES, STOCK_ERRORS, STOCK_SAMPLE };
