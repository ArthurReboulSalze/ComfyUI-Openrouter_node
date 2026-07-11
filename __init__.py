import os
import asyncio
from .openrouter_catalog import OpenRouterCatalog
from .node import (
    OpenRouterNode,
    NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS,
)

WEB_DIRECTORY = "./web"
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

API_KEY_FILE = os.path.join(os.path.dirname(__file__), "openrouter_api_key.txt")
API_KEY_JSON_FILE = os.path.join(os.path.dirname(__file__), "openrouter_api_key.json")


def _mask_api_key(key: str) -> str:
    if not key or len(key) < 8:
        return ""
    return key[:4] + "..." + key[-4:]


def _read_api_key() -> str:
    try:
        with open(API_KEY_FILE, "r", encoding="utf-8") as f:
            key = f.read().strip()
        if key:
            return key
    except (FileNotFoundError, OSError):
        pass

    try:
        import json
        with open(API_KEY_JSON_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and isinstance(data.get("api_key"), str):
            key = data["api_key"].strip()
            if key:
                return key
    except (FileNotFoundError, OSError, ValueError):
        pass

    return (
        os.environ.get("OPENROUTER_API_KEY", "").strip()
        or os.environ.get("LLM_KEY", "").strip()
    )


def _api_key_source() -> str:
    try:
        with open(API_KEY_FILE, "r", encoding="utf-8") as f:
            if f.read().strip():
                return "file"
    except (FileNotFoundError, OSError):
        pass
    try:
        import json
        with open(API_KEY_JSON_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and isinstance(data.get("api_key"), str) and data["api_key"].strip():
            return "json"
    except (FileNotFoundError, OSError, ValueError):
        pass
    if os.environ.get("OPENROUTER_API_KEY", "").strip():
        return "OPENROUTER_API_KEY"
    if os.environ.get("LLM_KEY", "").strip():
        return "LLM_KEY"
    return ""


try:
    from server import PromptServer
    from aiohttp import web

    @PromptServer.instance.routes.get("/openrouter/api_key_status")
    async def api_key_status(request):
        key = _read_api_key()
        if key:
            return web.json_response({"saved": True, "source": _api_key_source(), "masked": _mask_api_key(key)})
        return web.json_response({"saved": False, "source": "", "masked": ""})

    @PromptServer.instance.routes.get("/openrouter/model_catalog")
    async def model_catalog(request):
        force_refresh = request.query.get("refresh", "").lower() in {"1", "true", "yes"}
        try:
            return web.json_response(OpenRouterCatalog.build_widget_catalog(force_refresh))
        except Exception as e:
            return web.json_response(
                {"success": False, "error": f"Could not refresh OpenRouter models: {e}"},
                status=502,
            )

    @PromptServer.instance.routes.get("/openrouter/credits")
    async def openrouter_credits(request):
        key = _read_api_key()
        if not key:
            return web.json_response(
                {"success": False, "error": "OpenRouter API key is not configured."},
                status=400,
            )

        try:
            credits_text = await asyncio.to_thread(OpenRouterNode.fetch_credits, key, 20)
            if credits_text.startswith("Error") or credits_text.startswith("Could not"):
                return web.json_response(
                    {"success": False, "error": credits_text},
                    status=502,
                )
            return web.json_response({"success": True, "credits": credits_text})
        except Exception as e:
            return web.json_response(
                {"success": False, "error": f"Could not refresh OpenRouter credits: {e}"},
                status=502,
            )

    @PromptServer.instance.routes.post("/openrouter/save_api_key")
    async def save_api_key(request):
        json_data = await request.json()
        key = json_data.get("api_key", "").strip()
        try:
            with open(API_KEY_FILE, "w", encoding="utf-8") as f:
                f.write(key)
            return web.json_response({"success": True, "masked": _mask_api_key(key)})
        except OSError as e:
            return web.json_response({"success": False, "error": str(e)})

    @PromptServer.instance.routes.post("/openrouter/delete_api_key")
    async def delete_api_key(request):
        try:
            if os.path.exists(API_KEY_FILE):
                os.remove(API_KEY_FILE)
            return web.json_response({"success": True})
        except OSError as e:
            return web.json_response({"success": False, "error": str(e)})

except Exception:
    pass
