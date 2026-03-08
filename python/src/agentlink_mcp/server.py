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
from contextlib import asynccontextmanager
from typing import Optional, Any
from datetime import datetime, timezone

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

agent_id: Optional[str]     = None
agent_name: str              = AGENT_NAME
current_room: Optional[dict] = None
ws_conn: Optional[Any]       = None
inbox: list                  = []
http_session: Optional[aiohttp.ClientSession] = None
pending_acks: dict[str, asyncio.Future] = {}

def _update_room_sequence(msg: dict):
    if current_room is None:
        return
    sequence = msg.get("sequence")
    if isinstance(sequence, int):
        last_sequence = current_room.get("last_sequence", 0)
        if sequence > last_sequence:
            current_room["last_sequence"] = sequence

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

async def ws_listen():
    global ws_conn, agent_id
    while True:
        if ws_conn is None:
            await asyncio.sleep(1)
            continue
        try:
            async for raw in ws_conn:
                try:
                    _handle_incoming(json.loads(raw))
                except Exception as e:
                    logger.warning(f"Parse error: {e}")
        except ConnectionClosed:
            _fail_pending_acks("WebSocket connection closed.")
            ws_conn = None
        except Exception as e:
            logger.warning(f"WS error: {e}")
            _fail_pending_acks(f"WebSocket error: {e}")
            ws_conn = None
        await asyncio.sleep(2)

def _handle_incoming(msg: dict):
    global agent_id
    t = msg.get("type")
    if t == "welcome":
        agent_id = msg.get("agent_id", agent_id)
        if current_room is not None:
            current_room["last_sequence"] = msg.get("last_sequence", current_room.get("last_sequence", 0))
        for peer in msg.get("agents", []):
            inbox.append({"type": "event", "event": "agent_online",
                "from": peer.get("name"), "agent_id": peer.get("agent_id"),
                "timestamp": datetime.now(timezone.utc).isoformat()})
    elif t == "message":
        _update_room_sequence(msg)
        inbox.append({"type": "message", "from": msg.get("from_name", "unknown"),
            "agent_id": msg.get("from"), "content": msg.get("content", ""),
            "msg_type": msg.get("msg_type", "text"), "broadcast": msg.get("broadcast", False),
            "message_id": msg.get("message_id"), "sequence": msg.get("sequence"),
            "room_id": msg.get("room_id"),
            "timestamp": msg.get("timestamp", datetime.now(timezone.utc).isoformat())})
    elif t == "event":
        _update_room_sequence(msg)
        inbox.append({"type": "event", "event": msg.get("event"),
            "from": msg.get("name"), "agent_id": msg.get("agent_id"),
            "message_id": msg.get("message_id"), "sequence": msg.get("sequence"),
            "room_id": msg.get("room_id"),
            "timestamp": msg.get("timestamp", datetime.now(timezone.utc).isoformat())})
    elif t == "ack":
        request_id = msg.get("request_id")
        if isinstance(request_id, str):
            future = pending_acks.pop(request_id, None)
            if future is not None and not future.done():
                future.set_result(msg)

async def ping_loop():
    while True:
        await asyncio.sleep(20)
        if ws_conn is not None:
            try:
                await ws_conn.send(json.dumps({"type": "ping"}))
            except Exception:
                pass

@asynccontextmanager
async def lifespan(server):
    global http_session
    http_session = aiohttp.ClientSession()
    t1 = asyncio.create_task(ws_listen())
    t2 = asyncio.create_task(ping_loop())
    yield {}
    t1.cancel(); t2.cancel()
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
    global ws_conn, current_room, agent_id
    rid = params.room_id.upper()
    qs  = f"name={agent_name}"
    if params.token:
        qs += f"&token={params.token}"

    if ws_conn:
        try: await ws_conn.close()
        except Exception: pass
        ws_conn = None
        _fail_pending_acks("WebSocket connection replaced by room_join.")

    try:
        conn = await asyncio.wait_for(websockets.connect(f"{WS_BASE}/connect/{rid}?{qs}"), timeout=15)
        welcome = json.loads(await asyncio.wait_for(conn.recv(), timeout=10))

        if welcome.get("type") != "welcome":
            return json.dumps({"success": False, "error": f"Unexpected response: {welcome}"})

        agent_id     = welcome.get("agent_id", agent_id)
        current_room = {"room_id": rid, "last_sequence": welcome.get("last_sequence", 0)}
        ws_conn = conn
        existing     = welcome.get("agents", [])

        return json.dumps({"success": True, "room_id": rid, "my_agent_id": agent_id,
            "agents": existing, "agent_count": len(existing) + 1,
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
    global ws_conn, current_room, agent_id
    if not current_room:
        return json.dumps({"success": False, "error": "Tidak sedang di dalam room."})
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
    if ws_conn is None:
        return json.dumps({"success": False, "error": "Tidak terhubung ke room. Jalankan room_join dulu."})
    try:
        request_id, ack = await _await_ack({"type": "send", "to": params.peer_id,
            "content": params.message, "msg_type": params.msg_type})
        if ack is None:
            return json.dumps({"success": True, "request_id": request_id,
                "note": "Terkirim (ACK timeout)"})
        return json.dumps({"success": ack.get("delivered", False),
            "accepted": ack.get("accepted", False),
            "delivered": ack.get("delivered", False),
            "recipient_count": ack.get("recipient_count", 0),
            "to": params.peer_id,
            "request_id": request_id,
            "message_id": ack.get("message_id"),
            "sequence": ack.get("sequence")})
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})


@mcp.tool(name="agent_broadcast")
async def agent_broadcast(params: BroadcastInput) -> str:
    """
    Kirim pesan ke semua agent di room via Cloudflare relay.

    Args:
        params: message, msg_type
    Returns:
        str: JSON status broadcast
    """
    if ws_conn is None:
        return json.dumps({"success": False, "error": "Tidak terhubung ke room. Jalankan room_join dulu."})
    try:
        request_id, ack = await _await_ack({"type": "broadcast",
            "content": params.message, "msg_type": params.msg_type})
        if ack is None:
            return json.dumps({"success": True, "request_id": request_id,
                "message": "Broadcast diterima relay (ACK timeout)."})
        return json.dumps({"success": ack.get("accepted", False),
            "accepted": ack.get("accepted", False),
            "delivered": ack.get("delivered", False),
            "recipient_count": ack.get("recipient_count", 0),
            "request_id": request_id,
            "message_id": ack.get("message_id"),
            "sequence": ack.get("sequence"),
            "message": "Broadcast diterima relay."})
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})


@mcp.tool(name="agent_read_inbox")
async def agent_read_inbox(params: ReadInboxInput) -> str:
    """
    Baca pesan masuk dan event room (join/leave).

    Args:
        params: limit (default 10), clear (hapus setelah dibaca)
    Returns:
        str: JSON daftar pesan dan event
    """
    messages = inbox[-params.limit:]
    if params.clear: inbox.clear()
    return json.dumps({"messages": messages, "count": len(messages),
        "total_in_inbox": len(inbox), "cleared": params.clear}, indent=2)


@mcp.tool(name="agent_list")
async def agent_list() -> str:
    """
    Lihat info agent ini: ID, nama, room, status koneksi.

    Returns:
        str: JSON info agent
    """
    return json.dumps({"my_agent_id": agent_id, "my_name": agent_name,
        "current_room": current_room, "connected": ws_conn is not None,
        "server": AGENTLINK_URL}, indent=2)


def main():
    """Entry point untuk uvx ssyubix."""
    mcp.run(transport="stdio")

if __name__ == "__main__":
    main()
