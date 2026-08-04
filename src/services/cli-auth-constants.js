'use strict';

const CLIENT_ID = 'social-vibecoding-cli';
const CLIENT_NAME = 'Social Vibecoding CLI';
const IDENTITY_SCOPE = 'rpc:identity:read';
const API_SCOPE = 'api:access';
const REQUIRED_SCOPES = Object.freeze([IDENTITY_SCOPE, API_SCOPE]);
const REQUIRED_SCOPE_TEXT = REQUIRED_SCOPES.join(' ');
const PRODUCTION_ORIGIN = 'https://social-vibecoding.usernodelabs.org';
const LOCAL_ORIGIN = 'http://localhost:3000';
const DEVICE_TTL_SECONDS = 600;
const ACCESS_TTL_SECONDS = 30 * 24 * 60 * 60;
const POLL_INTERVAL_SECONDS = 5;

module.exports = {
  CLIENT_ID,
  CLIENT_NAME,
  IDENTITY_SCOPE,
  API_SCOPE,
  REQUIRED_SCOPES,
  REQUIRED_SCOPE_TEXT,
  PRODUCTION_ORIGIN,
  LOCAL_ORIGIN,
  DEVICE_TTL_SECONDS,
  ACCESS_TTL_SECONDS,
  POLL_INTERVAL_SECONDS,
};
