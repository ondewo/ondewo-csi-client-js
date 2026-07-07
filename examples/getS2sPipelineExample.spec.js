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
 * Unit tests for the CSI `GetS2sPipeline` example. The gRPC transport is replaced by a mock client --
 * there is NO network access and NO running CSI server. The request and response use the REAL generated
 * message classes (loaded from the compiled bundle) so the example is exercised against the same stubs a
 * real consumer would use.
 *
 *     node --test examples/getS2sPipelineExample.spec.js
 *
 * @module examples/getS2sPipelineExample.spec
 */

'use strict';

/* global require */

const { test: runTestCase } = require('node:test');
const assert = require('node:assert/strict');

const { getS2sPipeline, loadCsiApi } = require('./getS2sPipelineExample');

/**
 * The real generated CSI namespace (`S2sPipelineId`, `S2sPipeline`, ...), loaded once for all cases.
 *
 * @type {object}
 */
const csiApi = loadCsiApi();

/**
 * The pipeline id used as both the request input and the expected round-tripped value.
 *
 * @type {string}
 */
const PIPELINE_ID = 's2s-pipeline-42';

/**
 * The access token the stub auth provider hands out; the example must attach it as a Bearer header.
 *
 * @type {string}
 */
const ACCESS_TOKEN = 'access-token-xyz';

/**
 * One recorded `getS2sPipeline` invocation seen by the mock client.
 *
 * @typedef {object} RecordedCall
 * @property {object} request
 *     The request message the example built and passed to the RPC.
 * @property {Record<string, string>} metadata
 *     The gRPC metadata the example attached (expected to carry the Authorization header).
 */

/**
 * Build a mock `ConversationsPromiseClient` that records each `getS2sPipeline` call and resolves with a
 * caller-supplied response -- no transport, no network.
 *
 * @param {object} response
 *     The `S2sPipeline` message the mocked RPC resolves with.
 * @returns {{ conversationsClient: { getS2sPipeline: (request: object, metadata: Record<string, string>) => Promise<object> }, calls: RecordedCall[] }}
 *     The mock client and the log of calls it received.
 */
function makeConversationsClientStub(response) {
	/** @type {RecordedCall[]} */
	const calls = [];
	const conversationsClient = {
		getS2sPipeline: (request, metadata) => {
			calls.push({ request, metadata });
			return Promise.resolve(response);
		}
	};
	return { conversationsClient, calls };
}

/**
 * A stub bearer-token provider returning a fixed `Authorization` header value.
 *
 * @returns {{ getAuthorizationHeader: () => string }}
 *     A provider exposing the same `getAuthorizationHeader` surface the example depends on.
 */
function makeAuthProviderStub() {
	return {
		getAuthorizationHeader: () => `Bearer ${ACCESS_TOKEN}`
	};
}

runTestCase(
	'getS2sPipeline builds a real S2sPipelineId request, attaches the Bearer header, and returns the response',
	/**
	 * Asserts the happy path: exactly one RPC call, the request is a real generated `S2sPipelineId`
	 * carrying the requested id, the Bearer auth metadata is attached, and the resolved response is
	 * passed through and readable.
	 *
	 * @returns {Promise<void>}
	 */
	async () => {
		const response = new csiApi.S2sPipeline();
		response.setId(PIPELINE_ID);
		const stub = makeConversationsClientStub(response);

		const pipeline = await getS2sPipeline({
			conversationsClient: stub.conversationsClient,
			S2sPipelineId: csiApi.S2sPipelineId,
			authProvider: makeAuthProviderStub(),
			pipelineId: PIPELINE_ID
		});

		assert.equal(stub.calls.length, 1);
		assert.ok(stub.calls[0].request instanceof csiApi.S2sPipelineId);
		assert.equal(stub.calls[0].request.getId(), PIPELINE_ID);
		assert.deepEqual(stub.calls[0].metadata, { Authorization: `Bearer ${ACCESS_TOKEN}` });
		assert.equal(pipeline, response);
		assert.equal(pipeline.getId(), PIPELINE_ID);
	}
);

runTestCase(
	'getS2sPipeline surfaces an auth-provider failure and never calls the RPC',
	/**
	 * Asserts that when the auth provider cannot supply a header (e.g. login has not completed), the
	 * error propagates and the RPC is not invoked.
	 *
	 * @returns {Promise<void>}
	 */
	async () => {
		const stub = makeConversationsClientStub(new csiApi.S2sPipeline());
		const failingAuthProvider = {
			getAuthorizationHeader: () => {
				throw new Error('no access token available');
			}
		};

		await assert.rejects(
			getS2sPipeline({
				conversationsClient: stub.conversationsClient,
				S2sPipelineId: csiApi.S2sPipelineId,
				authProvider: failingAuthProvider,
				pipelineId: PIPELINE_ID
			}),
			/no access token available/
		);
		assert.equal(stub.calls.length, 0);
	}
);
