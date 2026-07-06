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
 * Minimal ONDEWO CSI (Communication System Integration) client example.
 *
 * It shows the three things a consumer needs to do: obtain a bearer token, construct the generated
 * gRPC-web Conversations client, and call a representative unary RPC (`GetS2sPipeline`) while attaching
 * the `Authorization: Bearer <token>` metadata header.
 *
 * The core logic lives in {@link getS2sPipeline}, whose collaborators (the generated client, the
 * request-message class and the auth provider) are injected so the same code runs in the browser, in
 * Node, and under unit tests with the transport mocked -- no live server required.
 *
 * @module examples/getS2sPipelineExample
 */

'use strict';

/* global require, module, process, __dirname */

const path = require('path');
const fs = require('fs');
const vm = require('vm');

/**
 * The public SDK Keycloak client id used for the headless ROPC + offline_access login (matches the
 * default in `auth/offlineTokenProvider`).
 *
 * @constant
 * @type {string}
 */
const DEFAULT_SDK_CLIENT_ID = 'ondewo-nlu-cai-sdk-public';

/**
 * Resolve the generated gRPC-web namespace (`ondewo_csi_api`) that carries the Conversations clients
 * and the CSI message classes (`ConversationsPromiseClient`, `S2sPipelineId`, ...).
 *
 * In a browser the compiled bundle is pulled in with a `<script>` tag and publishes the namespace on
 * the global `ondewo_csi_api`; when that global is present it is returned as-is. In Node (and in the
 * unit test) the same bundle is a webpack `libraryTarget: 'var'` file that does not set
 * `module.exports`, so it is evaluated in an isolated VM context and the assigned namespace returned.
 *
 * @returns {object}
 *     The `ondewo_csi_api` namespace.
 */
function loadCsiApi() {
	if (typeof globalThis.ondewo_csi_api !== 'undefined') {
		return globalThis.ondewo_csi_api;
	}
	const bundlePath = path.resolve(__dirname, '..', 'api', 'ondewo_csi_api.js');
	const source = fs.readFileSync(bundlePath, 'utf8');
	const sandbox = { console };
	sandbox.globalThis = sandbox;
	sandbox.window = sandbox;
	sandbox.self = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(`${source}\n;globalThis.__ondewo_csi_api = ondewo_csi_api;`, sandbox, {
		filename: 'ondewo_csi_api.js'
	});
	return sandbox.__ondewo_csi_api;
}

/**
 * Fetch a single speech-to-speech (S2S) pipeline by id via the Conversations `GetS2sPipeline` unary RPC.
 *
 * @param {object} deps
 * @param {{ getS2sPipeline: (request: object, metadata: Record<string, string>) => Promise<object> }} deps.conversationsClient
 *     A `ConversationsPromiseClient` (or a stand-in exposing the same `getS2sPipeline` method).
 * @param {new () => { setId: (id: string) => void }} deps.S2sPipelineId
 *     The generated `S2sPipelineId` request-message class.
 * @param {{ getAuthorizationHeader: () => string }} deps.authProvider
 *     A bearer-token provider (e.g. from `auth/offlineTokenProvider`) supplying the
 *     `Authorization: Bearer <token>` gRPC metadata header.
 * @param {string} deps.pipelineId
 *     The id of the S2S pipeline to fetch.
 * @returns {Promise<object>}
 *     The resolved `S2sPipeline` response message.
 */
async function getS2sPipeline({ conversationsClient, S2sPipelineId, authProvider, pipelineId }) {
	const request = new S2sPipelineId();
	request.setId(pipelineId);
	const metadata = { Authorization: authProvider.getAuthorizationHeader() };
	return conversationsClient.getS2sPipeline(request, metadata);
}

/**
 * Read a required environment variable, throwing a descriptive error when it is missing or blank so the
 * example fails fast with a clear message instead of an opaque downstream error.
 *
 * @param {string} name
 *     The canonical environment variable name (see `examples/environment.env`).
 * @returns {string}
 *     The non-empty value of the variable.
 * @throws {Error}
 *     When the variable is unset or empty.
 */
function requireEnv(name) {
	const value = process.env[name];
	if (typeof value !== 'string' || value.length === 0) {
		throw new Error(`Missing required environment variable ${name} (see examples/environment.env)`);
	}
	return value;
}

/**
 * Wire the real collaborators from environment configuration and run the example end-to-end against a
 * running CSI gRPC-web endpoint (reached through Envoy). Configuration is loaded from the
 * `examples/environment.env` dotenv file using the canonical `ONDEWO_*` / `KEYCLOAK_*` variable scheme.
 * Guarded by the `require.main === module` check below; it is never executed by the unit tests.
 *
 * @returns {Promise<void>}
 *     Resolves once the pipeline has been fetched and the auth refresh loop stopped.
 */
async function main() {
	require('dotenv').config({ path: path.join(__dirname, 'environment.env') });

	const { login } = require('../auth/offlineTokenProvider');
	const csiApi = loadCsiApi();

	const host = requireEnv('ONDEWO_HOST');
	const port = requireEnv('ONDEWO_PORT');
	const pipelineId = requireEnv('ONDEWO_CSI_S2S_PIPELINE_ID');
	const endpoint = `${host}:${port}`;

	console.log('START: getS2sPipelineExample');
	console.log(`Logging in to Keycloak at ${requireEnv('KEYCLOAK_URL')} (realm=${requireEnv('KEYCLOAK_REALM')})`);
	const authProvider = await login({
		keycloakUrl: requireEnv('KEYCLOAK_URL'),
		realm: requireEnv('KEYCLOAK_REALM'),
		clientId: process.env.KEYCLOAK_CLIENT_ID || DEFAULT_SDK_CLIENT_ID,
		username: requireEnv('KEYCLOAK_USER_NAME'),
		password: requireEnv('KEYCLOAK_PASSWORD'),
		keycloakVerifySsl: process.env.KEYCLOAK_VERIFY_SSL !== 'false'
	});
	console.log('Keycloak login succeeded; obtained bearer token');

	const conversationsClient = new csiApi.ConversationsPromiseClient(endpoint, null, null);
	try {
		console.log(`Calling GetS2sPipeline (id=${pipelineId}) at ${endpoint}`);
		const pipeline = await getS2sPipeline({
			conversationsClient,
			S2sPipelineId: csiApi.S2sPipelineId,
			authProvider,
			pipelineId
		});
		console.log(`DONE: fetched S2S pipeline id=${pipeline.getId()}`);
	} finally {
		authProvider.stop();
	}
}

/**
 * Public surface of the example: the injectable core logic and the Node bundle loader.
 *
 * @type {{ getS2sPipeline: typeof getS2sPipeline, loadCsiApi: typeof loadCsiApi }}
 */
module.exports = { getS2sPipeline, loadCsiApi };

if (require.main === module) {
	main().catch((error) => {
		if (error && typeof error.code !== 'undefined') {
			console.error(`getS2sPipelineExample failed: gRPC error code=${error.code} message=${error.message}`);
		} else {
			console.error('getS2sPipelineExample failed:', error);
		}
		process.exit(1);
	});
}
