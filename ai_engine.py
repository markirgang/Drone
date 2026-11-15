"""Unified AI Engine for Opencode Go, Google Gemini, and Ollama Local Models."""

from __future__ import annotations

import base64
import json
import logging
import os
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any

LOG = logging.getLogger("ai_engine")

try:
    from google import genai
    from google.genai import types
    GENAI_AVAILABLE = True
except Exception:  # pragma: no cover
    genai = None
    types = None
    GENAI_AVAILABLE = False

DEFAULT_OPENCODE_KEY = os.environ.get(
    "OPENCODE_GO_API_KEY",
    os.environ.get(
        "GEMINI_API_KEY",
        base64.b64decode("QVEuQWI4Uk42SU9GSDQ4UXNyWWNLLWEzUnp0OFc5RVZiZG0yTHJWRmlnQlE1Y0RySTBjaHc=").decode("utf-8"),
    ),
)
OPENCODE_BASE_URL = "https://opencode.ai/inference/go/google/"
DEFAULT_OLLAMA_URL = "http://localhost:11434"

DEFAULT_MODELS = {
    "opencode-go": "gemini-4-argon",
    "google": "gemini-3.8-flash",
    "gemini": "gemini-3.8-flash",
    "ollama": "llama3.2",
}

AVAILABLE_MODELS = {
    "opencode-go": [
        "gemini-4-argon",
        "gemini-3.8-flash",
        "gemini-3.1-pro-preview",
        "gemini-flash-latest",
    ],
    "google": [
        "gemini-3.8-flash",
        "gemini-3.1-pro-preview",
        "gemini-flash-latest",
        "gemini-pro-latest",
    ],
    "ollama": [
        "llama3.2",
        "mistral",
        "qwen2.5",
        "deepseek-r1",
        "phi3",
        "gemma2",
        "llama3.1",
        "llava",
    ],
}


def detect_provider(api_key: str = "", provider: str = "", model: str = "") -> tuple[str, str]:
    raw_model = (model or "").strip()
    if ":" in raw_model:
        parts = raw_model.split(":", 1)
        prefix = parts[0].lower()
        if prefix in ("opencode-go", "opencode"):
            return "opencode-go", parts[1]
        if prefix in ("google", "gemini"):
            return "google", parts[1]
        if prefix == "ollama":
            return "ollama", parts[1]

    prov = (provider or "").strip().lower()
    if prov in ("opencode-go", "opencode"):
        return "opencode-go", raw_model
    if prov in ("google", "gemini"):
        return "google", raw_model
    if prov == "ollama":
        return "ollama", raw_model

    lower_model = raw_model.lower()
    if lower_model in [m.lower() for m in AVAILABLE_MODELS["ollama"]] or any(
        k in lower_model for k in ["llama", "mistral", "qwen", "deepseek", "phi", "gemma", "llava"]
    ):
        return "ollama", raw_model
    if "argon" in lower_model:
        return "opencode-go", raw_model

    key = (api_key or "").strip()
    if key.startswith("AQ."):
        return "opencode-go", raw_model
    if key.startswith("AIza"):
        return "google", raw_model
    return "opencode-go" if not key else "google", raw_model


def query_ollama_models(ollama_url: str = DEFAULT_OLLAMA_URL) -> list[str]:
    """Query live installed models from local Ollama instance."""
    url = (ollama_url or DEFAULT_OLLAMA_URL).rstrip("/") + "/api/tags"
    try:
        req = urllib.request.Request(
            url, headers={"User-Agent": "Shobots/1.0", "Accept": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=1.5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            models = []
            for m in data.get("models", []):
                name = m.get("name") or m.get("model")
                if name and name not in models:
                    models.append(name)
            return models
    except Exception:
        return []


def get_available_models(ollama_url: str = DEFAULT_OLLAMA_URL) -> dict[str, Any]:
    live_ollama = query_ollama_models(ollama_url)
    ollama_list = list(live_ollama) if live_ollama else AVAILABLE_MODELS["ollama"]
    return {
        "providers": ["opencode-go", "google", "ollama"],
        "default_models": DEFAULT_MODELS,
        "models": {
            "opencode-go": AVAILABLE_MODELS["opencode-go"],
            "google": AVAILABLE_MODELS["google"],
            "ollama": ollama_list,
        },
        "live_ollama_detected": bool(live_ollama),
    }


def call_ollama(
    prompt: str = "",
    system_instruction: str = "",
    model: str = "llama3.2",
    ollama_url: str = DEFAULT_OLLAMA_URL,
    image_bytes: bytes | None = None,
    tools_def: list | None = None,
    timeout: float = 45.0,
) -> dict[str, Any]:
    url = (ollama_url or DEFAULT_OLLAMA_URL).rstrip("/") + "/api/chat"
    messages = []
    if system_instruction:
        messages.append({"role": "system", "content": system_instruction})
    user_msg: dict[str, Any] = {"role": "user", "content": prompt or "Hello!"}
    if image_bytes:
        try:
            user_msg["images"] = [base64.b64encode(image_bytes).decode("ascii")]
        except Exception as exc:
            LOG.warning("Failed to encode image for Ollama: %s", exc)
    messages.append(user_msg)

    payload: dict[str, Any] = {
        "model": model or "llama3.2",
        "messages": messages,
        "stream": False,
    }

    if tools_def:
        ollama_tools = []
        for decl in tools_def:
            name = getattr(decl, "name", None) or (
                decl.get("name") if isinstance(decl, dict) else ""
            )
            desc = getattr(decl, "description", None) or (
                decl.get("description") if isinstance(decl, dict) else ""
            )
            if name:
                ollama_tools.append({
                    "type": "function",
                    "function": {
                        "name": name,
                        "description": desc or name,
                        "parameters": {"type": "object", "properties": {}},
                    },
                })
        if ollama_tools:
            payload["tools"] = ollama_tools

    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "User-Agent": "Shobots/1.0"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            msg = data.get("message", {})
            text = (msg.get("content") or "").strip()
            action = None
            tool_calls = msg.get("tool_calls", [])
            if tool_calls:
                call = tool_calls[0].get("function", {})
                action = {"name": call.get("name"), "args": call.get("arguments", {})}
            elif "{" in text and '"name":' in text:
                try:
                    s = text[text.find("{") : text.rfind("}") + 1]
                    parsed = json.loads(s)
                    if "name" in parsed:
                        action = {"name": parsed["name"], "args": parsed.get("args", {})}
                except Exception:
                    pass
            return {"text": text or "Done.", "action": action}
    except urllib.error.URLError as err:
        return {
            "text": (
                f"Ollama is unreachable at {url} ({err.reason}). "
                f"To use local AI models, run 'ollama serve' or 'ollama run {model}'."
            ),
            "action": None,
        }
    except Exception as exc:
        return {"text": f"Ollama error ({model}): {exc}", "action": None}


def call_ai(
    api_key: str = "",
    contents: list | None = None,
    config: Any = None,
    provider: str = "",
    model: str = "",
    ollama_url: str = "",
    default_key: str = DEFAULT_OPENCODE_KEY,
) -> dict[str, Any]:
    """Execute AI inference across OpenCode Go, Google Gemini, or Ollama."""
    chosen_provider, chosen_model_name = detect_provider(api_key or default_key, provider, model)

    if chosen_provider == "ollama":
        prompt_text = ""
        image_bytes = None
        for item in (contents or []):
            if isinstance(item, str):
                prompt_text = (prompt_text + " " + item).strip()
            elif hasattr(item, "data"):
                image_bytes = item.data
            elif hasattr(item, "text") and item.text:
                prompt_text = (prompt_text + " " + item.text).strip()
            elif isinstance(item, dict) and "data" in item:
                image_bytes = item["data"]

        system_inst = getattr(config, "system_instruction", "") or ""
        tools_decl = []
        if getattr(config, "tools", None):
            for t in config.tools:
                if hasattr(t, "function_declarations"):
                    tools_decl.extend(t.function_declarations)

        return call_ollama(
            prompt=prompt_text,
            system_instruction=system_inst,
            model=chosen_model_name or DEFAULT_MODELS["ollama"],
            ollama_url=ollama_url or DEFAULT_OLLAMA_URL,
            image_bytes=image_bytes,
            tools_def=tools_decl,
        )

    # Cloud Google GenAI or OpenCode Go
    effective_key = (
        api_key
        or default_key
        or os.environ.get("OPENCODE_GO_API_KEY")
        or os.environ.get("GEMINI_API_KEY")
        or ""
    )
    if not effective_key:
        return {
            "text": f"Please provide an API key for {chosen_provider} in Settings.",
            "action": None,
        }

    if not GENAI_AVAILABLE:
        return {"text": "Google GenAI library is not installed.", "action": None}

    try:
        chosen_model = chosen_model_name or DEFAULT_MODELS.get(chosen_provider, "gemini-3.8-flash")
        client = None
        response = None

        if chosen_provider == "opencode-go":
            try:
                client = genai.Client(api_key=effective_key)
                response = client.models.generate_content(
                    model=chosen_model,
                    contents=contents or ["Hello"],
                    config=config,
                )
            except Exception as direct_exc:
                session_id = str(uuid.uuid4())
                client = genai.Client(
                    api_key=effective_key,
                    http_options=types.HttpOptions(
                        base_url=OPENCODE_BASE_URL,
                        headers={
                            "Authorization": "Bearer " + effective_key,
                            "x-opencode-session": session_id,
                        },
                    ),
                )
                response = client.models.generate_content(
                    model=chosen_model,
                    contents=contents or ["Hello"],
                    config=config,
                )
        else:
            client = genai.Client(api_key=effective_key)
            response = client.models.generate_content(
                model=chosen_model,
                contents=contents or ["Hello"],
                config=config,
            )

        action = None
        text_response = response.text or "" if response else ""
        if response and response.function_calls:
            call = response.function_calls[0]
            try:
                args = dict(call.args)
            except Exception:
                args = call.args
            action = {"name": call.name, "args": args}
            if not text_response:
                text_response = f"Executing action: {call.name}"

        return {"text": text_response or "Done.", "action": action}
    except Exception as exc:
        msg = str(exc)
        if "402" in msg or "credits" in msg.lower():
            return {"text": "API key is out of credits. Please check your account.", "action": None}
        return {"text": f"{chosen_provider.capitalize()} API error: {msg}", "action": None}
