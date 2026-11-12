# Service enrollment configuration

The app reads the seven names declared in `.cogni/secrets-catalog.yaml`. The deployment resolver unions the app profile keys with catalog keys whose `workloads` includes `app`. It then projects those keys from the owning control vault's explicit lane. Repo-spec `secret_refs` is retired on the serving operator; do not add it.

`SERVICE_ENROLLMENT_ORIGIN` is this lane's exact HTTPS origin. `SERVICE_ENROLLMENT_ENVIRONMENT` is its explicit environment. `SERVICE_LINK_TARGETS` is a JSON object from an app alias to `{nodeId,environment,origin}`. Each origin is HTTPS and contains no path. The shared requester verifies the target discovery tuple and credential ceilings before reserving a new intent. No runtime derives trust from a hostname.

`SERVICE_ENROLLMENT_TRUSTED_HOMES` is a JSON array. Each entry contains `{nodeId,environment,origin,kids,services}`. `kids` lists approved Ed25519 public key ids. `services` maps a service slug to its allowed scopes. For example, the requester scopes remain `knowledge:read`. Set the actual node and lane values through authorized setup; this file contains no trust values or defaults.

A legacy issuer/service identity has no stored environment. Set `reconcileLegacy:true` on exactly one reviewed home entry for that issuer/service only after checking historical verified receipt/link evidence for that deployment. The shared provider requires matching receipt evidence and preserves the old marker, user and grants while filling its tuple. Missing or ambiguous mapping fails closed. An already backfilled tuple resolves directly. Never infer an environment or move grants to a new principal.

`SERVICE_ENROLLMENT_SIGNING_JWK` is a private Ed25519 JWK and `SERVICE_ENROLLMENT_SIGNING_KID` is its public id. The catalog has no Ed25519 generator, so authorized setup must generate and submit the JWK through a protected input path. Do not put it in chat, Git, command arguments or logs. The app publishes only public fields at `/.well-known/jwks.json`. The remote admin must approve its exact tuple, key id and scopes before enrollment.

`CONNECTIONS_ENCRYPTION_KEY` projects the existing per-node custody key managed by the canonical materializer. The app accepts its canonical 32-byte base64 encoding and retained 64-character hex setup encoding. Do not mint or rotate a second key to enable service links; rotation requires existing connection migration and custody proof.

The public URL, environment, key id and registry are non-secret settings. Their existing deployment injection path is the same explicit per-lane catalog projection; their values do not become credentials by being carried there. The signing JWK and custody key remain secret. No catalog entry supplies a default or changes a stored value.

The parent owns `node.manage_secrets` authorization, value setup and activation. Follow [node secret setup](https://cognidao.org/knowledge/node-self-serve-secrets): verify custodian/lane, supply protected values, activate the selected source, then prove exact-SHA discovery, JWKS and authenticated service-link behavior. A catalog declaration or vault write is not runtime proof.
