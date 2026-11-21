<div align="center">
  <table>
    <tr>
      <td>
        <a href="https://ondewo.com/en/products/natural-language-understanding/">
            <img width="400px" src="https://raw.githubusercontent.com/ondewo/ondewo-logos/master/ondewo_we_automate_your_phone_calls.png"/>
        </a>
      </td>
    </tr>
    <tr>
       <td align="center">
          <a href="https://www.linkedin.com/company/ondewo "><img width="40px" src="https://cdn-icons-png.flaticon.com/512/3536/3536505.png"></a>
          <a href="https://www.facebook.com/ondewo"><img width="40px" src="https://cdn-icons-png.flaticon.com/512/733/733547.png"></a>
          <a href="https://twitter.com/ondewo"><img width="40px" src="https://cdn-icons-png.flaticon.com/512/733/733579.png"> </a>
          <a href="https://www.instagram.com/ondewo.ai/"><img width="40px" src="https://cdn-icons-png.flaticon.com/512/174/174855.png"></a>
          <a href="https://badge.fury.io/js/%40ondewo%2Fondewo-csi-client-js"><img src="https://badge.fury.io/js/%40ondewo%2Fondewo-csi-client-js.svg" alt="npm version" height="32"></a>
       </td>
    </tr>
  </table>
  <h1 align="center">
    ONDEWO CSI Client Javascript
  </h1>
</div>

## Overview

`@ondewo/csi-client-js` is a compiled version of the [ONDEWO CSI API](https://github.com/ondewo/ondewo-csi-api) using the [ONDEWO PROTO COMPILER](https://github.com/ondewo/ondewo-proto-compiler). Here you can find the CSI API [documentation](https://ondewo.github.io).

ONDEWO APIs use [Protocol Buffers](https://github.com/google/protobuf) version 3 (proto3) as their Interface Definition Language (IDL) to define the API interface and the structure of the payload messages. The same interface definition is used for gRPC versions of the API in all languages.

## Setup

Using NPM:

```shell
npm i --save @ondewo/ondewo-csi-client-js
```

Using GitHub:

```shell
git clone https://github.com/ondewo/ondewo-csi-client-js.git ## Clone repository
cd ondewo-csi-client-js                                      ## Change into repo-directoy
make setup_developer_environment_locally                     ## Install dependencies
```

## Package structure

```
npm
├── api
│   ├── ondewo_csi_api.js
│   ├── ondewo_csi_api.min.js
│   └── ondewo_csi_api.min.js.map
├── auth
│   ├── grpcWebEndpoint.js
│   └── offlineTokenProvider.js
├── LICENSE
├── package.json
└── README.md
```

## Authentication (Keycloak bearer)

Auth is bearer-only. Every gRPC-web call must carry a short-lived Keycloak **bearer** access token in the `Authorization` metadata header.

Obtain and auto-refresh a token with the token provider shipped in `auth/offlineTokenProvider.js`. Start-up is ONE token request against the **public** SDK client `ondewo-nlu-cai-sdk-public` (no client secret), with one of two credentials:

- **a password**: a one-time ROPC login (`grant_type=password`, `scope=offline_access`) as a 2FA-exempt technical user;
- **a handed-off offline token** (`refreshToken`): one `grant_type=refresh_token` exchange. No password grant is ever sent on this path, not even as a fallback when the token is refused, so N processes sharing one technical user never trip Keycloak's brute-force detection. When both are set, `refreshToken` wins.

The access token is then refreshed 30 s before it expires, in the background and on demand, and both share ONE jittered backoff (5 s doubling up to 300 s): a failed refresh never ends the refresh loop and never causes a request storm, a token that is still valid keeps being served, and only an EXPIRED token whose refresh fails raises `KeycloakAuthenticationError` (a `TokenError` subclass; the underlying error is its `cause`). No error message or log line ever contains a password or a token.

```js
const {
    getKeycloakTokenProvider,
    createAuthUnaryInterceptor
} = require('@ondewo/ondewo-csi-client-js/auth/offlineTokenProvider');

// One provider (one login) per credential set, shared by every client that asks for it.
const provider = await getKeycloakTokenProvider({
    keycloakUrl: 'https://localhost:8443/auth',
    realm: 'ondewo-ccai-platform',
    clientId: 'ondewo-nlu-cai-sdk-public',
    username: 'tech-user@example.com',
    password: 'super-secret' // or, instead: refreshToken: '<a Keycloak offline refresh token>'
    // tokenExpirationInS: 3600, // optional: stop refreshing this long after start-up
    // logger: myLogger,         // optional: { warn, info, debug }; defaults to console
});

// Every unary call now awaits a fresh `authorization: Bearer <token>` header.
const client = new ConversationsPromiseClient('https://localhost:8443', null, {
    unaryInterceptors: [createAuthUnaryInterceptor(provider)]
});
const response = await client.getS2sPipeline(request);

// grpc-web stream interceptors are synchronous, so pass the metadata to a streaming call yourself:
const stream = client.someServerStreamingCall(request, await provider.getAuthorizationMetadata());

await provider.close(); // stop the background refresh (or provider.stop() without waiting)
```

`login(options)` takes the same options and returns an unshared provider. `getKeycloakTokenProvider` returns `null` when none of `keycloakUrl`, `realm`, `clientId` is set (no auth), and rejects a partial triple or a config with neither `password` nor `refreshToken`. `keycloakVerifySsl: false` (self-signed local Envoy only) is honoured under Node and ignored by browsers, which always verify. `redactLoginOptions(options)` gives a copy that is safe to log. `getAuthorizationHeader()` is kept for existing callers; it is synchronous and therefore never refreshes -- prefer `await getAuthorizationMetadata()`.

See `examples/getS2sPipelineExample.js` for a complete, unit-tested example.

## TLS, mutual TLS and certificates

This package talks **gRPC-web** (HTTP/1.1 or HTTP/2 through a gRPC-web proxy such as Envoy) from a **browser**. TLS is
therefore the browser's job: the browser negotiates TLS (never SSL), verifies the server certificate against its own
trust store, and, for mutual TLS, presents a client certificate from its own certificate store. JavaScript can neither
hand the browser a CA certificate nor a client certificate or private key, so this SDK accepts none of them.

The generated clients (e.g. `ConversationsPromiseClient`) take the endpoint URL as their first argument. Build it with
`buildGrpcWebEndpoint` from `auth/grpcWebEndpoint.js`, which picks the scheme from `useSecureChannel` and enforces the
rules below:

```js
const { buildGrpcWebEndpoint } = require('@ondewo/ondewo-csi-client-js/auth/grpcWebEndpoint');

const endpoint = buildGrpcWebEndpoint({ host: 'ondewo.example.com', port: 443 }); // 'https://ondewo.example.com:443'
const client = new ConversationsPromiseClient(endpoint, null, null);
```

| Mode                           | Options                             | What the browser does                                                 |
|--------------------------------|-------------------------------------|-----------------------------------------------------------------------|
| Plaintext (not for production) | `useSecureChannel: false`           | `http://`; `console.warn` names `host:port`                           |
| TLS with system roots          | `useSecureChannel: true` (default)  | `https://`; the server certificate must chain to a trusted CA         |
| TLS with a custom CA           | `useSecureChannel: true` (default)  | install the CA in the OS / browser trust store (not possible from JS) |
| Mutual TLS                     | `useSecureChannel: true` (default)  | offers a client certificate from its certificate store when asked     |

For mutual TLS the proxy requests the client certificate and the browser offers one from its certificate store (the
user picks it, or a managed-device policy selects it). Alternatively the proxy terminates the browser's TLS and uses
mutual TLS towards the ONDEWO server.

Rules `buildGrpcWebEndpoint` enforces:

- `grpcCert`, `grpcClientCert` and `grpcClientKey` (the field names the other ONDEWO SDKs use for PEM content) are
  **refused** with an error when non-empty: a private key must never be shipped to a browser, and a CA or client
  certificate passed from JavaScript would be silently ignored. Empty strings (or leaving them out) mean plain TLS.
  This also covers half a pair (only a certificate or only a key) and `useSecureChannel: false` with an identity.
- `useSecureChannel` must be a boolean (the string `'false'` is an error, not "secure").
- `host` is a bare host name or IP address: no scheme, no port (pass `port`), no path. A bare IPv6 literal is bracketed
  (`::1` becomes `https://[::1]:8443`); `[::1]` is kept. Without `port` the scheme's default port is used.
- Error messages name the option, never its value.

**Node.js:** the generated bundle sends its requests through the browser's `XMLHttpRequest`, which Node does not have,
so this package cannot make gRPC calls from Node (only `auth/offlineTokenProvider.js` runs there). For Node, and for
mutual TLS from code with PEM files, use [ondewo-csi-client-nodejs](https://github.com/ondewo/ondewo-csi-client-nodejs), which takes
`grpcCert` / `grpcClientCert` / `grpcClientKey` as described in its README.

**Channel options:** gRPC-web has no keepalive, ping, reconnect-backoff or message-size options; the browser manages the
connection. The keepalive / backoff defaults of the native ONDEWO SDKs do not apply here.

### Mutual TLS at the proxy (Envoy)

The gRPC-web proxy decides whether a client certificate is required. A minimal Envoy downstream TLS context:

```yaml
transport_socket:
  name: envoy.transport_sockets.tls
  typed_config:
    "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.DownstreamTlsContext
    require_client_certificate: true
    common_tls_context:
      tls_certificates:
        - certificate_chain: { filename: /etc/envoy/server.pem }
          private_key: { filename: /etc/envoy/server.key }
      validation_context:
        trusted_ca: { filename: /etc/envoy/ca.pem }
```

### A test PKI with openssl

A CA, a server certificate with SANs, and a client certificate with the `clientAuth` extended key usage, packed as
PKCS#12 for import into the browser / OS certificate store. For tests only: the keys are unencrypted.

```bash
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 365 \
  -subj "/CN=Test CA" -keyout ca.key -out ca.pem

printf 'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1\nextendedKeyUsage=serverAuth\n' > server.ext
openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -subj "/CN=localhost" -keyout server.key -out server.csr
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 365 \
  -extfile server.ext -out server.pem

printf 'extendedKeyUsage=clientAuth\n' > client.ext
openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -subj "/CN=my-client" -keyout client.key -out client.csr
openssl x509 -req -in client.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 365 \
  -extfile client.ext -out client.pem
openssl pkcs12 -export -in client.pem -inkey client.key -certfile ca.pem -out client.p12  # asks for an export password

chmod 600 *.key client.p12
openssl verify -CAfile ca.pem server.pem client.pem
```

Import `ca.pem` into the trust store and `client.p12` into the certificate store of the browser / OS (Firefox keeps its
own stores: Settings, Privacy & Security, Certificates). Envoy uses `server.pem` / `server.key` and trusts `ca.pem` for
its clients.

### TLS security notes

- Never bundle a private key, a PKCS#12 file or its password into a web application: everything shipped to a browser
  is public.
- The Keycloak tokens are secrets too: `JSON.stringify(provider)` and `console.log(provider)` of the token provider
  render both tokens as `***REDACTED***` (`getAuthorizationHeader()` still returns the real one). Do not log the
  `Authorization` metadata yourself.
- A page served over `https` cannot call an `http` endpoint (mixed content); keep `useSecureChannel: true` outside
  local development.

### TLS troubleshooting

gRPC-web reports a failed TLS handshake as a network error (status `UNAVAILABLE` / code 14, or `UNKNOWN` / code 2 with
"Http response at 400 or 500 level"); the cause is in the browser's developer tools (Network / Console tab):

- **`net::ERR_CERT_AUTHORITY_INVALID`** (Chrome) / **`SEC_ERROR_UNKNOWN_ISSUER`** (Firefox): the server certificate is
  not signed by a CA the browser trusts. Install the CA in the trust store, or use a publicly trusted certificate.
- **`net::ERR_CERT_COMMON_NAME_INVALID`**: the host in the URL is not in the certificate's subject alternative names.
  Connect by a name that is, or add the name / IP to the certificate.
- **`net::ERR_BAD_SSL_CLIENT_AUTH_CERT`** / **`SSL_ERROR_HANDSHAKE_FAILURE_ALERT`**: the proxy requires a client
  certificate and the browser offered none, or one the proxy's `trusted_ca` does not accept (signed by another CA, or
  missing the `clientAuth` extended key usage).
- **"Mixed Content" / `net::ERR_SSL_PROTOCOL_ERROR`**: an `https` page calling `http`, or `useSecureChannel: true`
  against a plaintext port.
- **CORS errors** are not TLS errors: the proxy must answer the gRPC-web preflight (`Access-Control-Allow-Origin`,
  `-Headers` including `authorization`, `x-grpc-web`, `content-type`).

[comment]: <> (START OF GITHUB README)

## Build

The `make build` command is dependent on 2 `repositories` and their speciefied `version`:

- [ondewo-csi-api](https://github.com/ondewo/ondewo-csi-api) -- `CSI_API_GIT_BRANCH` in `Makefile`
- [ondewo-proto-compiler](https://github.com/ondewo/ondewo-proto-compiler) -- `ONDEWO_PROTO_COMPILER_GIT_BRANCH` in `Makefile`

Other than creating the proto-code, `build` also installs the `dev-dependencies` and hands the generated files in `api/` from `root` back to the `current user` (in a container, without `sudo`).

> :white_check_mark: The js-compiler (version ~4.1.1) will prompt to download webpack -- write yes / y to finish the build

## GitHub Repository - Release Automation

The repository is published to GitHub and NPM by the Automated Release Process of ONDEWO.

TODO after PR merge:

- checkout master

  ```shell
  git checkout master
  ```

- pull newest state

  ```shell
  git pull
  ```

- Adjust `ONDEWO_CSI_VERSION` in the `Makefile` <br><br>
- Add new Release Notes to `src/RELEASE.md` in following format:

  ```
  ## Release ONDEWO CSI Js Client X.X.X    <----- Beginning of Notes

  ...<NOTES>...

  *****************                             <----- End of Notes
  ```

- release

  ```shell
  make ondewo_release
  ```

  `make ondewo_release` runs `spc`, loads `GITHUB_GH_TOKEN` and `NPM_AUTOMATION_TOKEN` from the
  `ondewo-devops-accounts` repository and deletes that clone again before the release starts (also when
  anything fails). Set `DEVOPS_ACCOUNT_DIR` to an existing clone to use it instead of cloning one; the release
  driver in `ondewo-csi-api` does. `make release` then runs, in this order (pinned by
  `tests/releaseCredentials.spec.js`):

1. `release_preflight` -- changes nothing and fails before anything is built: the host has `docker`, `make`,
   `git`, `perl` and `curl`; `src/RELEASE.md` has a non-empty `## Release ONDEWO CSI Js Client <version>`
   section; neither the tag nor `release/<version>` exists, locally or on origin; npm does not have the
   version yet; the npm token authenticates (`npm whoami`), the GitHub token may push to this repository, and
   `git push --dry-run` is accepted
2. `build` and `check_build` -- generate `api/` from the pinned `ondewo-csi-api` with the pinned
   `ondewo-proto-compiler`
3. `release_tests` -- `npm ci`, then the full `npm test` suite (auth, examples, the API surface derived from
   the protos, the release Makefile)
4. the pre-commit hooks, then a local commit `Preparing for Release <version>`
5. `check_tag_matches_package` -- every file npm would publish is committed and byte-equal at that commit
6. `npm publish` of `npm/`, then `check_npm_published` -- npm serves the version (retried)
7. `git push`, the release branch `release/<version>`, the tag `<version>`
8. the GitHub release, which refuses empty notes
9. `release_verify` -- origin has the tag, the GitHub release has a body, npm serves the version; it can also
   be run on its own after a release

The credentials reach only the steps that use them (the preflight, the publish, the GitHub release and
`release_verify`), each inside its own container; every other step runs with both removed from its
environment. A failure before step 6 leaves npm and origin untouched; after step 6, re-run only the failed
step. The host needs `docker`, `make`, `git`, `perl` and `curl`. `node`/`npm` and `pre-commit` are used
from the host when present, otherwise from the pinned tools image (`docker build --target tools -f
Dockerfile.utils .`); `gh` always runs in that image.

[comment]: <> (END OF GITHUB README)
