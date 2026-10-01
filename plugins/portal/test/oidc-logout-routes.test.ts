import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { deriveKey, seal } from "../src/session.ts";

let available = true;
let requests = 0;
const idp = createServer((_req, res) => {
  requests++;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ issuer, ...(available ? { end_session_endpoint: `${issuer}/logout` } : {}) }));
});
await new Promise<void>((resolve) => idp.listen(0, "127.0.0.1", resolve));
const issuer = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
const origin = "http://127.0.0.1:19996";
const secret = "logout-route-fixture-secret-at-least-32-characters";
Object.assign(process.env, {
  NODE_ENV: "test",
  PORTAL_PUBLIC_URL: origin,
  PORTAL_SESSION_SECRET: secret,
  CORE_ORG_ID: "logout",
  CORE_API_URL: issuer,
  OIDC_ISSUER: issuer,
  OIDC_AUTH_ENDPOINT: `${issuer}/authorize`,
  OIDC_CLIENT_ID: "primary-client",
  PORTAL_LOCAL_AUTH_BYPASS: "0",
  AUTH_BROKER_UPSTREAM: "",
  PORTAL_TRUSTED_OIDC: JSON.stringify({
    issuer,
    authEndpoint: `${issuer}/authorize`,
    tokenEndpoint: `${issuer}/token`,
    userinfoEndpoint: `${issuer}/userinfo`,
    jwksUri: `${issuer}/jwks`,
    clientId: "trusted-client",
  }),
  PORTAL_TRUSTED_OIDC_CLIENT_SECRET: "synthetic-trusted-secret-at-least-32-characters",
});
const { server } = await import("../src/index.ts");
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => {
  server.close();
  idp.close();
});
function cookie(extra: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return `portal_session=${seal({ k: "session", sub: "fixture", org: "logout", iat: now, exp: now + 3600, ...extra }, deriveKey(secret, "portal.session.v1"))}`;
}
async function logout(extra: Record<string, unknown> = {}, html = false) {
  return fetch(`${base}/auth/logout?returnTo=https://evil.example`, {
    method: "POST",
    redirect: "manual",
    headers: { origin, cookie: cookie(extra), accept: html ? "text/html" : "application/json" },
  });
}
test("primary and trusted sessions sharing an issuer retain their own client binding", async () => {
  for (const clientId of ["primary-client", "trusted-client"]) {
    const response = await logout({ oidcIssuer: issuer, oidcClientId: clientId });
    const result = (await response.json()) as { redirectTo: string };
    const url = new URL(result.redirectTo);
    assert.equal(url.searchParams.get("client_id"), clientId);
    assert.equal(url.searchParams.get("post_logout_redirect_uri"), `${origin}/auth/signed-out`);
    assert.ok(
      response.headers
        .getSetCookie()
        .some((value) => value.startsWith("portal_session=;") && value.includes("Max-Age=0")),
    );
  }
});
test("HTML logout uses the same provider destination", async () => {
  const response = await logout({ oidcIssuer: issuer, oidcClientId: "primary-client" }, true);
  assert.equal(response.status, 303);
  assert.equal(new URL(response.headers.get("location")!).searchParams.get("client_id"), "primary-client");
});
test("legacy and unconfigured bindings stop locally without guessing an external provider", async () => {
  for (const extra of [
    {},
    { oidcIssuer: issuer },
    { oidcIssuer: issuer, oidcClientId: "removed-client" },
    { oidcIssuer: "https://evil.example", oidcClientId: "primary-client" },
  ]) {
    const result = (await (await logout(extra)).json()) as { redirectTo: string };
    assert.equal(result.redirectTo, "/auth/signed-out");
  }
});
test("missing end-session support clears cookies and falls back locally", async () => {
  available = false;
  const response = await logout({ oidcIssuer: issuer, oidcClientId: "primary-client" });
  assert.equal(((await response.json()) as { redirectTo: string }).redirectTo, "/auth/signed-out");
  for (const name of [
    "portal_session",
    "portal_session_x",
    "portal_oidc_tmp",
    "portal_trusted_tmp",
    "portal_impersonate",
  ])
    assert.ok(
      response.headers.getSetCookie().some((value) => value.startsWith(`${name}=;`) && value.includes("Max-Age=0")),
    );
  available = true;
});
test("anonymous sessions never initiate provider logout", async () => {
  const before = requests;
  const result = (await (await logout({ anon: true, oidcIssuer: issuer, oidcClientId: "primary-client" })).json()) as {
    redirectTo: string;
  };
  assert.equal(result.redirectTo, "/");
  assert.equal(requests, before);
});
test("signed-out landing does not falsely claim an authenticated session ended", async () => {
  const signedIn = await fetch(`${base}/auth/signed-out`, { headers: { cookie: cookie() } });
  assert.equal(signedIn.status, 409);
  assert.match(await signedIn.text(), /Still signed in/);
  const signedOut = await fetch(`${base}/auth/signed-out`);
  assert.equal(signedOut.status, 200);
  assert.match(await signedOut.text(), /You have signed out of this portal/);
});
