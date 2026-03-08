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
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional, Any
from datetime import datetime, timezone
from urllib.parse import urlencode, urlparse

import aiohttp
import websockets
import websockets.client
from websockets.exceptions import ConnectionClosed
from mcp.server.fastmcp import FastMCP
from pydantic import BaseModel, Field, ConfigDict

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

agent_id: Optional[str]     = None
agent_name: str              = AGENT_NAME
client_session_id: str       = os.environ.get("AGENT_SESSION_ID", uuid.uuid4().hex)
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


def _load_local_room_state(room_id: str) -> dict:
    cache_path = _room_cache_path(room_id)
    if not cache_path.exists():
        return {
            "room_id": room_id.upper(),
            "messages": [],
            "last_read_sequence": 0,
            "last_sequence": 0,
            "restored": False,
        }
    try:
        payload = json.loads(cache_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {
            "room_id": room_id.upper(),
            "messages": [],
            "last_read_sequence": 0,
            "last_sequence": 0,
            "restored": False,
        }

    messages = payload.get("messages", [])
    if not isinstance(messages, list):
        messages = []
    messages = [message for message in messages if isinstance(message, dict)][-LOCAL_INBOX_LIMIT:]
    return {
        "room_id": payload.get("room_id", room_id.upper()),
        "messages": messages,
        "retry_queue": _normalized_retry_queue(payload.get("retry_queue")),
        "last_read_sequence": _safe_int(payload.get("last_read_sequence")),
        "last_sequence": _safe_int(payload.get("last_sequence")),
        "cached_at": payload.get("cached_at"),
        "restored": True,
    }


def _persist_local_room_state():
    if current_room is None:
        return
    room_id = current_room.get("room_id")
    if not isinstance(room_id, str) or not room_id:
        return
    messages = [
        message
        for message in inbox[-LOCAL_INBOX_LIMIT:]
        if isinstance(message, dict) and message.get("room_id", room_id) == room_id
    ]
    payload = {
        "version": LOCAL_STATE_VERSION,
        "server": AGENTLINK_URL,
        "room_id": room_id,
        "cached_at": _now_iso(),
        "last_sequence": _safe_int(current_room.get("last_sequence")),
        "last_read_sequence": _safe_int(current_room.get("last_read_sequence")),
        "messages": messages,
        "retry_queue": _normalized_retry_queue(current_room.get("retry_queue")),
    }
    try:
        _write_json_file(_room_cache_path(room_id), payload)
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
    inbox[:] = merged_messages[-LOCAL_INBOX_LIMIT:]
    if current_room is None:
        return
    current_room["retry_queue"] = cached["retry_queue"]
    current_room["last_read_sequence"] = cached["last_read_sequence"]
    current_room["local_cache_path"] = str(_room_cache_path(room_id))
    current_room["local_cached_message_count"] = len(inbox)
    current_room["local_cached_last_sequence"] = cached["last_sequence"]
    current_room["local_cache_restored"] = cached["restored"]
    current_room["local_cache_restored_at"] = cached.get("cached_at")
    current_room["local_retry_queue_count"] = len(cached["retry_queue"])
    _persist_local_room_state()


def _append_inbox_entry(entry: dict):
    room_id = entry.get("room_id")
    if room_id is None and current_room is not None:
        room_id = current_room.get("room_id")
        if room_id is not None:
            entry = {**entry, "room_id": room_id}
    inbox.append(entry)
    if len(inbox) > LOCAL_INBOX_LIMIT:
        del inbox[:-LOCAL_INBOX_LIMIT]
    _persist_local_room_state()


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

def _set_peer_state(agent_id_value: Optional[str], *, name: Optional[str], presence: str,
    joined_at: Optional[str], last_seen_at: Optional[str]):
    if not agent_id_value:
        return
    peers = _room_peers()
    existing = peers.get(agent_id_value, {})
    peers[agent_id_value] = {
        "agent_id": agent_id_value,
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
    query = {"name": agent_name, "session_id": client_session_id}
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
    global ws_conn, current_room, agent_id, room_credentials
    conn, welcome = await _open_room_connection(rid, token)
    agent_id = welcome.get("agent_id", agent_id)
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
    global agent_id
    t = msg.get("type")
    if t == "welcome":
        agent_id = msg.get("agent_id", agent_id)
        if current_room is not None:
            current_room["last_sequence"] = msg.get("last_sequence", current_room.get("last_sequence", 0))
            current_room["joined_at"] = msg.get("joined_at", current_room.get("joined_at"))
            current_room["last_seen_at"] = msg.get("last_seen_at", current_room.get("last_seen_at"))
            current_room["presence"] = msg.get("presence", current_room.get("presence", "online"))
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
            _set_peer_state(event_agent_id, name=msg.get("name"),
                presence=msg.get("presence", "online"), joined_at=msg.get("joined_at"),
                last_seen_at=msg.get("last_seen_at"))
            _schedule_retry_replay(delay=0.5)
        elif event_name == "agent_left":
            _remove_peer_state(event_agent_id)
        _append_inbox_entry({"type": "event", "event": msg.get("event"),
            "from": msg.get("name"), "agent_id": msg.get("agent_id"),
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

mcp = FastMCP("agentlink", lifespan=lifespan)

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
            "agents": existing, "agent_count": len(existing) + 1,
            "session_resumed": current_room.get("session_resumed", False) if current_room else False,
            "heartbeat_interval_seconds": current_room.get("heartbeat_interval_seconds") if current_room else None,
            "heartbeat_timeout_seconds": current_room.get("heartbeat_timeout_seconds") if current_room else None,
            "last_read_sequence": current_room.get("last_read_sequence") if current_room else 0,
            "local_cached_message_count": current_room.get("local_cached_message_count") if current_room else 0,
            "local_retry_queue_count": current_room.get("local_retry_queue_count") if current_room else 0,
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
    return json.dumps({"success": True, "room": current_room,
        "my_agent_id": agent_id, "connected": ws_conn is not None}, indent=2)


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
        "current_room": current_room, "connected": ws_conn is not None,
        "local_retry_queue_count": len(_retry_queue()) if current_room else 0,
        "server": AGENTLINK_URL}, indent=2)


def main():
    """Entry point untuk uvx ssyubix."""
    mcp.run(transport="stdio")

if __name__ == "__main__":
    main()
