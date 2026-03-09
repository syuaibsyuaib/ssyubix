"""
AgentLink MCP Server v2 — Cloudflare Workers Backend
Relay via Cloudflare Durable Objects WebSocket.
Tidak perlu tunnel, tidak perlu Supabase. URL permanen.
"""

import asyncio
import json
import uuid
import os
import logging
import re
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional, Any, Literal
from datetime import datetime, timezone
from urllib.parse import quote, urlencode, urlparse

import aiohttp
import websockets
import websockets.client
from websockets.exceptions import ConnectionClosed
from mcp.server.fastmcp import FastMCP
from pydantic import BaseModel, Field, ConfigDict, field_validator, model_validator
from .onboarding import (
    READ_ME_FIRST_MARKDOWN,
    READ_ME_FIRST_PROMPT,
    SERVER_INSTRUCTIONS,
)

logging.basicConfig(level=logging.WARNING)
logger = logging.getLogger(__name__)

AGENTLINK_URL = os.environ.get("AGENTLINK_URL", "https://agentlink.syuaibsyuaib.workers.dev").rstrip("/")
AGENT_NAME    = os.environ.get("AGENT_NAME", f"agent-{uuid.uuid4().hex[:6]}")
WS_BASE       = AGENTLINK_URL.replace("https://", "wss://").replace("http://", "ws://")
LOCAL_STATE_VERSION = 1
LOCAL_INBOX_LIMIT = max(10, int(os.environ.get("SSYUBIX_LOCAL_INBOX_LIMIT", "200")))
LOCAL_RETRY_LIMIT = max(1, int(os.environ.get("SSYUBIX_LOCAL_RETRY_LIMIT", "50")))
LOCAL_RETRY_MAX_ATTEMPTS = max(1, int(os.environ.get("SSYUBIX_LOCAL_RETRY_MAX_ATTEMPTS", "5")))
LOCAL_RETRY_TTL_SECONDS = max(60, int(os.environ.get("SSYUBIX_LOCAL_RETRY_TTL_SECONDS", "21600")))
LOCAL_SUMMARY_STALE_SECONDS = max(60, int(os.environ.get("SSYUBIX_LOCAL_SUMMARY_STALE_SECONDS", "900")))
LOCAL_ROOM_CACHE_TTL_SECONDS = max(3600, int(os.environ.get("SSYUBIX_LOCAL_ROOM_CACHE_TTL_SECONDS", "604800")))
LOCAL_ROOM_CACHE_LIMIT = max(1, int(os.environ.get("SSYUBIX_LOCAL_ROOM_CACHE_LIMIT", "50")))
LOCAL_CORRUPT_CACHE_LIMIT = max(1, int(os.environ.get("SSYUBIX_LOCAL_CORRUPT_CACHE_LIMIT", "20")))

agent_id: Optional[str]     = None
agent_name: str              = AGENT_NAME
client_session_id: str       = os.environ.get("AGENT_SESSION_ID", uuid.uuid4().hex)
stable_agent_identity_id: str = ""
current_room: Optional[dict] = None
ws_conn: Optional[Any]       = None
inbox: list                  = []
http_session: Optional[aiohttp.ClientSession] = None
pending_acks: dict[str, asyncio.Future] = {}
room_credentials: Optional[dict] = None
reconnect_task: Optional[asyncio.Task] = None
retry_replay_task: Optional[asyncio.Task] = None
auto_reconnect_enabled: bool = False


def _resolve_local_state_dir() -> Path:
    override = os.environ.get("SSYUBIX_LOCAL_STATE_DIR")
    if override:
        return Path(override).expanduser()
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        return Path(local_app_data) / "ssyubix"
    xdg_state_home = os.environ.get("XDG_STATE_HOME")
    if xdg_state_home:
        return Path(xdg_state_home) / "ssyubix"
    return Path.home() / ".ssyubix"


local_state_dir: Path = _resolve_local_state_dir()

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _server_cache_key() -> str:
    parsed = urlparse(AGENTLINK_URL)
    host = parsed.netloc or parsed.path or "default"
    return "".join(ch if ch.isalnum() else "_" for ch in host)


def _room_cache_path(room_id: str) -> Path:
    return local_state_dir / "rooms" / _server_cache_key() / f"{room_id.upper()}.json"


def _room_cache_dir() -> Path:
    return local_state_dir / "rooms" / _server_cache_key()


def _client_identity_path() -> Path:
    return local_state_dir / "client" / _server_cache_key() / "identity.json"


def _corrupt_cache_dir() -> Path:
    return local_state_dir / "corrupt" / _server_cache_key()


def _sanitize_stable_agent_identity_id(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    if not normalized or len(normalized) > 128:
        return None
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", normalized):
        return None
    return normalized


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _max_message_sequence(messages: list[dict]) -> int:
    sequences = [
        _safe_int(message.get("sequence"))
        for message in messages
        if isinstance(message, dict) and isinstance(message.get("sequence"), int)
    ]
    return max(sequences, default=0)


def _retry_queue() -> list[dict]:
    if current_room is None:
        return []
    queue = current_room.setdefault("retry_queue", [])
    if isinstance(queue, list):
        return queue
    current_room["retry_queue"] = []
    return current_room["retry_queue"]


def _iso_to_timestamp(value: Optional[str]) -> float:
    if not isinstance(value, str):
        return 0.0
    try:
        return datetime.fromisoformat(value).timestamp()
    except ValueError:
        return 0.0


def _clip_text(value: Any, limit: int = 120) -> Optional[str]:
    if not isinstance(value, str):
        return None
    collapsed = " ".join(value.split())
    if not collapsed:
        return None
    if len(collapsed) <= limit:
        return collapsed
    return f"{collapsed[: limit - 1]}…"


def _message_identity(entry: Any) -> Optional[tuple]:
    if not isinstance(entry, dict):
        return None
    message_id = entry.get("message_id")
    if isinstance(message_id, str) and message_id:
        return ("message_id", message_id)
    sequence = entry.get("sequence") if isinstance(entry.get("sequence"), int) else None
    return (
        entry.get("type"),
        sequence,
        entry.get("event"),
        entry.get("agent_id"),
        entry.get("from"),
        entry.get("timestamp"),
    )


def _compact_messages(entries: Any) -> list[dict]:
    if not isinstance(entries, list):
        return []

    compacted: list[dict] = []
    seen: set[tuple] = set()
    for entry in reversed(entries):
        if not isinstance(entry, dict):
            continue
        identity = _message_identity(entry)
        if identity is not None and identity in seen:
            continue
        if identity is not None:
            seen.add(identity)
        compacted.append(entry)

    compacted.reverse()
    return compacted[-LOCAL_INBOX_LIMIT:]


def _sanitize_peer_snapshot(peer: Any) -> Optional[dict]:
    if not isinstance(peer, dict):
        return None
    agent_id_value = peer.get("agent_id")
    if not isinstance(agent_id_value, str) or not agent_id_value:
        return None
    return {
        "agent_id": agent_id_value,
        "stable_agent_identity_id": (
            peer.get("stable_agent_identity_id")
            if isinstance(peer.get("stable_agent_identity_id"), str)
            else None
        ),
        "name": peer.get("name") if isinstance(peer.get("name"), str) else None,
        "presence": peer.get("presence") if isinstance(peer.get("presence"), str) else None,
        "joined_at": peer.get("joined_at") if isinstance(peer.get("joined_at"), str) else None,
        "last_seen_at": peer.get("last_seen_at") if isinstance(peer.get("last_seen_at"), str) else None,
    }


def _build_local_room_summary(*, room_id: str, room_state: Optional[dict], messages: list[dict],
    retry_queue: list[dict], cached_at: Optional[str] = None) -> dict:
    cached_at_value = cached_at if isinstance(cached_at, str) else _now_iso()
    last_read_sequence = _safe_int(room_state.get("last_read_sequence")) if isinstance(room_state, dict) else 0
    last_sequence = _safe_int(room_state.get("last_sequence")) if isinstance(room_state, dict) else _max_message_sequence(messages)
    existing_summary = room_state.get("local_summary", {}) if isinstance(room_state, dict) else {}
    existing_room = existing_summary.get("room", {}) if isinstance(existing_summary, dict) else {}
    peers_raw = room_state.get("peers", {}) if isinstance(room_state, dict) else {}
    if isinstance(peers_raw, dict):
        peers = [
            sanitized
            for sanitized in (_sanitize_peer_snapshot(peer) for peer in peers_raw.values())
            if sanitized is not None
        ]
    else:
        peers = []
    if not peers and isinstance(existing_summary, dict):
        peers = [
            sanitized
            for sanitized in (_sanitize_peer_snapshot(peer) for peer in existing_summary.get("peers", []))
            if sanitized is not None
        ]

    message_entries = [
        message for message in messages
        if isinstance(message, dict) and message.get("type") == "message"
    ]
    event_entries = [
        message for message in messages
        if isinstance(message, dict) and message.get("type") == "event"
    ]
    unread_count = len([
        message for message in message_entries
        if isinstance(message.get("sequence"), int) and message.get("sequence", 0) > last_read_sequence
    ])
    last_message = max(message_entries, key=lambda item: _iso_to_timestamp(item.get("timestamp")), default=None)
    last_event = max(event_entries, key=lambda item: _iso_to_timestamp(item.get("timestamp")), default=None)
    last_activity_timestamp = max([
        _iso_to_timestamp(last_message.get("timestamp")) if isinstance(last_message, dict) else 0.0,
        _iso_to_timestamp(last_event.get("timestamp")) if isinstance(last_event, dict) else 0.0,
        _iso_to_timestamp(cached_at_value),
    ])
    age_seconds = max(0, int(time.time() - _iso_to_timestamp(cached_at_value)))

    return {
        "room_id": room_id.upper(),
        "generated_at": _now_iso(),
        "cached_at": cached_at_value,
        "age_seconds": age_seconds,
        "is_stale": age_seconds > LOCAL_SUMMARY_STALE_SECONDS,
        "last_sequence": last_sequence,
        "last_read_sequence": last_read_sequence,
        "unread_count": unread_count,
        "cached_message_count": len(messages),
        "retry_queue_count": len(retry_queue),
        "peer_count": len(peers),
        "peers": peers[:10],
        "room": {
            "joined_at": room_state.get("joined_at") if isinstance(room_state, dict) and isinstance(room_state.get("joined_at"), str)
            else existing_room.get("joined_at"),
            "last_seen_at": room_state.get("last_seen_at") if isinstance(room_state, dict) and isinstance(room_state.get("last_seen_at"), str)
            else existing_room.get("last_seen_at"),
            "presence": room_state.get("presence") if isinstance(room_state, dict) and isinstance(room_state.get("presence"), str)
            else existing_room.get("presence"),
            "session_resumed": bool(room_state.get("session_resumed")) if isinstance(room_state, dict) else False,
            "heartbeat_interval_seconds": _safe_int(room_state.get("heartbeat_interval_seconds"))
            if isinstance(room_state, dict) and room_state.get("heartbeat_interval_seconds") is not None
            else _safe_int(existing_room.get("heartbeat_interval_seconds")),
            "heartbeat_timeout_seconds": _safe_int(room_state.get("heartbeat_timeout_seconds"))
            if isinstance(room_state, dict) and room_state.get("heartbeat_timeout_seconds") is not None
            else _safe_int(existing_room.get("heartbeat_timeout_seconds")),
        },
        "recent_activity": {
            "message_count": len(message_entries),
            "event_count": len(event_entries),
            "last_activity_at": datetime.fromtimestamp(last_activity_timestamp, tz=timezone.utc).isoformat()
            if last_activity_timestamp > 0 else None,
            "last_message_at": last_message.get("timestamp") if isinstance(last_message, dict) else None,
            "last_message_from": last_message.get("from") if isinstance(last_message, dict) else None,
            "last_message_preview": _clip_text(last_message.get("content")) if isinstance(last_message, dict) else None,
            "last_event_at": last_event.get("timestamp") if isinstance(last_event, dict) else None,
            "last_event": last_event.get("event") if isinstance(last_event, dict) else None,
        },
    }


def _refresh_local_summary_metadata(summary: dict, cached_at: Optional[str]) -> dict:
    if not isinstance(summary, dict):
        return summary
    cached_at_value = cached_at if isinstance(cached_at, str) else summary.get("cached_at")
    age_seconds = max(0, int(time.time() - _iso_to_timestamp(cached_at_value)))
    refreshed = dict(summary)
    refreshed["generated_at"] = _now_iso()
    refreshed["cached_at"] = cached_at_value
    refreshed["age_seconds"] = age_seconds
    refreshed["is_stale"] = age_seconds > LOCAL_SUMMARY_STALE_SECONDS
    return refreshed


def _normalize_retry_entry(entry: dict) -> Optional[dict]:
    if not isinstance(entry, dict):
        return None
    action = entry.get("action")
    payload = entry.get("payload")
    room_id = entry.get("room_id")
    if action not in {"send", "broadcast"} or not isinstance(payload, dict) or not isinstance(room_id, str):
        return None
    retry_id = entry.get("retry_id")
    if not isinstance(retry_id, str) or not retry_id:
        retry_id = uuid.uuid4().hex
    created_at = entry.get("created_at")
    if not isinstance(created_at, str):
        created_at = _now_iso()
    expires_at = entry.get("expires_at")
    if not isinstance(expires_at, str):
        expires_at = datetime.fromtimestamp(
            _iso_to_timestamp(created_at) + LOCAL_RETRY_TTL_SECONDS,
            tz=timezone.utc,
        ).isoformat()
    return {
        "retry_id": retry_id,
        "room_id": room_id.upper(),
        "action": action,
        "payload": payload,
        "created_at": created_at,
        "updated_at": entry.get("updated_at") if isinstance(entry.get("updated_at"), str) else created_at,
        "expires_at": expires_at,
        "attempts": max(0, _safe_int(entry.get("attempts"))),
        "last_error": entry.get("last_error") if isinstance(entry.get("last_error"), str) else None,
        "next_retry_at": entry.get("next_retry_at") if isinstance(entry.get("next_retry_at"), str) else created_at,
    }


def _normalized_retry_queue(entries: Any) -> list[dict]:
    if not isinstance(entries, list):
        return []
    normalized = []
    for entry in entries:
        next_entry = _normalize_retry_entry(entry)
        if next_entry is not None:
            normalized.append(next_entry)
    normalized.sort(key=lambda item: (_iso_to_timestamp(item.get("next_retry_at")), item["created_at"]))
    return normalized[-LOCAL_RETRY_LIMIT:]


def _write_json_file(path: Path, payload: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(f"{path.suffix}.tmp")
    temp_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    temp_path.replace(path)


def _persist_stable_agent_identity_id(value: str):
    _write_json_file(_client_identity_path(), {
        "version": LOCAL_STATE_VERSION,
        "stable_agent_identity_id": value,
        "updated_at": _now_iso(),
    })


def _load_or_create_stable_agent_identity_id() -> str:
    override = _sanitize_stable_agent_identity_id(
        os.environ.get("SSYUBIX_STABLE_AGENT_IDENTITY_ID"),
    )
    if override:
        try:
            _persist_stable_agent_identity_id(override)
        except Exception as exc:
            logger.warning("Stable identity override persistence failed: %s", exc)
        return override

    identity_path = _client_identity_path()
    if identity_path.exists():
        try:
            payload = json.loads(identity_path.read_text(encoding="utf-8"))
        except Exception as exc:
            logger.warning("Stable identity cache read failed for %s: %s", identity_path, exc)
        else:
            cached = _sanitize_stable_agent_identity_id(
                payload.get("stable_agent_identity_id"),
            )
            if cached:
                return cached

    generated = uuid.uuid4().hex
    try:
        _persist_stable_agent_identity_id(generated)
    except Exception as exc:
        logger.warning("Stable identity cache write failed: %s", exc)
    return generated


stable_agent_identity_id = _load_or_create_stable_agent_identity_id()


def _empty_local_room_state(
    room_id: str,
    *,
    restored: bool,
    recovered_from_corrupt_cache: bool = False,
    corrupt_cache_path: Optional[str] = None,
) -> dict:
    summary = _build_local_room_summary(
        room_id=room_id.upper(),
        room_state={},
        messages=[],
        retry_queue=[],
    )
    return {
        "room_id": room_id.upper(),
        "messages": [],
        "retry_queue": [],
        "last_read_sequence": 0,
        "last_sequence": 0,
        "summary": summary,
        "restored": restored,
        "cached_at": None,
        "recovered_from_corrupt_cache": recovered_from_corrupt_cache,
        "corrupt_cache_path": corrupt_cache_path,
    }


def _prune_corrupt_cache_files():
    corrupt_dir = _corrupt_cache_dir()
    if not corrupt_dir.exists():
        return
    candidates = sorted(
        [path for path in corrupt_dir.glob("*.json") if path.is_file()],
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    for path in candidates[LOCAL_CORRUPT_CACHE_LIMIT:]:
        try:
            path.unlink()
        except OSError as exc:
            logger.warning("Corrupt cache cleanup failed for %s: %s", path, exc)


def _quarantine_corrupt_cache(cache_path: Path) -> Optional[str]:
    corrupt_dir = _corrupt_cache_dir()
    corrupt_dir.mkdir(parents=True, exist_ok=True)
    destination = corrupt_dir / f"{cache_path.stem}-{uuid.uuid4().hex[:8]}.json"
    try:
        cache_path.replace(destination)
    except OSError as exc:
        logger.warning("Local cache quarantine failed for %s: %s", cache_path, exc)
        return None
    _prune_corrupt_cache_files()
    return str(destination)


def _prune_local_cache_files(active_room_id: Optional[str] = None):
    cache_dir = _room_cache_dir()
    if cache_dir.exists():
        active_room_id = active_room_id.upper() if isinstance(active_room_id, str) else None
        cutoff = time.time() - LOCAL_ROOM_CACHE_TTL_SECONDS
        room_files = sorted(
            [path for path in cache_dir.glob("*.json") if path.is_file()],
            key=lambda path: path.stat().st_mtime,
        )
        kept: list[Path] = []
        for cache_path in room_files:
            room_id = cache_path.stem.upper()
            if active_room_id and room_id == active_room_id:
                kept.append(cache_path)
                continue
            try:
                if cache_path.stat().st_mtime < cutoff:
                    cache_path.unlink()
                    continue
            except OSError as exc:
                logger.warning("Local cache retention cleanup failed for %s: %s", cache_path, exc)
                continue
            kept.append(cache_path)

        overflow_candidates = [
            path for path in kept
            if not active_room_id or path.stem.upper() != active_room_id
        ]
        while len(kept) > LOCAL_ROOM_CACHE_LIMIT and overflow_candidates:
            cache_path = overflow_candidates.pop(0)
            try:
                cache_path.unlink()
                kept.remove(cache_path)
            except OSError as exc:
                logger.warning("Local cache compaction failed for %s: %s", cache_path, exc)

    _prune_corrupt_cache_files()


def _load_local_room_state(room_id: str) -> dict:
    cache_path = _room_cache_path(room_id)
    if not cache_path.exists():
        return _empty_local_room_state(room_id, restored=False)
    try:
        if cache_path.stat().st_mtime < time.time() - LOCAL_ROOM_CACHE_TTL_SECONDS:
            cache_path.unlink()
            return _empty_local_room_state(room_id, restored=False)
    except OSError as exc:
        logger.warning("Local cache stat failed for %s: %s", cache_path, exc)
        return _empty_local_room_state(room_id, restored=False)
    try:
        payload = json.loads(cache_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        quarantined_path = _quarantine_corrupt_cache(cache_path)
        return _empty_local_room_state(
            room_id,
            restored=False,
            recovered_from_corrupt_cache=True,
            corrupt_cache_path=quarantined_path,
        )

    if not isinstance(payload, dict):
        quarantined_path = _quarantine_corrupt_cache(cache_path)
        return _empty_local_room_state(
            room_id,
            restored=False,
            recovered_from_corrupt_cache=True,
            corrupt_cache_path=quarantined_path,
        )

    messages = _compact_messages(payload.get("messages", []))
    retry_queue = _normalized_retry_queue(payload.get("retry_queue"))
    room_state_for_summary = payload.get("summary", {}).get("room")
    if not isinstance(room_state_for_summary, dict):
        room_state_for_summary = {}
    summary = payload.get("summary")
    if not isinstance(summary, dict):
        summary = _build_local_room_summary(
            room_id=payload.get("room_id", room_id.upper()),
            room_state=room_state_for_summary,
            messages=messages,
            retry_queue=retry_queue,
            cached_at=payload.get("cached_at"),
        )
    else:
        summary = _refresh_local_summary_metadata(summary, payload.get("cached_at"))
    return {
        "room_id": payload.get("room_id", room_id.upper()),
        "messages": messages,
        "retry_queue": retry_queue,
        "last_read_sequence": _safe_int(payload.get("last_read_sequence")),
        "last_sequence": _safe_int(payload.get("last_sequence")),
        "cached_at": payload.get("cached_at"),
        "summary": summary,
        "restored": True,
        "recovered_from_corrupt_cache": False,
        "corrupt_cache_path": None,
    }


def _persist_local_room_state():
    if current_room is None:
        return
    room_id = current_room.get("room_id")
    if not isinstance(room_id, str) or not room_id:
        return
    messages = _compact_messages([
        message
        for message in inbox[-LOCAL_INBOX_LIMIT:]
        if isinstance(message, dict) and message.get("room_id", room_id) == room_id
    ])
    retry_queue = _normalized_retry_queue(current_room.get("retry_queue"))
    summary = _build_local_room_summary(
        room_id=room_id,
        room_state=current_room,
        messages=messages,
        retry_queue=retry_queue,
    )
    current_room["local_summary"] = summary
    payload = {
        "version": LOCAL_STATE_VERSION,
        "server": AGENTLINK_URL,
        "room_id": room_id,
        "cached_at": summary["cached_at"],
        "last_sequence": _safe_int(current_room.get("last_sequence")),
        "last_read_sequence": _safe_int(current_room.get("last_read_sequence")),
        "messages": messages,
        "retry_queue": retry_queue,
        "summary": summary,
    }
    try:
        _write_json_file(_room_cache_path(room_id), payload)
        _prune_local_cache_files(active_room_id=room_id)
    except OSError as exc:
        logger.warning("Local cache write failed: %s", exc)


def _restore_local_room_state(room_id: str):
    cached = _load_local_room_state(room_id)
    merged_messages = []
    seen_keys = set()
    live_messages = [
        message
        for message in inbox
        if isinstance(message, dict) and message.get("room_id", room_id) == room_id
    ]
    for message in [*cached["messages"], *live_messages]:
        key = (
            message.get("message_id"),
            message.get("sequence"),
            message.get("event"),
            message.get("agent_id"),
            message.get("timestamp"),
        )
        if key in seen_keys:
            continue
        seen_keys.add(key)
        merged_messages.append(message)
    inbox[:] = _compact_messages(merged_messages)
    if current_room is None:
        return
    current_room["retry_queue"] = cached["retry_queue"]
    current_room["last_read_sequence"] = cached["last_read_sequence"]
    current_room["local_cache_path"] = str(_room_cache_path(room_id))
    current_room["local_cached_message_count"] = len(inbox)
    current_room["local_cached_last_sequence"] = cached["last_sequence"]
    current_room["local_cache_restored"] = cached["restored"]
    current_room["local_cache_restored_at"] = cached.get("cached_at")
    current_room["local_cache_recovered"] = cached.get("recovered_from_corrupt_cache", False)
    current_room["local_cache_recovery_path"] = cached.get("corrupt_cache_path")
    current_room["local_retry_queue_count"] = len(cached["retry_queue"])
    current_room["local_summary"] = cached["summary"]
    _persist_local_room_state()


def _append_inbox_entry(entry: dict):
    room_id = entry.get("room_id")
    if room_id is None and current_room is not None:
        room_id = current_room.get("room_id")
        if room_id is not None:
            entry = {**entry, "room_id": room_id}
    inbox.append(entry)
    inbox[:] = _compact_messages(inbox)
    _persist_local_room_state()


def _read_local_room_summary(room_id: str) -> dict:
    cached = _load_local_room_state(room_id)
    summary = cached.get("summary")
    if not isinstance(summary, dict):
        summary = _build_local_room_summary(
            room_id=room_id.upper(),
            room_state={},
            messages=cached.get("messages", []),
            retry_queue=cached.get("retry_queue", []),
            cached_at=cached.get("cached_at"),
        )
    return {
        "room_id": room_id.upper(),
        "cache_path": str(_room_cache_path(room_id)),
        "restored": cached.get("restored", False),
        "recovered_from_corrupt_cache": cached.get("recovered_from_corrupt_cache", False),
        "corrupt_cache_path": cached.get("corrupt_cache_path"),
        "summary": summary,
    }


def _list_local_room_summaries() -> list[dict]:
    _prune_local_cache_files()
    cache_dir = _room_cache_dir()
    if not cache_dir.exists():
        return []
    summaries = []
    for cache_path in sorted(cache_dir.glob("*.json")):
        room_id = cache_path.stem.upper()
        summaries.append(_read_local_room_summary(room_id))
    return summaries


def _retry_backoff_seconds(attempts: int) -> int:
    return min(300, 5 * (2 ** min(attempts, 5)))


def _is_retry_entry_expired(entry: dict) -> bool:
    return _iso_to_timestamp(entry.get("expires_at")) <= time.time()


def _enqueue_retry_action(action: str, payload: dict, *, reason: str) -> dict:
    if current_room is None:
        raise RuntimeError("Tidak sedang di dalam room.")
    entry = _normalize_retry_entry({
        "retry_id": uuid.uuid4().hex,
        "room_id": current_room.get("room_id"),
        "action": action,
        "payload": payload,
        "created_at": _now_iso(),
        "updated_at": _now_iso(),
        "expires_at": datetime.now(timezone.utc).timestamp() + LOCAL_RETRY_TTL_SECONDS,
        "attempts": 0,
        "last_error": reason,
        "next_retry_at": _now_iso(),
    })
    if entry is None:
        raise RuntimeError("Gagal menyiapkan retry queue lokal.")
    entry["expires_at"] = datetime.fromtimestamp(
        time.time() + LOCAL_RETRY_TTL_SECONDS,
        tz=timezone.utc,
    ).isoformat()
    queue = _retry_queue()
    queue.append(entry)
    queue[:] = _normalized_retry_queue(queue)
    current_room["local_retry_queue_count"] = len(queue)
    _persist_local_room_state()
    return entry


def _drop_retry_entry(retry_id: str):
    if current_room is None:
        return
    queue = _retry_queue()
    queue[:] = [entry for entry in queue if entry.get("retry_id") != retry_id]
    current_room["local_retry_queue_count"] = len(queue)
    _persist_local_room_state()


def _mark_retry_entry_attempt(entry: dict, *, error: str):
    queue = _retry_queue()
    for candidate in queue:
        if candidate.get("retry_id") != entry.get("retry_id"):
            continue
        attempts = _safe_int(candidate.get("attempts")) + 1
        candidate["attempts"] = attempts
        candidate["updated_at"] = _now_iso()
        candidate["last_error"] = error
        candidate["next_retry_at"] = datetime.fromtimestamp(
            time.time() + _retry_backoff_seconds(attempts),
            tz=timezone.utc,
        ).isoformat()
        break
    queue[:] = [
        candidate
        for candidate in _normalized_retry_queue(queue)
        if _safe_int(candidate.get("attempts")) < LOCAL_RETRY_MAX_ATTEMPTS
        and not _is_retry_entry_expired(candidate)
    ]
    if current_room is not None:
        current_room["local_retry_queue_count"] = len(queue)
    _persist_local_room_state()


def _prune_retry_queue():
    if current_room is None:
        return
    queue = _retry_queue()
    queue[:] = [
        entry
        for entry in _normalized_retry_queue(queue)
        if _safe_int(entry.get("attempts")) < LOCAL_RETRY_MAX_ATTEMPTS
        and not _is_retry_entry_expired(entry)
    ]
    current_room["local_retry_queue_count"] = len(queue)
    _persist_local_room_state()

def _update_room_sequence(msg: dict):
    if current_room is None:
        return
    sequence = msg.get("sequence")
    if isinstance(sequence, int):
        last_sequence = current_room.get("last_sequence", 0)
        if sequence > last_sequence:
            current_room["last_sequence"] = sequence

def _room_peers() -> dict:
    if current_room is None:
        return {}
    peers = current_room.setdefault("peers", {})
    if isinstance(peers, dict):
        return peers
    current_room["peers"] = {}
    return current_room["peers"]

def _set_peer_state(agent_id_value: Optional[str], *, stable_agent_identity_id: Optional[str],
    name: Optional[str], presence: str, joined_at: Optional[str], last_seen_at: Optional[str]):
    if not agent_id_value:
        return
    peers = _room_peers()
    existing = peers.get(agent_id_value, {})
    peers[agent_id_value] = {
        "agent_id": agent_id_value,
        "stable_agent_identity_id": (
            stable_agent_identity_id
            or existing.get("stable_agent_identity_id")
        ),
        "name": name or existing.get("name"),
        "presence": presence,
        "joined_at": joined_at or existing.get("joined_at"),
        "last_seen_at": last_seen_at or existing.get("last_seen_at") or _now_iso(),
    }

def _remove_peer_state(agent_id_value: Optional[str]):
    if not agent_id_value or current_room is None:
        return
    _room_peers().pop(agent_id_value, None)

def _update_pong(msg: dict):
    if current_room is None:
        return
    current_room["last_pong_at"] = msg.get("timestamp", _now_iso())
    current_room["last_pong_monotonic"] = time.monotonic()
    if "last_seen_at" in msg:
        current_room["last_seen_at"] = msg.get("last_seen_at")
    if "heartbeat_interval_seconds" in msg:
        current_room["heartbeat_interval_seconds"] = msg.get("heartbeat_interval_seconds")
    if "heartbeat_timeout_seconds" in msg:
        current_room["heartbeat_timeout_seconds"] = msg.get("heartbeat_timeout_seconds")
    sent_at = msg.get("echo_sent_at")
    if isinstance(sent_at, str):
        try:
            latency_ms = int((datetime.now(timezone.utc) - datetime.fromisoformat(sent_at)).total_seconds() * 1000)
            current_room["last_heartbeat_latency_ms"] = latency_ms
        except ValueError:
            pass

def _cancel_reconnect_task():
    global reconnect_task
    if reconnect_task is not None and not reconnect_task.done():
        reconnect_task.cancel()
    reconnect_task = None


def _cancel_retry_replay_task():
    global retry_replay_task
    if retry_replay_task is not None and not retry_replay_task.done():
        retry_replay_task.cancel()
    retry_replay_task = None


def _room_resource_auth_params(room_id: str) -> dict[str, str]:
    normalized_room_id = room_id.upper()
    if (
        room_credentials is None
        or room_credentials.get("room_id") != normalized_room_id
    ):
        return {}
    token = room_credentials.get("token")
    if isinstance(token, str) and token:
        return {"token": token}
    return {}


async def _fetch_room_resource(path_prefix: str, room_id: str, resource_path: str) -> dict[str, Any]:
    if http_session is None:
        raise RuntimeError("HTTP session belum siap.")

    normalized_room_id = room_id.upper()
    suffix = f"/{resource_path}" if resource_path else ""
    url = f"{AGENTLINK_URL}/{path_prefix}/{normalized_room_id}{suffix}"
    status_code = 0
    async with http_session.get(
        url,
        params=_room_resource_auth_params(normalized_room_id),
    ) as response:
        status_code = response.status
        try:
            payload = await response.json()
        except Exception:
            payload = {
                "success": False,
                "error": await response.text(),
            }

    if status_code >= 400:
        message = payload.get("error") if isinstance(payload, dict) else None
        raise RuntimeError(
            message
            or f"Gagal membaca capability resource '{resource_path}' untuk room '{normalized_room_id}'."
        )

    if isinstance(payload, dict):
        return payload

    return {
        "success": True,
        "room_id": normalized_room_id,
        "data": payload,
    }


async def _fetch_capability_resource(room_id: str, resource_path: str) -> dict[str, Any]:
    return await _fetch_room_resource("capabilities", room_id, resource_path)


async def _fetch_task_resource(room_id: str, resource_path: str = "") -> dict[str, Any]:
    return await _fetch_room_resource("tasks", room_id, resource_path)


def _require_capability_context() -> tuple[str, str]:
    if current_room is None or not isinstance(current_room.get("room_id"), str):
        raise RuntimeError("Tidak sedang di dalam room. Jalankan room_join dulu.")
    if ws_conn is None:
        raise RuntimeError("Koneksi room sedang tidak aktif. Coba tunggu reconnect atau join ulang.")
    if not isinstance(agent_id, str) or not agent_id:
        raise RuntimeError("Agent ID belum tersedia. Coba join room ulang.")
    return current_room["room_id"].upper(), agent_id


async def _fetch_self_capability_profile() -> dict[str, Any]:
    room_id, self_agent_id = _require_capability_context()
    payload = await _fetch_capability_resource(
        room_id,
        f"agents/{quote(self_agent_id, safe='')}",
    )
    agent_payload = payload.get("agent")
    if not isinstance(agent_payload, dict):
        raise RuntimeError("Capability profile diri sendiri tidak ditemukan.")
    return payload


def _require_task_context() -> tuple[str, str, str]:
    room_id, self_agent_id = _require_capability_context()
    if not stable_agent_identity_id:
        raise RuntimeError("Stable agent identity belum tersedia.")
    return room_id, self_agent_id, stable_agent_identity_id


async def _fetch_task_by_id(room_id: str, task_id: str) -> dict[str, Any]:
    return await _fetch_task_resource(room_id, quote(task_id, safe=""))


def _schedule_retry_replay(delay: float = 0.0):
    global retry_replay_task
    if current_room is None or ws_conn is None:
        return
    if not _retry_queue():
        return
    if retry_replay_task is not None and not retry_replay_task.done():
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    retry_replay_task = loop.create_task(_replay_retry_queue(delay=delay))

async def _open_room_connection(rid: str, token: Optional[str]) -> tuple[Any, dict]:
    query = {
        "name": agent_name,
        "session_id": client_session_id,
        "stable_agent_identity_id": stable_agent_identity_id,
    }
    if token:
        query["token"] = token
    qs = urlencode(query)
    conn = await asyncio.wait_for(websockets.connect(
        f"{WS_BASE}/connect/{rid}?{qs}",
        ping_interval=20,
        ping_timeout=20,
        close_timeout=5,
    ), timeout=15)
    welcome = json.loads(await asyncio.wait_for(conn.recv(), timeout=10))
    if welcome.get("type") != "welcome":
        try:
            await conn.close()
        except Exception:
            pass
        raise RuntimeError(f"Unexpected response: {welcome}")
    return conn, welcome

async def _connect_room(rid: str, token: Optional[str], *, reconnecting: bool = False) -> dict:
    global ws_conn, current_room, agent_id, room_credentials, stable_agent_identity_id
    conn, welcome = await _open_room_connection(rid, token)
    agent_id = welcome.get("agent_id", agent_id)
    welcome_stable_identity_id = _sanitize_stable_agent_identity_id(
        welcome.get("stable_agent_identity_id"),
    )
    if welcome_stable_identity_id:
        stable_agent_identity_id = welcome_stable_identity_id
        try:
            _persist_stable_agent_identity_id(stable_agent_identity_id)
        except Exception as exc:
            logger.warning("Stable identity cache write failed after welcome: %s", exc)
    peers = {}
    for peer in welcome.get("agents", []):
        peer_agent_id = peer.get("agent_id")
        if peer_agent_id:
            peers[peer_agent_id] = peer
    current_room = {
        "room_id": rid,
        "last_sequence": welcome.get("last_sequence", 0),
        "joined_at": welcome.get("joined_at"),
        "last_seen_at": welcome.get("last_seen_at"),
        "presence": welcome.get("presence", "online"),
        "stable_agent_identity_id": stable_agent_identity_id,
        "session_resumed": welcome.get("session_resumed", False),
        "heartbeat_interval_seconds": welcome.get("heartbeat_interval_seconds", 30),
        "heartbeat_timeout_seconds": welcome.get("heartbeat_timeout_seconds", 90),
        "reconnect_window_seconds": welcome.get("reconnect_window_seconds", 120),
        "last_pong_at": _now_iso(),
        "last_pong_monotonic": time.monotonic(),
        "reconnecting": False,
        "reconnect_attempts": 0,
        "last_reconnect_error": None,
        "last_read_sequence": 0,
        "local_cache_path": str(_room_cache_path(rid)),
        "local_cached_message_count": 0,
        "local_cached_last_sequence": 0,
        "local_cache_restored": False,
        "local_cache_restored_at": None,
        "retry_queue": [],
        "local_retry_queue_count": 0,
        "peers": peers,
    }
    room_credentials = {"room_id": rid, "token": token}
    ws_conn = conn
    _restore_local_room_state(rid)
    if reconnecting:
        _append_inbox_entry({
            "type": "event",
            "event": "client_reconnected",
            "agent_id": agent_id,
            "room_id": rid,
            "session_resumed": current_room.get("session_resumed", False),
            "timestamp": _now_iso(),
        })
    _schedule_retry_replay(delay=1.0 if reconnecting else 0.0)
    return welcome

def _schedule_reconnect():
    global reconnect_task
    if not auto_reconnect_enabled or room_credentials is None or current_room is None:
        return
    if reconnect_task is not None and not reconnect_task.done():
        return
    reconnect_task = asyncio.create_task(_reconnect_loop())

def _fail_pending_acks(reason: str):
    error = RuntimeError(reason)
    for request_id, future in list(pending_acks.items()):
        if not future.done():
            future.set_exception(error)
        pending_acks.pop(request_id, None)

async def _await_ack(payload: dict, timeout: float = 5.0) -> tuple[str, Optional[dict]]:
    request_id = uuid.uuid4().hex
    loop = asyncio.get_running_loop()
    future = loop.create_future()
    pending_acks[request_id] = future
    try:
        await ws_conn.send(json.dumps({**payload, "request_id": request_id}))
        ack = await asyncio.wait_for(future, timeout=timeout)
        return request_id, ack
    except asyncio.TimeoutError:
        pending_acks.pop(request_id, None)
        return request_id, None
    finally:
        if request_id in pending_acks and pending_acks[request_id].done():
            pending_acks.pop(request_id, None)


async def _replay_retry_queue(delay: float = 0.0):
    global retry_replay_task
    try:
        if delay > 0:
            await asyncio.sleep(delay)
        while current_room is not None and ws_conn is not None:
            _prune_retry_queue()
            queue = list(_retry_queue())
            if not queue:
                return
            now = time.time()
            ready_entry = None
            for entry in queue:
                if _iso_to_timestamp(entry.get("next_retry_at")) <= now:
                    ready_entry = entry
                    break
            if ready_entry is None:
                return
            try:
                _, ack = await _await_ack(ready_entry["payload"], timeout=5.0)
            except Exception as exc:
                _mark_retry_entry_attempt(ready_entry, error=str(exc))
                return

            delivered = isinstance(ack, dict) and bool(ack.get("delivered", False))
            if delivered:
                _drop_retry_entry(ready_entry["retry_id"])
                continue

            if ack is None:
                _mark_retry_entry_attempt(ready_entry, error="ACK timeout")
                return

            _mark_retry_entry_attempt(
                ready_entry,
                error=f"Not delivered ({ready_entry['action']})",
            )
            return
    finally:
        retry_replay_task = None

async def _reconnect_loop():
    global reconnect_task
    attempt = 0
    try:
        while auto_reconnect_enabled and room_credentials is not None and current_room is not None and ws_conn is None:
            attempt += 1
            current_room["reconnecting"] = True
            current_room["reconnect_attempts"] = attempt
            try:
                await _connect_room(
                    room_credentials["room_id"],
                    room_credentials.get("token"),
                    reconnecting=True,
                )
                if current_room is not None:
                    current_room["reconnect_attempts"] = attempt
                return
            except asyncio.CancelledError:
                raise
            except Exception as e:
                if current_room is not None:
                    current_room["last_reconnect_error"] = str(e)
                await asyncio.sleep(min(30, 2 ** min(attempt, 4)))
    finally:
        reconnect_task = None

async def ws_listen():
    global ws_conn, agent_id
    while True:
        if ws_conn is None:
            await asyncio.sleep(1)
            continue
        conn = ws_conn
        try:
            async for raw in conn:
                try:
                    _handle_incoming(json.loads(raw))
                except Exception as e:
                    logger.warning(f"Parse error: {e}")
        except ConnectionClosed:
            _fail_pending_acks("WebSocket connection closed.")
        except Exception as e:
            logger.warning(f"WS error: {e}")
            _fail_pending_acks(f"WebSocket error: {e}")
        finally:
            if ws_conn is conn:
                ws_conn = None
                if current_room is not None:
                    current_room["reconnecting"] = auto_reconnect_enabled
                _schedule_reconnect()
        await asyncio.sleep(2)

def _handle_incoming(msg: dict):
    global agent_id, stable_agent_identity_id
    t = msg.get("type")
    if t == "welcome":
        agent_id = msg.get("agent_id", agent_id)
        welcome_stable_identity_id = _sanitize_stable_agent_identity_id(
            msg.get("stable_agent_identity_id"),
        )
        if welcome_stable_identity_id:
            stable_agent_identity_id = welcome_stable_identity_id
            try:
                _persist_stable_agent_identity_id(stable_agent_identity_id)
            except Exception as exc:
                logger.warning("Stable identity cache write failed during welcome: %s", exc)
        if current_room is not None:
            current_room["last_sequence"] = msg.get("last_sequence", current_room.get("last_sequence", 0))
            current_room["joined_at"] = msg.get("joined_at", current_room.get("joined_at"))
            current_room["last_seen_at"] = msg.get("last_seen_at", current_room.get("last_seen_at"))
            current_room["presence"] = msg.get("presence", current_room.get("presence", "online"))
            current_room["stable_agent_identity_id"] = stable_agent_identity_id
            current_room["session_resumed"] = msg.get("session_resumed", current_room.get("session_resumed", False))
            current_room["heartbeat_interval_seconds"] = msg.get("heartbeat_interval_seconds", current_room.get("heartbeat_interval_seconds", 30))
            current_room["heartbeat_timeout_seconds"] = msg.get("heartbeat_timeout_seconds", current_room.get("heartbeat_timeout_seconds", 90))
            current_room["reconnect_window_seconds"] = msg.get("reconnect_window_seconds", current_room.get("reconnect_window_seconds", 120))
            current_room["last_pong_at"] = _now_iso()
            current_room["last_pong_monotonic"] = time.monotonic()
            current_room["reconnecting"] = False
            current_room["last_reconnect_error"] = None
            peers = {}
            for peer in msg.get("agents", []):
                peer_agent_id = peer.get("agent_id")
                if peer_agent_id:
                    peers[peer_agent_id] = peer
            current_room["peers"] = peers
        for peer in msg.get("agents", []):
            _append_inbox_entry({"type": "event", "event": "agent_online",
                "from": peer.get("name"), "agent_id": peer.get("agent_id"),
                "stable_agent_identity_id": peer.get("stable_agent_identity_id"),
                "presence": peer.get("presence", "online"),
                "joined_at": peer.get("joined_at"),
                "last_seen_at": peer.get("last_seen_at"),
                "timestamp": _now_iso()})
        _persist_local_room_state()
        _schedule_retry_replay(delay=0.5)
    elif t == "message":
        _update_room_sequence(msg)
        _append_inbox_entry({"type": "message", "from": msg.get("from_name", "unknown"),
            "agent_id": msg.get("from"), "content": msg.get("content", ""),
            "msg_type": msg.get("msg_type", "text"), "broadcast": msg.get("broadcast", False),
            "message_id": msg.get("message_id"), "sequence": msg.get("sequence"),
            "room_id": msg.get("room_id"),
            "timestamp": msg.get("timestamp", _now_iso())})
    elif t == "event":
        _update_room_sequence(msg)
        event_name = msg.get("event")
        event_agent_id = msg.get("agent_id")
        if event_name in {"agent_joined", "agent_reconnected"}:
            _set_peer_state(event_agent_id,
                stable_agent_identity_id=msg.get("stable_agent_identity_id"),
                name=msg.get("name"),
                presence=msg.get("presence", "online"), joined_at=msg.get("joined_at"),
                last_seen_at=msg.get("last_seen_at"))
            _schedule_retry_replay(delay=0.5)
        elif event_name == "agent_left":
            _remove_peer_state(event_agent_id)
        _append_inbox_entry({"type": "event", "event": msg.get("event"),
            "from": msg.get("name"), "agent_id": msg.get("agent_id"),
            "stable_agent_identity_id": msg.get("stable_agent_identity_id"),
            "task_id": msg.get("task_id"),
            "task": msg.get("task"),
            "message_id": msg.get("message_id"), "sequence": msg.get("sequence"),
            "room_id": msg.get("room_id"),
            "presence": msg.get("presence"),
            "joined_at": msg.get("joined_at"),
            "last_seen_at": msg.get("last_seen_at"),
            "session_resumed": msg.get("session_resumed"),
            "timestamp": msg.get("timestamp", _now_iso())})
    elif t == "pong":
        _update_pong(msg)
    elif t == "ack":
        request_id = msg.get("request_id")
        if isinstance(request_id, str):
            future = pending_acks.pop(request_id, None)
            if future is not None and not future.done():
                future.set_result(msg)
    elif t == "error":
        request_id = msg.get("request_id")
        if isinstance(request_id, str):
            future = pending_acks.pop(request_id, None)
            if future is not None and not future.done():
                future.set_exception(RuntimeError(str(msg.get("error", "Unknown room error"))))

async def heartbeat_loop():
    global ws_conn
    while True:
        await asyncio.sleep(5)
        if ws_conn is not None and current_room is not None:
            interval = current_room.get("heartbeat_interval_seconds", 30)
            timeout = current_room.get("heartbeat_timeout_seconds", 90)
            now_monotonic = time.monotonic()
            try:
                last_sent = current_room.get("last_heartbeat_sent_monotonic", 0.0)
                if now_monotonic - float(last_sent) >= float(interval):
                    sent_at = _now_iso()
                    await ws_conn.send(json.dumps({"type": "ping", "sent_at": sent_at}))
                    current_room["last_heartbeat_sent_at"] = sent_at
                    current_room["last_heartbeat_sent_monotonic"] = now_monotonic
            except Exception:
                pass
            last_pong = current_room.get("last_pong_monotonic")
            if isinstance(last_pong, (int, float)) and now_monotonic - float(last_pong) > float(timeout):
                try:
                    await ws_conn.close()
                except Exception:
                    ws_conn = None
                    _schedule_reconnect()

@asynccontextmanager
async def lifespan(server):
    global http_session
    http_session = aiohttp.ClientSession()
    t1 = asyncio.create_task(ws_listen())
    t2 = asyncio.create_task(heartbeat_loop())
    yield {}
    t1.cancel(); t2.cancel()
    _cancel_reconnect_task()
    _cancel_retry_replay_task()
    if ws_conn:
        try: await ws_conn.close()
        except Exception: pass
    await http_session.close()

mcp = FastMCP("agentlink", instructions=SERVER_INSTRUCTIONS, lifespan=lifespan)

class RegisterInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    name: Optional[str] = Field(default=None, description="Nama agent (opsional)")

class CreateRoomInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    name:       str  = Field(..., description="Nama room", min_length=1, max_length=50)
    is_private: bool = Field(default=False, description="True = private (butuh token), False = public")

class JoinRoomInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    room_id: str           = Field(..., description="ID room (6 karakter, contoh: ABC123)")
    token:   Optional[str] = Field(default=None, description="Token untuk private room")

class SendInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    peer_id:  str = Field(..., description="Agent ID peer tujuan")
    message:  str = Field(..., description="Isi pesan", min_length=1, max_length=10000)
    msg_type: str = Field(default="text", description="Tipe: 'text'/'data'/'command'")

class BroadcastInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    message:  str = Field(..., description="Isi pesan ke semua peer", min_length=1)
    msg_type: str = Field(default="text", description="Tipe pesan")

class ReadInboxInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    limit: int  = Field(default=10, ge=1, le=100, description="Jumlah pesan")
    only_unread: bool = Field(default=False, description="True = hanya tampilkan pesan di atas cursor baca lokal")
    mark_read: bool = Field(default=True, description="True = simpan cursor baca lokal dari hasil yang dibaca")
    clear: bool = Field(default=False, description="Hapus setelah dibaca")


class LocalRoomSummaryInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    room_id: Optional[str] = Field(default=None, description="ID room untuk membaca snapshot lokal tertentu")


@mcp.resource(
    "ssyubix://guides/readme-first",
    name="ssyubix-readme-first",
    description="Panduan onboarding dan best practice untuk agent yang baru memakai ssyubix.",
    mime_type="text/markdown",
)
def readme_first_resource() -> str:
    return READ_ME_FIRST_MARKDOWN


@mcp.prompt(
    name="ssyubix_readme_first",
    title="ssyubix Readme First",
    description="Prompt onboarding ringkas untuk agent yang baru memakai ssyubix.",
)
def readme_first_prompt() -> str:
    return READ_ME_FIRST_PROMPT


class CapabilitySkillInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    id: str = Field(..., min_length=1, max_length=64, description="ID skill stabil, contoh: code_review")
    name: str = Field(..., min_length=1, max_length=80, description="Nama skill")
    description: str = Field(default="", max_length=240, description="Deskripsi singkat skill")
    tags: list[str] = Field(default_factory=list, description="Tag skill")
    examples: list[str] = Field(default_factory=list, description="Contoh use case ringkas")
    input_modes: list[str] = Field(default_factory=list, description="Mode input yang didukung")
    output_modes: list[str] = Field(default_factory=list, description="Mode output yang didukung")

    @field_validator("id")
    @classmethod
    def normalize_skill_id(cls, value: str) -> str:
        normalized = value.strip().lower().replace(" ", "_")
        if not normalized:
            raise ValueError("skill id tidak boleh kosong")
        if not all(ch.isalnum() or ch in "._-" for ch in normalized):
            raise ValueError("skill id hanya boleh berisi huruf kecil, angka, titik, underscore, atau dash")
        return normalized

    @field_validator("tags", "examples", "input_modes", "output_modes")
    @classmethod
    def normalize_string_lists(cls, value: list[str]) -> list[str]:
        deduped: list[str] = []
        seen: set[str] = set()
        for entry in value:
            normalized = " ".join(entry.split()).strip()
            if not normalized or normalized in seen:
                continue
            seen.add(normalized)
            deduped.append(normalized)
        return deduped


class CapabilityUpsertInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    summary: Optional[str] = Field(default=None, max_length=500, description="Ringkasan singkat agent")
    version: Optional[str] = Field(default=None, max_length=64, description="Versi capability card agent")
    tool_access: Optional[list[str]] = Field(default=None, description="Akses tool yang dimiliki agent")
    constraints: Optional[list[str]] = Field(default=None, description="Batasan atau guardrail agent")
    max_concurrent_tasks: Optional[int] = Field(default=None, ge=1, le=100, description="Batas tugas paralel")
    current_load: Optional[int] = Field(default=None, ge=0, le=100, description="Perkiraan beban kerja saat ini")
    skills: Optional[list[CapabilitySkillInput]] = Field(default=None, description="Daftar skill yang dideklarasikan")

    @field_validator("tool_access", "constraints")
    @classmethod
    def normalize_optional_lists(cls, value: Optional[list[str]]) -> Optional[list[str]]:
        if value is None:
            return None
        deduped: list[str] = []
        seen: set[str] = set()
        for entry in value:
            normalized = " ".join(entry.split()).strip()
            if not normalized or normalized in seen:
                continue
            seen.add(normalized)
            deduped.append(normalized)
        return deduped

    @model_validator(mode="after")
    def validate_payload(self):
        if not self.model_fields_set:
            raise ValueError("Setidaknya satu field capability harus diisi.")
        if (
            self.max_concurrent_tasks is not None
            and self.current_load is not None
            and self.current_load > self.max_concurrent_tasks
        ):
            raise ValueError("current_load tidak boleh melebihi max_concurrent_tasks.")
        return self


class CapabilityAvailabilityInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    availability: Literal["available", "busy", "away", "dnd"] = Field(
        ...,
        description="Status kesiapan kerja agent",
    )
    current_load: Optional[int] = Field(default=None, ge=0, le=100, description="Perkiraan beban kerja saat ini")


class TaskOfferInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    title: str = Field(..., min_length=1, max_length=140, description="Judul task ringkas")
    to_agent_id: str = Field(..., min_length=1, description="Agent ID tujuan offer delegasi")
    priority: Literal["low", "normal", "high"] = Field(default="normal", description="Prioritas task")
    point_of_contact_agent_id: Optional[str] = Field(
        default=None,
        description="Agent ID yang jadi titik kontak follow-up. Default: pengirim offer.",
    )


class TaskTransitionInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    task_id: str = Field(..., min_length=1, description="ID task yang ingin diubah status delegation-nya")
    reason: Optional[str] = Field(default=None, max_length=240, description="Alasan ringkas reject/defer")


class TaskLookupInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    task_id: str = Field(..., min_length=1, description="ID task yang ingin dibaca")


class TaskDeferInput(TaskTransitionInput):
    deferred_until: Optional[str] = Field(
        default=None,
        description="Hint waktu ISO-8601 kapan task bisa ditinjau ulang",
    )

    @field_validator("deferred_until")
    @classmethod
    def validate_deferred_until(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        try:
            datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError("deferred_until harus berupa waktu ISO-8601 yang valid.") from exc
        return value


@mcp.resource(
    "ssyubix://rooms/{room_id}/agents",
    name="ssyubix-room-capability-agents",
    description="Capability registry per room untuk semua agent yang diketahui relay.",
    mime_type="application/json",
)
async def capability_agents_resource(room_id: str) -> str:
    payload = await _fetch_capability_resource(room_id, "agents")
    return json.dumps(payload, indent=2)


@mcp.resource(
    "ssyubix://rooms/{room_id}/agents/{agent_id}",
    name="ssyubix-room-capability-agent",
    description="Capability profile untuk satu agent pada room tertentu.",
    mime_type="application/json",
)
async def capability_agent_resource(room_id: str, agent_id: str) -> str:
    payload = await _fetch_capability_resource(room_id, f"agents/{quote(agent_id, safe='')}")
    return json.dumps(payload, indent=2)


@mcp.resource(
    "ssyubix://rooms/{room_id}/skills",
    name="ssyubix-room-capability-skills",
    description="Indeks skill ke agent-agent yang mendeklarasikannya pada room tertentu.",
    mime_type="application/json",
)
async def capability_skills_resource(room_id: str) -> str:
    payload = await _fetch_capability_resource(room_id, "skills")
    return json.dumps(payload, indent=2)


@mcp.resource(
    "ssyubix://rooms/{room_id}/skills/{skill_id}",
    name="ssyubix-room-capability-skill",
    description="Detail skill tertentu beserta agent yang mendeklarasikannya.",
    mime_type="application/json",
)
async def capability_skill_resource(room_id: str, skill_id: str) -> str:
    payload = await _fetch_capability_resource(room_id, f"skills/{quote(skill_id, safe='')}")
    return json.dumps(payload, indent=2)


@mcp.resource(
    "ssyubix://rooms/{room_id}/tasks",
    name="ssyubix-room-tasks",
    description="Delegation task manifest per room.",
    mime_type="application/json",
)
async def room_tasks_resource(room_id: str) -> str:
    payload = await _fetch_task_resource(room_id)
    return json.dumps(payload, indent=2)


@mcp.resource(
    "ssyubix://rooms/{room_id}/tasks/{task_id}",
    name="ssyubix-room-task",
    description="Detail satu delegation task pada room tertentu.",
    mime_type="application/json",
)
async def room_task_resource(room_id: str, task_id: str) -> str:
    payload = await _fetch_task_resource(room_id, quote(task_id, safe=""))
    return json.dumps(payload, indent=2)


@mcp.tool(name="capability_get_self")
async def capability_get_self() -> str:
    """
    Baca capability profile agent ini pada room yang sedang aktif.

    Returns:
        str: JSON capability profile diri sendiri
    """
    try:
        room_id, self_agent_id = _require_capability_context()
        payload = await _fetch_self_capability_profile()
        return json.dumps({
            "success": True,
            "room_id": room_id,
            "my_agent_id": self_agent_id,
            "resource_uri": f"ssyubix://rooms/{room_id}/agents/{self_agent_id}",
            **payload,
        }, indent=2)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})


@mcp.tool(name="capability_upsert_self")
async def capability_upsert_self(params: CapabilityUpsertInput) -> str:
    """
    Simpan atau perbarui capability card agent ini pada room aktif.

    Returns:
        str: JSON status update + profile terbaru
    """
    try:
        room_id, self_agent_id = _require_capability_context()
        payload = {"type": "capability_upsert"}
        payload.update(params.model_dump(exclude_unset=True))

        request_id, ack = await _await_ack(payload)
        if ack is None:
            return json.dumps({
                "success": False,
                "request_id": request_id,
                "error": "ACK timeout saat menyimpan capability profile.",
            })

        profile_payload = await _fetch_self_capability_profile()
        return json.dumps({
            "success": ack.get("accepted", False),
            "room_id": room_id,
            "my_agent_id": self_agent_id,
            "request_id": request_id,
            "message_id": ack.get("message_id"),
            "sequence": ack.get("sequence"),
            "resource_uri": f"ssyubix://rooms/{room_id}/agents/{self_agent_id}",
            **profile_payload,
        }, indent=2)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})


@mcp.tool(name="capability_set_availability")
async def capability_set_availability(params: CapabilityAvailabilityInput) -> str:
    """
    Update availability dan current load capability card agent ini.

    Returns:
        str: JSON status update + profile terbaru
    """
    try:
        room_id, self_agent_id = _require_capability_context()
        payload = {
            "type": "capability_set_availability",
            "availability": params.availability,
        }
        if params.current_load is not None:
            payload["current_load"] = params.current_load

        request_id, ack = await _await_ack(payload)
        if ack is None:
            return json.dumps({
                "success": False,
                "request_id": request_id,
                "error": "ACK timeout saat memperbarui availability capability.",
            })

        profile_payload = await _fetch_self_capability_profile()
        return json.dumps({
            "success": ack.get("accepted", False),
            "room_id": room_id,
            "my_agent_id": self_agent_id,
            "request_id": request_id,
            "message_id": ack.get("message_id"),
            "sequence": ack.get("sequence"),
            "resource_uri": f"ssyubix://rooms/{room_id}/agents/{self_agent_id}",
            **profile_payload,
        }, indent=2)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})


@mcp.tool(name="capability_remove_self")
async def capability_remove_self() -> str:
    """
    Hapus capability card kustom agent ini dan kembali ke profil minimal room.

    Returns:
        str: JSON status reset capability
    """
    try:
        room_id, self_agent_id = _require_capability_context()
        request_id, ack = await _await_ack({"type": "capability_remove"})
        if ack is None:
            return json.dumps({
                "success": False,
                "request_id": request_id,
                "error": "ACK timeout saat menghapus capability profile.",
            })

        profile_payload = await _fetch_self_capability_profile()
        return json.dumps({
            "success": ack.get("accepted", False),
            "room_id": room_id,
            "my_agent_id": self_agent_id,
            "request_id": request_id,
            "message_id": ack.get("message_id"),
            "sequence": ack.get("sequence"),
            "resource_uri": f"ssyubix://rooms/{room_id}/agents/{self_agent_id}",
            "message": "Capability profile kustom dihapus. Resource self sekarang kembali ke profil minimal room.",
            **profile_payload,
        }, indent=2)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})


@mcp.tool(name="task_offer")
async def task_offer(params: TaskOfferInput) -> str:
    """
    Tawarkan satu task delegasi ke agent tertentu pada room aktif.

    Returns:
        str: JSON status offer + task terbaru
    """
    try:
        room_id, self_agent_id, self_stable_identity_id = _require_task_context()
        payload = {
            "type": "task_offer",
            "title": params.title,
            "to_agent_id": params.to_agent_id,
            "priority": params.priority,
        }
        if params.point_of_contact_agent_id:
            payload["point_of_contact_agent_id"] = params.point_of_contact_agent_id

        request_id, ack = await _await_ack(payload)
        if ack is None:
            return json.dumps({
                "success": False,
                "request_id": request_id,
                "error": "ACK timeout saat mengirim delegation offer.",
            })

        task_id = ack.get("task_id")
        task_payload = (
            await _fetch_task_by_id(room_id, task_id)
            if isinstance(task_id, str) and task_id
            else {"success": False, "error": "Task ID tidak dikembalikan relay."}
        )
        return json.dumps({
            "success": ack.get("accepted", False),
            "room_id": room_id,
            "delegated_by": self_agent_id,
            "delegated_by_stable_identity_id": self_stable_identity_id,
            "request_id": request_id,
            "message_id": ack.get("message_id"),
            "sequence": ack.get("sequence"),
            "task_id": task_id,
            "resource_uri": f"ssyubix://rooms/{room_id}/tasks/{task_id}" if isinstance(task_id, str) and task_id else None,
            **task_payload,
        }, indent=2)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})


@mcp.tool(name="task_accept")
async def task_accept(params: TaskTransitionInput) -> str:
    """
    Terima delegation offer yang ditujukan ke agent ini.
    """
    try:
        room_id, self_agent_id, self_stable_identity_id = _require_task_context()
        request_id, ack = await _await_ack({
            "type": "task_accept",
            "task_id": params.task_id,
        })
        if ack is None:
            return json.dumps({
                "success": False,
                "request_id": request_id,
                "error": "ACK timeout saat menerima delegation offer.",
            })
        task_payload = await _fetch_task_by_id(room_id, params.task_id)
        return json.dumps({
            "success": ack.get("accepted", False),
            "room_id": room_id,
            "my_agent_id": self_agent_id,
            "my_stable_identity_id": self_stable_identity_id,
            "request_id": request_id,
            "message_id": ack.get("message_id"),
            "sequence": ack.get("sequence"),
            "task_id": params.task_id,
            "resource_uri": f"ssyubix://rooms/{room_id}/tasks/{params.task_id}",
            **task_payload,
        }, indent=2)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})


@mcp.tool(name="task_reject")
async def task_reject(params: TaskTransitionInput) -> str:
    """
    Tolak delegation offer yang ditujukan ke agent ini.
    """
    try:
        room_id, self_agent_id, self_stable_identity_id = _require_task_context()
        payload = {
            "type": "task_reject",
            "task_id": params.task_id,
        }
        if params.reason:
            payload["reason"] = params.reason
        request_id, ack = await _await_ack(payload)
        if ack is None:
            return json.dumps({
                "success": False,
                "request_id": request_id,
                "error": "ACK timeout saat menolak delegation offer.",
            })
        task_payload = await _fetch_task_by_id(room_id, params.task_id)
        return json.dumps({
            "success": ack.get("accepted", False),
            "room_id": room_id,
            "my_agent_id": self_agent_id,
            "my_stable_identity_id": self_stable_identity_id,
            "request_id": request_id,
            "message_id": ack.get("message_id"),
            "sequence": ack.get("sequence"),
            "task_id": params.task_id,
            "resource_uri": f"ssyubix://rooms/{room_id}/tasks/{params.task_id}",
            **task_payload,
        }, indent=2)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})


@mcp.tool(name="task_defer")
async def task_defer(params: TaskDeferInput) -> str:
    """
    Tunda delegation offer yang ditujukan ke agent ini.
    """
    try:
        room_id, self_agent_id, self_stable_identity_id = _require_task_context()
        payload = {
            "type": "task_defer",
            "task_id": params.task_id,
        }
        if params.reason:
            payload["reason"] = params.reason
        if params.deferred_until:
            payload["deferred_until"] = params.deferred_until
        request_id, ack = await _await_ack(payload)
        if ack is None:
            return json.dumps({
                "success": False,
                "request_id": request_id,
                "error": "ACK timeout saat menunda delegation offer.",
            })
        task_payload = await _fetch_task_by_id(room_id, params.task_id)
        return json.dumps({
            "success": ack.get("accepted", False),
            "room_id": room_id,
            "my_agent_id": self_agent_id,
            "my_stable_identity_id": self_stable_identity_id,
            "request_id": request_id,
            "message_id": ack.get("message_id"),
            "sequence": ack.get("sequence"),
            "task_id": params.task_id,
            "resource_uri": f"ssyubix://rooms/{room_id}/tasks/{params.task_id}",
            **task_payload,
        }, indent=2)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})


@mcp.tool(name="task_list")
async def task_list() -> str:
    """
    Lihat daftar delegation task pada room aktif.
    """
    try:
        room_id, _, _ = _require_task_context()
        payload = await _fetch_task_resource(room_id)
        return json.dumps(payload, indent=2)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})


@mcp.tool(name="task_get")
async def task_get(params: TaskLookupInput) -> str:
    """
    Baca satu delegation task dari room aktif.
    """
    try:
        room_id, _, _ = _require_task_context()
        payload = await _fetch_task_by_id(room_id, params.task_id)
        return json.dumps(payload, indent=2)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})


@mcp.tool(name="agent_register")
async def agent_register(params: RegisterInput) -> str:
    """
    Daftarkan agent ke AgentLink. Wajib dipanggil pertama.
    Tidak perlu tunnel — relay via Cloudflare Workers permanen.

    Args:
        params: name (opsional)
    Returns:
        str: JSON berisi status agent
    """
    global agent_name
    if params.name:
        agent_name = params.name
    return json.dumps({"success": True, "name": agent_name, "server": AGENTLINK_URL,
        "stable_agent_identity_id": stable_agent_identity_id,
        "message": f"Agent '{agent_name}' siap. Sekarang bisa create/join room."}, indent=2)


@mcp.tool(name="room_create")
async def room_create(params: CreateRoomInput) -> str:
    """
    Buat room baru di Cloudflare.

    Public: siapa saja bisa join dengan room_id.
    Private: butuh room_id + token otomatis — bagikan ke peer.

    Args:
        params: name (nama room), is_private (True/False)
    Returns:
        str: JSON berisi room_id dan token (jika private)
    """
    try:
        async with http_session.post(f"{AGENTLINK_URL}/rooms",
            json={"name": params.name, "is_private": params.is_private}) as r:
            return json.dumps(await r.json(), indent=2)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})


@mcp.tool(name="room_join")
async def room_join(params: JoinRoomInput) -> str:
    """
    Join room yang sudah ada. Koneksi WebSocket ke Cloudflare terbentuk otomatis.

    Public: cukup room_id. Private: butuh room_id + token dari owner.

    Args:
        params: room_id (6 karakter), token (opsional untuk private)
    Returns:
        str: JSON info room + daftar agent yang sudah ada
    """
    global ws_conn, current_room, agent_id, room_credentials, auto_reconnect_enabled
    rid = params.room_id.upper()
    auto_reconnect_enabled = False
    _cancel_reconnect_task()
    _cancel_retry_replay_task()

    if ws_conn:
        try: await ws_conn.close()
        except Exception: pass
        ws_conn = None
        _fail_pending_acks("WebSocket connection replaced by room_join.")
    room_credentials = None

    try:
        welcome = await _connect_room(rid, params.token, reconnecting=False)
        auto_reconnect_enabled = True
        existing = welcome.get("agents", [])

        return json.dumps({"success": True, "room_id": rid, "my_agent_id": agent_id,
            "stable_agent_identity_id": stable_agent_identity_id,
            "agents": existing, "agent_count": len(existing) + 1,
            "session_resumed": current_room.get("session_resumed", False) if current_room else False,
            "heartbeat_interval_seconds": current_room.get("heartbeat_interval_seconds") if current_room else None,
            "heartbeat_timeout_seconds": current_room.get("heartbeat_timeout_seconds") if current_room else None,
            "last_read_sequence": current_room.get("last_read_sequence") if current_room else 0,
            "local_cached_message_count": current_room.get("local_cached_message_count") if current_room else 0,
            "local_retry_queue_count": current_room.get("local_retry_queue_count") if current_room else 0,
            "local_room_summary": current_room.get("local_summary") if current_room else None,
            "message": welcome.get("message", f"Berhasil join room '{rid}'.")}, indent=2)

    except asyncio.TimeoutError:
        return json.dumps({"success": False, "error": "Timeout saat konek ke room."})
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})


@mcp.tool(name="room_leave")
async def room_leave() -> str:
    """
    Keluar dari room saat ini.

    Returns:
        str: JSON status keluar
    """
    global ws_conn, current_room, agent_id, room_credentials, auto_reconnect_enabled
    if not current_room:
        return json.dumps({"success": False, "error": "Tidak sedang di dalam room."})
    auto_reconnect_enabled = False
    _cancel_reconnect_task()
    _cancel_retry_replay_task()
    room_credentials = None
    current_room["retry_queue"] = []
    current_room["local_retry_queue_count"] = 0
    _persist_local_room_state()
    try:
        if ws_conn: await ws_conn.close()
    except Exception: pass
    _fail_pending_acks("WebSocket connection closed by room_leave.")
    ws_conn = None; current_room = None; agent_id = None
    return json.dumps({"success": True, "message": "Berhasil keluar dari room."})


@mcp.tool(name="room_list")
async def room_list() -> str:
    """
    Lihat daftar room public yang aktif di Cloudflare.

    Returns:
        str: JSON daftar room
    """
    try:
        async with http_session.get(f"{AGENTLINK_URL}/rooms") as r:
            rooms = await r.json()
        return json.dumps({"success": True, "rooms": rooms, "count": len(rooms)}, indent=2)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})


@mcp.tool(name="room_info")
async def room_info() -> str:
    """
    Info room saat ini: ID, status koneksi, agent ID.

    Returns:
        str: JSON info room
    """
    if not current_room:
        return json.dumps({"success": False, "error": "Tidak sedang di dalam room."})
    current_room["local_retry_queue_count"] = len(_retry_queue())
    _persist_local_room_state()
    return json.dumps({"success": True, "room": current_room,
        "my_agent_id": agent_id,
        "stable_agent_identity_id": stable_agent_identity_id,
        "connected": ws_conn is not None}, indent=2)


@mcp.tool(name="room_local_summary")
async def room_local_summary(params: LocalRoomSummaryInput) -> str:
    """
    Baca snapshot ringkasan room dari cache lokal device ini.

    Jika `room_id` kosong dan sedang join room, pakai room saat ini.
    Jika `room_id` kosong dan sedang offline, kembalikan semua snapshot lokal yang tersedia.

    Args:
        params: room_id (opsional)
    Returns:
        str: JSON ringkasan snapshot lokal
    """
    room_id = params.room_id.upper() if params.room_id else None
    if room_id:
        snapshot = _read_local_room_summary(room_id)
        return json.dumps({"success": True, "room_id": room_id, **snapshot}, indent=2)
    if current_room is not None and isinstance(current_room.get("room_id"), str):
        snapshot = _read_local_room_summary(current_room["room_id"])
        return json.dumps({"success": True, "room_id": current_room["room_id"], **snapshot}, indent=2)
    snapshots = _list_local_room_summaries()
    return json.dumps({"success": True, "rooms": snapshots, "count": len(snapshots)}, indent=2)


@mcp.tool(name="agent_send")
async def agent_send(params: SendInput) -> str:
    """
    Kirim pesan langsung ke satu peer via Cloudflare relay.

    Args:
        params: peer_id, message, msg_type ('text'/'data'/'command')
    Returns:
        str: JSON status pengiriman
    """
    payload = {"type": "send", "to": params.peer_id,
        "content": params.message, "msg_type": params.msg_type}
    if current_room is None:
        return json.dumps({"success": False, "error": "Tidak terhubung ke room. Jalankan room_join dulu."})
    if ws_conn is None:
        queued = _enqueue_retry_action("send", payload, reason="WebSocket tidak terhubung")
        return json.dumps({"success": False, "queued_for_retry": True,
            "retry_queue_id": queued["retry_id"],
            "retry_queue_count": len(_retry_queue()),
            "message": "Pesan disimpan di retry queue lokal hingga koneksi pulih."})
    try:
        request_id, ack = await _await_ack(payload)
        if ack is None:
            queued = _enqueue_retry_action("send", payload, reason="ACK timeout")
            return json.dumps({"success": False, "request_id": request_id,
                "queued_for_retry": True,
                "retry_queue_id": queued["retry_id"],
                "retry_queue_count": len(_retry_queue()),
                "note": "ACK timeout. Pesan disimpan di retry queue lokal."})
        if ack.get("delivered", False):
            return json.dumps({"success": True,
                "accepted": ack.get("accepted", False),
                "delivered": ack.get("delivered", False),
                "recipient_count": ack.get("recipient_count", 0),
                "to": params.peer_id,
                "request_id": request_id,
                "message_id": ack.get("message_id"),
                "sequence": ack.get("sequence")})
        queued = _enqueue_retry_action("send", payload, reason="Target belum menerima pesan")
        return json.dumps({"success": False,
            "accepted": ack.get("accepted", False),
            "delivered": ack.get("delivered", False),
            "recipient_count": ack.get("recipient_count", 0),
            "to": params.peer_id,
            "request_id": request_id,
            "message_id": ack.get("message_id"),
            "sequence": ack.get("sequence"),
            "queued_for_retry": True,
            "retry_queue_id": queued["retry_id"],
            "retry_queue_count": len(_retry_queue())})
    except Exception as e:
        queued = _enqueue_retry_action("send", payload, reason=str(e))
        return json.dumps({"success": False, "error": str(e),
            "queued_for_retry": True,
            "retry_queue_id": queued["retry_id"],
            "retry_queue_count": len(_retry_queue())})


@mcp.tool(name="agent_broadcast")
async def agent_broadcast(params: BroadcastInput) -> str:
    """
    Kirim pesan ke semua agent di room via Cloudflare relay.

    Args:
        params: message, msg_type
    Returns:
        str: JSON status broadcast
    """
    payload = {"type": "broadcast",
        "content": params.message, "msg_type": params.msg_type}
    if current_room is None:
        return json.dumps({"success": False, "error": "Tidak terhubung ke room. Jalankan room_join dulu."})
    if ws_conn is None:
        queued = _enqueue_retry_action("broadcast", payload, reason="WebSocket tidak terhubung")
        return json.dumps({"success": False, "queued_for_retry": True,
            "retry_queue_id": queued["retry_id"],
            "retry_queue_count": len(_retry_queue()),
            "message": "Broadcast disimpan di retry queue lokal hingga koneksi pulih."})
    try:
        request_id, ack = await _await_ack(payload)
        if ack is None:
            queued = _enqueue_retry_action("broadcast", payload, reason="ACK timeout")
            return json.dumps({"success": False, "request_id": request_id,
                "queued_for_retry": True,
                "retry_queue_id": queued["retry_id"],
                "retry_queue_count": len(_retry_queue()),
                "message": "ACK timeout. Broadcast disimpan di retry queue lokal."})
        if ack.get("delivered", False):
            return json.dumps({"success": ack.get("accepted", False),
                "accepted": ack.get("accepted", False),
                "delivered": ack.get("delivered", False),
                "recipient_count": ack.get("recipient_count", 0),
                "request_id": request_id,
                "message_id": ack.get("message_id"),
                "sequence": ack.get("sequence"),
                "message": "Broadcast diterima relay."})
        queued = _enqueue_retry_action("broadcast", payload, reason="Belum ada penerima aktif")
        return json.dumps({"success": False,
            "accepted": ack.get("accepted", False),
            "delivered": ack.get("delivered", False),
            "recipient_count": ack.get("recipient_count", 0),
            "request_id": request_id,
            "message_id": ack.get("message_id"),
            "sequence": ack.get("sequence"),
            "queued_for_retry": True,
            "retry_queue_id": queued["retry_id"],
            "retry_queue_count": len(_retry_queue()),
            "message": "Broadcast disimpan di retry queue lokal sampai ada penerima aktif."})
    except Exception as e:
        queued = _enqueue_retry_action("broadcast", payload, reason=str(e))
        return json.dumps({"success": False, "error": str(e),
            "queued_for_retry": True,
            "retry_queue_id": queued["retry_id"],
            "retry_queue_count": len(_retry_queue())})


@mcp.tool(name="agent_read_inbox")
async def agent_read_inbox(params: ReadInboxInput) -> str:
    """
    Baca pesan masuk dan event room (join/leave).

    Args:
        params: limit (default 10), clear (hapus setelah dibaca)
    Returns:
        str: JSON daftar pesan dan event
    """
    room_last_read = _safe_int(current_room.get("last_read_sequence")) if current_room else 0
    visible_messages = inbox
    if params.only_unread:
        visible_messages = [
            message
            for message in inbox
            if not isinstance(message, dict)
            or not isinstance(message.get("sequence"), int)
            or message.get("sequence", 0) > room_last_read
        ]
    messages = visible_messages[-params.limit:]
    max_sequence = _max_message_sequence(messages)
    if params.mark_read and current_room is not None and max_sequence > room_last_read:
        current_room["last_read_sequence"] = max_sequence
        room_last_read = max_sequence
    if params.clear:
        inbox.clear()
    if current_room is not None:
        current_room["local_cached_message_count"] = len(inbox)
    _persist_local_room_state()
    unread_count = len([
        message for message in inbox
        if isinstance(message, dict)
        and isinstance(message.get("sequence"), int)
        and message.get("sequence", 0) > room_last_read
    ])
    return json.dumps({"messages": messages, "count": len(messages),
        "total_in_inbox": len(inbox), "cleared": params.clear,
        "only_unread": params.only_unread, "mark_read": params.mark_read,
        "last_read_sequence": room_last_read,
        "unread_count": unread_count,
        "cache_path": current_room.get("local_cache_path") if current_room else None}, indent=2)


@mcp.tool(name="agent_list")
async def agent_list() -> str:
    """
    Lihat info agent ini: ID, nama, room, status koneksi.

    Returns:
        str: JSON info agent
    """
    return json.dumps({"my_agent_id": agent_id, "my_name": agent_name,
        "client_session_id": client_session_id,
        "stable_agent_identity_id": stable_agent_identity_id,
        "current_room": current_room, "connected": ws_conn is not None,
        "local_retry_queue_count": len(_retry_queue()) if current_room else 0,
        "server": AGENTLINK_URL}, indent=2)


def main():
    """Entry point untuk uvx ssyubix."""
    mcp.run(transport="stdio")

if __name__ == "__main__":
    main()
