#!/usr/bin/env python
"""
Send raw Gemini native requests without any downstream parsing/truncation.

Default behavior:
- load backend/.env and models.json
- pick the first two visible Gemini chat models
- run each model with thinking on/off
- save request/response artifacts to backend/tmp/gemini-raw/<timestamp>/
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx

try:
    from dotenv import load_dotenv
except Exception:  # pragma: no cover
    load_dotenv = None


ENV_SUB_RE = re.compile(r"\$\{(\w+)\}")
DEFAULT_PROMPT = (
    "Think carefully and provide a concise final answer.\n"
    "Question: Compare Transformer and Mamba for long-context modeling."
)


def _backend_dir() -> Path:
    return Path(__file__).resolve().parents[1]


def _repo_dir() -> Path:
    return _backend_dir().parent


def _load_env() -> None:
    if load_dotenv is None:
        return
    backend_env = _backend_dir() / ".env"
    repo_env = _repo_dir() / ".env"
    if backend_env.exists():
        load_dotenv(backend_env, override=False)
    if repo_env.exists():
        load_dotenv(repo_env, override=False)


def _resolve_models_path() -> Path:
    raw = os.environ.get("MODELS_CONFIG", "models.json")
    path = Path(raw)
    if path.is_absolute():
        return path

    cwd_candidate = Path.cwd() / path
    if cwd_candidate.exists():
        return cwd_candidate

    backend_candidate = _backend_dir() / path
    return backend_candidate


def _load_models() -> list[dict[str, Any]]:
    path = _resolve_models_path()
    if not path.exists():
        raise FileNotFoundError(f"models config not found: {path}")

    raw = path.read_text(encoding="utf-8")
    raw = ENV_SUB_RE.sub(lambda m: os.environ.get(m.group(1), ""), raw)
    data = json.loads(raw)
    if not isinstance(data, list):
        raise ValueError(f"models config is not a list: {path}")
    return [item for item in data if isinstance(item, dict)]


def _collect_api_keys(cfg: dict[str, Any]) -> list[str]:
    keys: list[str] = []

    inline_key = str(cfg.get("api_key") or "").strip()
    if inline_key:
        keys.append(inline_key)

    for key in cfg.get("api_keys") or []:
        clean = str(key or "").strip()
        if clean:
            keys.append(clean)

    prefix = str(cfg.get("api_key_pool_prefix") or "").strip()
    if prefix:
        idx = 1
        while True:
            env_key = os.environ.get(f"{prefix}{idx}", "").strip()
            if not env_key:
                break
            keys.append(env_key)
            idx += 1

    unique: list[str] = []
    seen = set()
    for key in keys:
        if key and key not in seen:
            seen.add(key)
            unique.append(key)
    return unique


def _select_gemini_api_key(cfg: dict[str, Any]) -> str:
    env_name = str(cfg.get("native_api_key_env") or "").strip()
    if env_name and os.environ.get(env_name):
        return str(os.environ.get(env_name) or "").strip()

    explicit_native_key = str(cfg.get("native_api_key") or "").strip()
    if explicit_native_key:
        return explicit_native_key

    for candidate in ("FANGGROUP_GEMINI_API_KEY", "GEMINI_API_KEY"):
        value = str(os.environ.get(candidate) or "").strip()
        if value:
            return value

    pooled_keys = _collect_api_keys(cfg)
    if pooled_keys:
        return pooled_keys[0]

    return ""


def _resolve_gemini_api_base(cfg: dict[str, Any]) -> str:
    api_base = (
        str(cfg.get("native_api_base") or "").strip()
        or str(os.environ.get("GEMINI_API_BASE") or "").strip()
        or str(cfg.get("api_base") or "").strip()
        or "https://api.vectorengine.ai"
    )
    return api_base


def _build_gemini_url(api_base: str, model_name: str) -> str:
    stripped = api_base.rstrip("/")
    if stripped.endswith("/v1"):
        stripped = stripped[:-3]
    return f"{stripped}/v1beta/models/{model_name}:generateContent"


def _build_thinking_config(model_name: str, enable_thinking: bool, thinking_budget: int) -> dict[str, Any]:
    normalized = str(model_name or "").strip().lower()
    if normalized.startswith("gemini-3"):
        return {
            "thinkingLevel": "HIGH" if enable_thinking else "LOW",
        }
    return {
        "thinkingBudget": thinking_budget if enable_thinking else 0,
    }


def _select_default_models(models: list[dict[str, Any]]) -> list[dict[str, Any]]:
    candidates = [
        cfg
        for cfg in models
        if str(cfg.get("provider") or cfg.get("transport") or "").startswith("gemini")
        and bool(cfg.get("available", True))
        and bool(cfg.get("visible", True))
    ]
    if len(candidates) >= 2:
        return candidates[:2]
    if candidates:
        return candidates
    raise RuntimeError("no visible Gemini chat models found in models.json")


def _find_models(models: list[dict[str, Any]], model_ids: list[str] | None) -> list[dict[str, Any]]:
    if not model_ids:
        return _select_default_models(models)

    selected: list[dict[str, Any]] = []
    missing: list[str] = []
    for model_id in model_ids:
        match = next((cfg for cfg in models if str(cfg.get("id")) == model_id), None)
        if match is None:
            missing.append(model_id)
            continue
        selected.append(match)

    if missing:
        raise RuntimeError(f"model ids not found: {', '.join(missing)}")
    return selected


def _artifact_dir(base_dir: Path, model_id: str, thinking: bool) -> Path:
    suffix = "thinking-on" if thinking else "thinking-off"
    return base_dir / f"{model_id}-{suffix}"


def _write_json(path: Path, payload: Any) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _save_case_artifacts(
    *,
    case_dir: Path,
    request_meta: dict[str, Any],
    response: httpx.Response,
) -> None:
    case_dir.mkdir(parents=True, exist_ok=True)

    _write_json(case_dir / "request.json", request_meta)

    headers = dict(response.headers)
    response_meta = {
        "status_code": response.status_code,
        "headers": headers,
        "url": str(response.request.url),
    }
    _write_json(case_dir / "response_meta.json", response_meta)
    (case_dir / "response_raw.txt").write_text(response.text, encoding="utf-8")

    try:
        payload = response.json()
    except Exception:
        payload = None

    if payload is not None:
        _write_json(case_dir / "response.json", payload)


def _build_payload(
    *,
    prompt: str,
    system_prompt: str | None,
    temperature: float,
    max_output_tokens: int,
    model_name: str,
    thinking: bool,
    thinking_budget: int,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "contents": [
            {
                "role": "user",
                "parts": [{"text": prompt}],
            }
        ],
        "generationConfig": {
            "temperature": temperature,
            "maxOutputTokens": max_output_tokens,
            "thinkingConfig": _build_thinking_config(model_name, thinking, thinking_budget),
        },
    }

    if system_prompt:
        payload["systemInstruction"] = {
            "parts": [{"text": system_prompt}],
        }

    return payload


def _run_case(
    *,
    client: httpx.Client,
    cfg: dict[str, Any],
    prompt: str,
    system_prompt: str | None,
    temperature: float,
    max_output_tokens: int,
    thinking: bool,
    thinking_budget: int,
    base_output_dir: Path,
) -> dict[str, Any]:
    model_id = str(cfg.get("id") or cfg.get("model") or "unknown")
    model_name = str(cfg.get("model") or "").strip()
    api_key = _select_gemini_api_key(cfg)
    if not api_key:
        raise RuntimeError(f"no Gemini API key resolved for model: {model_id}")

    api_base = _resolve_gemini_api_base(cfg)
    url = _build_gemini_url(api_base, model_name)
    payload = _build_payload(
        prompt=prompt,
        system_prompt=system_prompt,
        temperature=temperature,
        max_output_tokens=max_output_tokens,
        model_name=model_name,
        thinking=thinking,
        thinking_budget=thinking_budget,
    )

    response = client.post(
        url,
        headers={"Content-Type": "application/json"},
        params={"key": api_key},
        json=payload,
    )

    case_dir = _artifact_dir(base_output_dir, model_id, thinking)
    request_meta = {
        "model_id": model_id,
        "model_name": model_name,
        "thinking": thinking,
        "api_base": api_base,
        "url": url,
        "payload": payload,
    }
    _save_case_artifacts(case_dir=case_dir, request_meta=request_meta, response=response)

    return {
        "model_id": model_id,
        "model_name": model_name,
        "thinking": thinking,
        "status_code": response.status_code,
        "case_dir": str(case_dir),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Send raw Gemini requests and save unparsed responses.",
    )
    parser.add_argument(
        "--model-id",
        action="append",
        dest="model_ids",
        help="Model id from backend/models.json. Repeatable. Default: first two visible Gemini chat models.",
    )
    parser.add_argument(
        "--prompt",
        default=DEFAULT_PROMPT,
        help="User prompt sent to Gemini.",
    )
    parser.add_argument(
        "--system-prompt",
        default="You are a helpful assistant. Show your best reasoning behavior for this test.",
        help="Optional system instruction. Pass empty string to disable.",
    )
    parser.add_argument(
        "--temperature",
        type=float,
        default=0.7,
        help="generationConfig.temperature",
    )
    parser.add_argument(
        "--max-output-tokens",
        type=int,
        default=4096,
        help="generationConfig.maxOutputTokens",
    )
    parser.add_argument(
        "--thinking-budget",
        type=int,
        default=1024,
        help="Budget used for non-Gemini-3 models when thinking is enabled.",
    )
    parser.add_argument(
        "--out-dir",
        default="backend/tmp/gemini-raw",
        help="Base output directory.",
    )
    parser.add_argument(
        "--timeout-seconds",
        type=float,
        default=180.0,
        help="HTTP timeout in seconds.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    _load_env()

    models = _load_models()
    selected_models = _find_models(models, args.model_ids)

    system_prompt = args.system_prompt or None
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    base_output_dir = Path(args.out_dir) / timestamp
    base_output_dir.mkdir(parents=True, exist_ok=True)

    print(f"Output dir: {base_output_dir}")
    print("Selected models:")
    for cfg in selected_models:
        print(f"- {cfg.get('id')}: {cfg.get('model')}")
    print("Thinking modes: on, off")

    timeout = httpx.Timeout(
        connect=min(args.timeout_seconds, 30.0),
        read=args.timeout_seconds,
        write=min(args.timeout_seconds, 30.0),
        pool=min(args.timeout_seconds, 30.0),
    )

    results: list[dict[str, Any]] = []
    failures: list[str] = []

    with httpx.Client(timeout=timeout) as client:
        for cfg in selected_models:
            for thinking in (True, False):
                model_id = str(cfg.get("id") or cfg.get("model") or "unknown")
                mode_label = "on" if thinking else "off"
                print(f"\n==> Requesting {model_id} thinking={mode_label}")
                try:
                    result = _run_case(
                        client=client,
                        cfg=cfg,
                        prompt=args.prompt,
                        system_prompt=system_prompt,
                        temperature=args.temperature,
                        max_output_tokens=args.max_output_tokens,
                        thinking=thinking,
                        thinking_budget=args.thinking_budget,
                        base_output_dir=base_output_dir,
                    )
                    results.append(result)
                    print(
                        f"    status={result['status_code']} "
                        f"saved={result['case_dir']}"
                    )
                except Exception as exc:
                    failures.append(f"{model_id} thinking={mode_label}: {type(exc).__name__}: {exc}")
                    print(f"    FAILED: {type(exc).__name__}: {exc}", file=sys.stderr)

    summary = {
        "timestamp": timestamp,
        "output_dir": str(base_output_dir),
        "results": results,
        "failures": failures,
    }
    _write_json(base_output_dir / "summary.json", summary)

    print("\nSummary file:")
    print(base_output_dir / "summary.json")

    if failures:
        print("\nFailures:")
        for item in failures:
            print(f"- {item}")
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
