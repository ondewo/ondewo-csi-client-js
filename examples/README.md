# ONDEWO CSI Client JS — Examples

Minimal, idiomatic examples for the `@ondewo/ondewo-csi-client-js` gRPC-web client.

## `getS2sPipelineExample.js`

Fetches a single speech-to-speech (S2S) pipeline via the Conversations `GetS2sPipeline` unary RPC.
It demonstrates the three steps a consumer needs:

1. **Authenticate** — obtain a bearer token from the Keycloak offline-token provider
   (`auth/offlineTokenProvider`, headless ROPC + `offline_access` against the public SDK client).
2. **Construct the client** — `new ondewo_csi_api.ConversationsPromiseClient('<host>:<port>', null, null)`.
   In a browser the `ondewo_csi_api` namespace comes from the compiled bundle loaded via a `<script>`
   tag; in Node the `loadCsiApi()` helper evaluates the same bundle.
3. **Call an RPC** — attach `{ Authorization: 'Bearer <token>' }` metadata and read the response.

The RPC-calling logic (`getS2sPipeline`) takes its client, request class and auth provider as arguments,
so it is runnable in the browser and in Node, and unit-testable with the transport mocked.

### Run against a live endpoint (manual)

Configuration is read from `examples/environment.env` (loaded with `dotenv`). Copy your real values
into that file — it ships with non-secret placeholders — then run:

```shell
node examples/getS2sPipelineExample.js
```

The canonical variables the example reads:

```shell
ONDEWO_HOST=<envoy-host>
ONDEWO_PORT=<envoy-port>
KEYCLOAK_URL=https://<keycloak-host>/auth
KEYCLOAK_REALM=<realm>
KEYCLOAK_CLIENT_ID=<sdk-client-id>
KEYCLOAK_USER_NAME=<technical-user-email>
KEYCLOAK_PASSWORD=<password>
KEYCLOAK_VERIFY_SSL=true
ONDEWO_CSI_S2S_PIPELINE_ID=<pipeline-id>
```

### Test (no server, mocked transport)

```shell
node --test examples/getS2sPipelineExample.spec.js
```
