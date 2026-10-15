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

// The SHIPPED BUNDLE must carry the API surface of the pinned ondewo-csi-api.
//
// `api/ondewo_csi_api.js` is what an npm consumer loads, so the services are checked there, not in the
// .proto source: a regeneration that never reached the bundle passes a source-level check and fails here.
// The expected services and RPCs are DERIVED from `src/ondewo-csi-api/ondewo/csi/*.proto`, so an API
// release that adds an RPC is checked without editing this file, and one that the bundle lacks fails.
// The bundle is a browser build that assigns a global, so it is evaluated inside a `vm` context and the
// global is read back out. The context provides no `require`: the embedded google-protobuf runtime has to
// decode a string by itself.
//
// Needs the api submodule: `git submodule update --init src/ondewo-csi-api`.
//   node --test tests/csiApiSurface.spec.js

'use strict';

const { test: runTestCase } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/** The generated, webpack-bundled API surface this package publishes. */
const BUNDLE_PATH = path.join(__dirname, '..', 'api', 'ondewo_csi_api.js');

/** The CSI protos of the pinned api submodule, the source the bundle is generated from. */
const CSI_PROTOS_DIR = path.join(__dirname, '..', 'src', 'ondewo-csi-api', 'ondewo', 'csi');

/** A representative gRPC-web endpoint; constructing a client opens no connection. */
const ENDPOINT = 'https://csi.example.com:443';

/**
 * Remove `//` and `/* *\/` comments, which mention `rpc`, `service` and `stream` in prose.
 *
 * @param {string} source
 *   The proto source.
 * @returns {string}
 *   The source without comments.
 */
function stripComments(source) {
	return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * Every RPC of every service declared in the CSI protos.
 *
 * @returns {{service: string, rpc: string, method: string, clientStreaming: boolean}[]}
 *   One entry per RPC; `method` is the gRPC-web client method name (lower camel case).
 */
function protoRpcs() {
	assert.ok(
		fs.existsSync(CSI_PROTOS_DIR),
		`${CSI_PROTOS_DIR} is missing: run \`git submodule update --init src/ondewo-csi-api\``
	);
	const rpcs = [];
	for (const file of fs.readdirSync(CSI_PROTOS_DIR).filter((name) => name.endsWith('.proto'))) {
		const source = stripComments(fs.readFileSync(path.join(CSI_PROTOS_DIR, file), 'utf8'));
		const servicePattern = /\bservice\s+(\w+)\s*\{/g;
		let service = servicePattern.exec(source);
		while (service !== null) {
			// The service body ends at the brace that balances its opening one (rpc options nest braces).
			let depth = 1;
			let index = servicePattern.lastIndex;
			while (depth > 0 && index < source.length) {
				if (source[index] === '{') {
					depth += 1;
				} else if (source[index] === '}') {
					depth -= 1;
				}
				index += 1;
			}
			const body = source.slice(servicePattern.lastIndex, index - 1);
			const rpcPattern = /\brpc\s+(\w+)\s*\(\s*(stream\s+)?[\w.]+\s*\)\s*returns\s*\(\s*(?:stream\s+)?[\w.]+\s*\)/g;
			let rpc = rpcPattern.exec(body);
			while (rpc !== null) {
				rpcs.push({
					service: service[1],
					rpc: rpc[1],
					method: rpc[1].charAt(0).toLowerCase() + rpc[1].slice(1),
					clientStreaming: rpc[2] !== undefined
				});
				rpc = rpcPattern.exec(body);
			}
			service = servicePattern.exec(source);
		}
	}
	return rpcs;
}

/**
 * Evaluate the browser bundle in an isolated context and hand back the global it defines.
 *
 * @returns {any} the `ondewo_csi_api` namespace object.
 */
function loadApiBundle() {
	const source = fs.readFileSync(BUNDLE_PATH, 'utf8');
	const context = { window: {}, global: {}, self: {} };
	context.globalThis = context;
	vm.createContext(context);
	vm.runInContext(source, context);
	assert.ok(context.ondewo_csi_api, 'the bundle did not define the ondewo_csi_api global');
	return context.ondewo_csi_api;
}

runTestCase('the protos declare the services and RPCs this suite pins by name', () => {
	// A premise: a parser that found nothing would make every derived test below vacuous.
	const rpcs = protoRpcs();
	const services = new Set(rpcs.map((entry) => entry.service));
	assert.ok(services.has('Conversations'), `no service Conversations parsed from ${CSI_PROTOS_DIR}`);
	assert.ok(rpcs.some((entry) => entry.rpc === 'GetS2sPipeline' && !entry.clientStreaming));
	assert.ok(rpcs.some((entry) => entry.rpc === 'S2sStream' && entry.clientStreaming));
});

runTestCase('every service has a callback and a promise client exposing every RPC gRPC-web can carry', () => {
	const api = loadApiBundle();
	const missing = [];
	for (const { service, method, clientStreaming } of protoRpcs()) {
		if (clientStreaming) {
			continue;
		}
		for (const flavour of ['Client', 'PromiseClient']) {
			const Client = api[`${service}${flavour}`];
			if (typeof Client !== 'function') {
				missing.push(`${service}${flavour}`);
				continue;
			}
			if (typeof new Client(ENDPOINT, null, null)[method] !== 'function') {
				missing.push(`${service}${flavour}.${method}`);
			}
		}
	}
	assert.deepEqual([...new Set(missing)], []);
});

runTestCase('no client exposes a client-streaming or bidirectional RPC, which gRPC-web cannot carry', () => {
	// gRPC-web supports unary and server streaming only, so the bidirectional S2sStream is absent.
	const api = loadApiBundle();
	const exposed = protoRpcs()
		.filter((entry) => entry.clientStreaming)
		.filter(
			(entry) => typeof new api[`${entry.service}PromiseClient`](ENDPOINT, null, null)[entry.method] !== 'undefined'
		)
		.map((entry) => `${entry.service}.${entry.method}`);
	assert.deepEqual(exposed, []);
});
