#!/usr/bin/env python3
"""End-to-end smoke test for url-shortener-app (dev / ap-southeast-1)."""

from __future__ import annotations

import json
import os
import sys
import time
import uuid
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, Request, build_opener

import boto3

REGION = os.environ.get("AWS_REGION", "ap-southeast-1")
STAGE = os.environ.get("NX_STAGE", "dev")
TEST_EMAIL = f"e2e-{uuid.uuid4().hex[:8]}@example.com"
TEST_PASSWORD = "E2eTest1!"
LONG_URL = "https://example.com/e2e-" + uuid.uuid4().hex[:8]


class _NoRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_DEFAULT_OPENER = build_opener()
_NO_REDIRECT_OPENER = build_opener(_NoRedirectHandler())


@dataclass
class StepResult:
    name: str
    ok: bool
    detail: str
    ms: float | None = None


def http(
    method: str,
    url: str,
    *,
    token: str | None = None,
    body: dict | None = None,
    allow_redirects: bool = True,
) -> tuple[int, dict[str, str], bytes]:
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    req = Request(url, data=data, headers=headers, method=method)
    opener = _DEFAULT_OPENER.open if allow_redirects else _NO_REDIRECT_OPENER.open
    try:
        with opener(req) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except HTTPError as e:
        body_bytes = e.read() if e.fp else b""
        hdrs = dict(e.headers)
        return e.code, hdrs, body_bytes


def stack_outputs(cfn, stack_name: str) -> dict[str, str]:
    resp = cfn.describe_stacks(StackName=stack_name)
    return {o["OutputKey"]: o["OutputValue"] for o in resp["Stacks"][0].get("Outputs", [])}


def get_jwt(cognito, pool_id: str, client_id: str) -> tuple[str, str]:
    cognito.admin_create_user(
        UserPoolId=pool_id,
        Username=TEST_EMAIL,
        UserAttributes=[
            {"Name": "email", "Value": TEST_EMAIL},
            {"Name": "email_verified", "Value": "true"},
        ],
        MessageAction="SUPPRESS",
    )
    cognito.admin_set_user_password(
        UserPoolId=pool_id,
        Username=TEST_EMAIL,
        Password=TEST_PASSWORD,
        Permanent=True,
    )
    auth = cognito.admin_initiate_auth(
        UserPoolId=pool_id,
        ClientId=client_id,
        AuthFlow="ADMIN_USER_PASSWORD_AUTH",
        AuthParameters={"USERNAME": TEST_EMAIL, "PASSWORD": TEST_PASSWORD},
    )
    token = auth["AuthenticationResult"]["IdToken"]
    # Decode sub from JWT payload (middle segment, base64url).
    import base64

    payload = token.split(".")[1]
    payload += "=" * (-len(payload) % 4)
    claims = json.loads(base64.urlsafe_b64decode(payload))
    return token, claims["sub"]


def run() -> int:
    results: list[StepResult] = []
    cfn = boto3.client("cloudformation", region_name=REGION)
    cognito = boto3.client("cognito-idp", region_name=REGION)

    app_out = stack_outputs(cfn, f"url-shortener-app-bff-{STAGE}")
    redirect_out = stack_outputs(cfn, f"url-shortener-redirect-bff-{STAGE}")
    analytics_out = stack_outputs(cfn, f"url-shortener-analytics-bff-{STAGE}")

    app_api = app_out["ApiEndpoint"].rstrip("/")
    redirect_api = redirect_out["ApiEndpoint"].rstrip("/")
    analytics_api = analytics_out["ApiEndpoint"].rstrip("/")
    pool_id = app_out["UserPoolId"]
    client_id = app_out["UserPoolClientId"]

    print(f"Region: {REGION}  Stage: {STAGE}")
    print(f"app-bff:       {app_api}")
    print(f"redirect-bff:  {redirect_api}")
    print(f"analytics-bff: {analytics_api}")
    print()

    # --- Health checks ---
    for label, base in [
        ("app-bff GET /health", app_api),
        ("redirect-bff GET /health", redirect_api),
        ("analytics-bff GET /health", analytics_api),
    ]:
        t0 = time.perf_counter()
        status, _, raw = http("GET", f"{base}/health")
        ms = (time.perf_counter() - t0) * 1000
        ok = status == 200 and b'"ok":true' in raw.replace(b" ", b"")
        results.append(StepResult(label, ok, f"HTTP {status}", ms))

    # --- Cognito JWT ---
    t0 = time.perf_counter()
    try:
        token, sub = get_jwt(cognito, pool_id, client_id)
        results.append(
            StepResult("Cognito JWT (admin auth)", True, f"sub={sub[:8]}...", (time.perf_counter() - t0) * 1000)
        )
    except Exception as e:
        results.append(StepResult("Cognito JWT (admin auth)", False, str(e)))
        print_results(results)
        return 1

    # --- PUT /shorten ---
    t0 = time.perf_counter()
    status, _, raw = http(
        "PUT",
        f"{app_api}/shorten",
        token=token,
        body={"longUrl": LONG_URL},
    )
    shorten_ms = (time.perf_counter() - t0) * 1000
    if status != 201:
        results.append(StepResult("PUT /shorten → 201", False, f"HTTP {status}: {raw.decode()[:200]}", shorten_ms))
        print_results(results)
        return 1
    created = json.loads(raw)
    code = created["code"]
    results.append(
        StepResult("PUT /shorten → 201", True, f"code={code} longUrl={LONG_URL}", shorten_ms)
    )

    # --- Poll redirect until lean view materialized ---
    t_mat0 = time.perf_counter()
    redirect_status = 0
    location = ""
    for _ in range(60):
        status, hdrs, _ = http("GET", f"{redirect_api}/{code}", allow_redirects=False)
        redirect_status = status
        location = hdrs.get("Location") or hdrs.get("location") or ""
        if status == 302 and location == LONG_URL:
            break
        time.sleep(0.5)
    mat_ms = (time.perf_counter() - t_mat0) * 1000
    results.append(
        StepResult(
            "MappingCreated → lean view → GET /{code} 302",
            redirect_status == 302 and location == LONG_URL,
            f"HTTP {redirect_status} Location={location!r}",
            mat_ms,
        )
    )

    # --- GET /nonexistent → 404 ---
    t0 = time.perf_counter()
    status, _, _ = http("GET", f"{redirect_api}/zzzzzzzz", allow_redirects=False)
    results.append(
        StepResult("GET /nonexistent → 404", status == 404, f"HTTP {status}", (time.perf_counter() - t0) * 1000)
    )

    # --- Redirect again (records click) ---
    t0 = time.perf_counter()
    status, hdrs, _ = http("GET", f"{redirect_api}/{code}", allow_redirects=False)
    click_redirect_ms = (time.perf_counter() - t0) * 1000
    results.append(
        StepResult(
            "GET /{code} click → PutEvents ClickRecorded",
            status == 302,
            f"HTTP {status}",
            click_redirect_ms,
        )
    )

    # --- Poll analytics ---
    t_an0 = time.perf_counter()
    analytics_status = 0
    analytics_body: dict[str, Any] = {}
    for _ in range(60):
        status, _, raw = http("GET", f"{analytics_api}/analytics/{code}", token=token)
        analytics_status = status
        if status == 200:
            analytics_body = json.loads(raw)
            if analytics_body.get("total", 0) >= 1:
                break
        time.sleep(0.5)
    an_ms = (time.perf_counter() - t_an0) * 1000
    total = analytics_body.get("total", 0)
    results.append(
        StepResult(
            "ClickRecorded → analytics listener → GET /analytics/{code}",
            analytics_status == 200 and total >= 1,
            f"HTTP {analytics_status} total={total} clicksTodayUtc={analytics_body.get('clicksTodayUtc')}",
            an_ms,
        )
    )

    # --- GET /me/urls ---
    t0 = time.perf_counter()
    status, _, raw = http("GET", f"{app_api}/me/urls", token=token)
    me_ok = False
    detail = f"HTTP {status}"
    if status == 200:
        items = json.loads(raw).get("items", [])
        me_ok = any(i.get("code") == code for i in items)
        detail = f"count={len(items)} contains_code={me_ok}"
    results.append(StepResult("GET /me/urls lists new mapping", me_ok, detail, (time.perf_counter() - t0) * 1000))

    print_results(results)
    failed = [r for r in results if not r.ok]
    if failed:
        print(f"\n{len(failed)} step(s) failed.")
        return 1
    print("\nAll E2E steps passed.")
    return 0


def print_results(results: list[StepResult]) -> None:
    print("\n| Step | Result | Latency | Detail |")
    print("|------|--------|---------|--------|")
    for r in results:
        mark = "✓" if r.ok else "✗"
        lat = f"{r.ms:.0f}ms" if r.ms is not None else "—"
        print(f"| {r.name} | {mark} | {lat} | {r.detail} |")


if __name__ == "__main__":
    sys.exit(run())
