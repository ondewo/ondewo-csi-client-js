// Copyright 2021-2026 ONDEWO GmbH
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//

/**
 * D18 headless-SDK auth helper (keycloak-migration-plan §7.8 + D18).
 *
 * One-time ROPC login (grant_type=password, scope=offline_access) against the PUBLIC SDK client
 * `ondewo-nlu-cai-sdk-public` (no client_secret -- Q1), then a bounded background loop that refreshes
 * the short-lived access token from the offline refresh token before it expires. The current access
 * token is exposed for an `Authorization: Bearer <token>` gRPC metadata header. The refresh loop stops
 * after `tokenExpirationInS` (if given) has elapsed since login.
 *
 * @module auth/offlineTokenProvider
 */

'use strict';

/* global URLSearchParams, setTimeout, clearTimeout, module */

/**
 * Seconds of head-room subtracted from a token's `expires_in` so the refresh fires before the access
 * token actually lapses (covers clock skew + the round-trip to Keycloak).
 *
 * @constant
 * @type {number}
 */
const REFRESH_SKEW_IN_S = 30;

/**
 * Lower bound for the scheduled refresh delay so a tiny/zero `expires_in` cannot spin a hot loop.
 *
 * @constant
 * @type {number}
 */
const MIN_REFRESH_DELAY_IN_S = 1;

/**
 * Minimal subset of the WHATWG `fetch` Response that {@link postTokenRequest} relies on.
 *
 * @typedef {object} FetchResponse
 * @property {boolean} ok
 *     `true` when the HTTP status is in the 2xx range.
 * @property {number} status
 *     The numeric HTTP status code.
 * @property {() => Promise<string>} text
 *     Resolves to the raw response body as text.
 */

/**
 * A `fetch`-compatible function. Injected via `fetchImpl` so the token endpoint can be mocked in tests
 * (defaults to `globalThis.fetch`).
 *
 * @typedef {(url: string, init: object) => Promise<FetchResponse>} FetchImpl
 */

/**
 * Parsed Keycloak OIDC token-endpoint response. Only the fields this helper consumes are typed; the
 * endpoint returns more (token_type, scope, ...).
 *
 * @typedef {object} TokenResponse
 * @property {string} access_token
 *     The short-lived bearer access token.
 * @property {string} [refresh_token]
 *     The (offline) refresh token; absent on a refresh that does not rotate it.
 * @property {number} [expires_in]
 *     Lifetime of `access_token` in seconds, as reported by Keycloak.
 */

/**
 * Construction options shared by {@link OfflineTokenProvider} and {@link login}.
 *
 * @typedef {object} OfflineTokenProviderOptions
 * @property {string} keycloakUrl
 *     Base Keycloak URL; a trailing slash and an optional baked-in `/auth` path are tolerated.
 * @property {string} realm
 *     The realm whose token endpoint is targeted.
 * @property {string} clientId
 *     The PUBLIC SDK client id (e.g. `ondewo-nlu-cai-sdk-public`), sent as `client_id` with no secret.
 * @property {number} [tokenExpirationInS]
 *     Optional bound, in seconds since login, after which the auto-refresh loop stops renewing.
 * @property {FetchImpl} [fetchImpl]
 *     Optional `fetch` implementation; defaults to `globalThis.fetch`.
 * @property {() => number} [nowInMs]
 *     Optional millisecond clock; defaults to `Date.now`. Injected for deterministic tests.
 */

/**
 * The full {@link login} options: {@link OfflineTokenProviderOptions} plus the ROPC credentials.
 *
 * @typedef {OfflineTokenProviderOptions & { username: string, password: string }} LoginOptions
 */

/**
 * Error raised on any token-endpoint or token-shape failure (non-2xx response, non-JSON body, missing
 * `access_token`/`refresh_token`, invalid options, or reading the header before a token exists).
 *
 * @augments Error
 */
class TokenError extends Error {
	/**
	 * @param {string} message
	 *     Human-readable description of the failure.
	 */
	constructor(message) {
		super(message);
		/** @type {string} */
		this.name = 'TokenError';
	}
}

/**
 * Build the OIDC token endpoint URL for a realm, tolerating a trailing slash on `keycloakUrl` and an
 * optional `/auth` relative path already baked into it.
 *
 * @param {string} keycloakUrl
 *     Base Keycloak URL (trailing slashes are stripped).
 * @param {string} realm
 *     Realm name; URL-encoded into the path.
 * @returns {string}
 *     The fully-qualified `.../realms/<realm>/protocol/openid-connect/token` endpoint URL.
 */
function buildTokenEndpoint(keycloakUrl, realm) {
	const base = keycloakUrl.replace(/\/+$/, '');
	return `${base}/realms/${encodeURIComponent(realm)}/protocol/openid-connect/token`;
}

/**
 * POST an `application/x-www-form-urlencoded` body to the token endpoint and return the parsed JSON.
 *
 * @param {string} tokenEndpoint
 *     The OIDC token endpoint URL to POST to.
 * @param {Record<string, string>} params
 *     Form fields to URL-encode into the request body (e.g. grant_type, client_id, ...).
 * @param {FetchImpl} fetchImpl
 *     The `fetch` implementation used to perform the request.
 * @returns {Promise<TokenResponse>}
 *     The parsed token response, guaranteed to carry a non-empty `access_token`.
 * @throws {TokenError}
 *     On a non-2xx response, an unparseable (non-JSON) body, or a body without an `access_token`.
 */
async function postTokenRequest(tokenEndpoint, params, fetchImpl) {
	const body = new URLSearchParams(params).toString();
	const response = await fetchImpl(tokenEndpoint, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			Accept: 'application/json'
		},
		body
	});
	const text = await response.text();
	if (!response.ok) {
		throw new TokenError(`Keycloak token endpoint returned HTTP ${response.status}: ${text}`);
	}
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new TokenError(`Keycloak token endpoint returned a non-JSON body: ${text}`);
	}
	if (typeof parsed.access_token !== 'string' || parsed.access_token.length === 0) {
		throw new TokenError('Keycloak token response did not contain an access_token');
	}
	return parsed;
}

/**
 * A live access-token holder backed by a bounded auto-refresh loop. Obtain one from {@link login};
 * read {@link OfflineTokenProvider#getAuthorizationHeader} for the gRPC `Authorization` metadata and
 * call {@link OfflineTokenProvider#stop} when done.
 */
class OfflineTokenProvider {
	/**
	 * @param {OfflineTokenProviderOptions} options
	 *     Provider configuration (see {@link OfflineTokenProviderOptions}).
	 */
	constructor(options) {
		/** @type {string} The resolved OIDC token endpoint URL. */
		this.tokenEndpoint = buildTokenEndpoint(options.keycloakUrl, options.realm);
		/** @type {string} The PUBLIC SDK client id sent as `client_id`. */
		this.clientId = options.clientId;
		/** @type {number | undefined} Optional bound, in seconds, after which the loop stops renewing. */
		this.tokenExpirationInS = options.tokenExpirationInS;
		/** @type {FetchImpl} The `fetch` implementation (injected or `globalThis.fetch`). */
		this.fetchImpl = options.fetchImpl !== undefined ? options.fetchImpl : globalThis.fetch;
		/** @type {() => number} The millisecond clock (injected or `Date.now`). */
		this.nowInMs = options.nowInMs !== undefined ? options.nowInMs : Date.now;
		/** @type {string | null} The current access token, or null before bootstrap / after lapse. */
		this.accessToken = null;
		/** @type {string | null} The current offline refresh token, or null before bootstrap. */
		this.refreshToken = null;
		/** @type {ReturnType<typeof setTimeout> | null} The armed refresh timer, or null when idle. */
		this.timer = null;
		/** @type {boolean} Whether {@link OfflineTokenProvider#stop} has been called. */
		this.stopped = false;
		/** @type {number | null} The bounded-loop deadline in epoch ms, or null when unbounded. */
		this.deadlineInMs = null;
		/** @type {((error: unknown) => void) | null} Optional background-refresh error handler. */
		this.onRefreshErrorHandler = null;
	}

	/**
	 * Perform the one-time ROPC login and arm the first refresh. Awaited by {@link login}.
	 *
	 * @param {string} username
	 *     The resource-owner username (e.g. the technical-user email).
	 * @param {string} password
	 *     The resource-owner password.
	 * @returns {Promise<void>}
	 *     Resolves once the access token is stored and the first refresh is scheduled.
	 * @throws {TokenError}
	 *     On a token-endpoint failure (see {@link postTokenRequest}) or a response without a
	 *     `refresh_token` (the SDK client lacks directAccessGrants + the offline_access scope).
	 */
	async bootstrap(username, password) {
		const tokenResponse = await postTokenRequest(
			this.tokenEndpoint,
			{
				grant_type: 'password',
				client_id: this.clientId,
				username,
				password,
				scope: 'offline_access'
			},
			this.fetchImpl
		);
		this.accessToken = tokenResponse.access_token;
		this.refreshToken = typeof tokenResponse.refresh_token === 'string' ? tokenResponse.refresh_token : null;
		if (this.refreshToken === null) {
			throw new TokenError(
				'Keycloak token response did not contain a refresh_token; the SDK client must have ' +
					'directAccessGrants + the offline_access scope (ondewo-nlu-cai-sdk-public)'
			);
		}
		if (this.tokenExpirationInS !== undefined) {
			const expirationInMs = this.tokenExpirationInS * 1000;
			this.deadlineInMs = this.nowInMs() + expirationInMs;
		}
		this.scheduleRefresh(tokenResponse.expires_in);
	}

	/**
	 * Exchange the offline refresh token for a fresh access token and re-arm the next refresh. No-op if
	 * the provider was stopped, or if the bounded deadline has already elapsed (which stops the loop).
	 *
	 * @returns {Promise<void>}
	 *     Resolves once the token is refreshed and the next refresh is scheduled (or the loop stops).
	 * @throws {TokenError}
	 *     On a token-endpoint failure during the refresh exchange (see {@link postTokenRequest}).
	 */
	async refresh() {
		if (this.stopped) {
			return;
		}
		// Re-check the bounded deadline at fire time (not just at schedule time): once it has elapsed the
		// loop stops with no further renewal -> the access token lapses -> re-login is required.
		if (this.deadlineInMs !== null && this.nowInMs() >= this.deadlineInMs) {
			this.stop();
			return;
		}
		const tokenResponse = await postTokenRequest(
			this.tokenEndpoint,
			{
				grant_type: 'refresh_token',
				client_id: this.clientId,
				refresh_token: this.refreshToken
			},
			this.fetchImpl
		);
		this.accessToken = tokenResponse.access_token;
		// Keycloak may rotate the offline refresh token; keep the newest one when present.
		if (typeof tokenResponse.refresh_token === 'string' && tokenResponse.refresh_token.length > 0) {
			this.refreshToken = tokenResponse.refresh_token;
		}
		this.scheduleRefresh(tokenResponse.expires_in);
	}

	/**
	 * Arm a single timer for the next refresh, clamped to the bounded deadline. Stops silently once
	 * `tokenExpirationInS` has elapsed (no further renewal -> access lapses -> re-login required).
	 *
	 * @param {number | undefined} expiresInRaw
	 *     The `expires_in` (seconds) from the token response; a non-positive/absent value falls back to
	 *     {@link MIN_REFRESH_DELAY_IN_S}. {@link REFRESH_SKEW_IN_S} is subtracted as head-room.
	 * @returns {void}
	 */
	scheduleRefresh(expiresInRaw) {
		if (this.stopped) {
			return;
		}
		const expiresInS = typeof expiresInRaw === 'number' && expiresInRaw > 0 ? expiresInRaw : MIN_REFRESH_DELAY_IN_S;
		let delayInS = Math.max(expiresInS - REFRESH_SKEW_IN_S, MIN_REFRESH_DELAY_IN_S);
		if (this.deadlineInMs !== null) {
			const remainingInMs = this.deadlineInMs - this.nowInMs();
			if (remainingInMs <= 0) {
				this.stop();
				return;
			}
			delayInS = Math.min(delayInS, remainingInMs / 1000);
		}
		this.timer = setTimeout(() => {
			this.refresh().catch((refreshError) => {
				// Swallow a transient refresh failure but surface it so the caller can react; the next
				// gRPC call gets the stale (possibly expired) token and re-logs in on UNAUTHENTICATED.
				if (this.onRefreshErrorHandler !== null) {
					this.onRefreshErrorHandler(refreshError);
				}
			});
		}, delayInS * 1000);
		// Do not keep the event loop alive solely for the refresh timer.
		// c8 ignore next -- defensive: Node's real setTimeout always returns a Timeout exposing unref(); the
		// non-function branch is unreachable here and only guards against exotic non-Node shims.
		if (typeof this.timer.unref === 'function') {
			this.timer.unref();
		}
	}

	/**
	 * Register a callback invoked with the error of a failed background refresh (optional diagnostics).
	 *
	 * @param {(error: unknown) => void} handler
	 *     Called with the thrown error each time a background refresh fails.
	 * @returns {void}
	 */
	onRefreshError(handler) {
		this.onRefreshErrorHandler = handler;
	}

	/**
	 * The current access token, or null before bootstrap / after the bounded loop has lapsed.
	 *
	 * @returns {string | null}
	 */
	getAccessToken() {
		return this.accessToken;
	}

	/**
	 * The value for an `Authorization` gRPC metadata header: `Bearer <access_token>`.
	 *
	 * @returns {string}
	 *     The `Bearer <access_token>` header value.
	 * @throws {TokenError}
	 *     When no access token is available (login() has not completed or the bounded loop has lapsed).
	 */
	getAuthorizationHeader() {
		if (this.accessToken === null) {
			throw new TokenError('No access token available; login() has not completed or has lapsed');
		}
		return `Bearer ${this.accessToken}`;
	}

	/**
	 * Stop the auto-refresh loop. Idempotent; safe to call from any state.
	 *
	 * @returns {void}
	 */
	stop() {
		this.stopped = true;
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}
}

/**
 * One-time ROPC + offline_access login against the PUBLIC SDK client, returning a live token provider
 * whose access token is auto-refreshed in the background until `tokenExpirationInS` elapses.
 *
 * @param {LoginOptions} options
 *     The login configuration and ROPC credentials (see {@link LoginOptions}).
 * @returns {Promise<OfflineTokenProvider>}
 *     A bootstrapped provider with a live access token and an armed background refresh loop.
 * @throws {TokenError}
 *     When `options` is missing, a required string option is empty, or the underlying token-endpoint
 *     call fails (see {@link OfflineTokenProvider#bootstrap}).
 */
async function login(options) {
	if (options === undefined || options === null) {
		throw new TokenError('login() requires an options object');
	}
	const requiredKeys = ['keycloakUrl', 'realm', 'clientId', 'username', 'password'];
	for (const key of requiredKeys) {
		const value = options[key];
		if (typeof value !== 'string' || value.length === 0) {
			throw new TokenError(`login() option "${key}" is required and must be a non-empty string`);
		}
	}
	const provider = new OfflineTokenProvider(options);
	await provider.bootstrap(options.username, options.password);
	return provider;
}

/**
 * Public surface of the D18 offline-token helper.
 *
 * @type {{ TokenError: typeof TokenError, OfflineTokenProvider: typeof OfflineTokenProvider, login: typeof login }}
 */
module.exports = { TokenError, OfflineTokenProvider, login };
