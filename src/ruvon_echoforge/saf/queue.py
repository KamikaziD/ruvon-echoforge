"""SQLite-backed Store-and-Forward execution queue — exactly-once order submission."""

import asyncio
import json
import logging
import os
import time
import uuid
from dataclasses import asdict, dataclass, field
from typing import Callable, Awaitable

import aiosqlite

logger = logging.getLogger(__name__)

DB_PATH = os.getenv("ECHOFORGE_SAF_DB", "echoforge_saf.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS saf_queue (
    entry_id    TEXT PRIMARY KEY,
    pattern_id  TEXT NOT NULL,
    symbol      TEXT NOT NULL,
    side        TEXT NOT NULL,
    quantity    REAL NOT NULL,
    limit_price REAL NOT NULL DEFAULT 0,
    order_type  TEXT NOT NULL DEFAULT 'limit',
    status      TEXT NOT NULL DEFAULT 'PENDING',
    retry_count INTEGER NOT NULL DEFAULT 0,
    queued_at   INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    submitted_at INTEGER,
    error_msg   TEXT
);
CREATE INDEX IF NOT EXISTS idx_saf_status ON saf_queue(status);
"""


@dataclass
class SAFEntry:
    pattern_id: str
    symbol: str
    side: str           # "buy" | "sell"
    quantity: float
    limit_price: float = 0.0
    order_type: str = "limit"
    ttl_seconds: int = 300
    entry_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    status: str = "PENDING"
    retry_count: int = 0
    queued_at: int = field(default_factory=lambda: int(time.time() * 1000))
    expires_at: int = 0

    def __post_init__(self):
        if self.expires_at == 0:
            self.expires_at = self.queued_at + self.ttl_seconds * 1000


class SAFQueue:
    """
    Exactly-once execution queue for exchange orders.

    Orders are persisted to SQLite before any submission attempt.
    On reconnect, PENDING entries are replayed in FIFO order.
    Expired entries are skipped and marked EXPIRED.
    """

    def __init__(self, db_path: str = DB_PATH):
        self._db_path = db_path
        self._db: aiosqlite.Connection | None = None
        self._replay_task: asyncio.Task | None = None

    async def start(self):
        self._db = await aiosqlite.connect(self._db_path)
        self._db.row_factory = aiosqlite.Row
        await self._db.executescript(SCHEMA)
        await self._db.commit()
        logger.info("SAF queue started: %s", self._db_path)

    async def stop(self):
        if self._replay_task:
            self._replay_task.cancel()
        if self._db:
            await self._db.close()

    async def enqueue(self, entry: SAFEntry) -> str:
        await self._db.execute(
            """INSERT INTO saf_queue
               (entry_id, pattern_id, symbol, side, quantity, limit_price,
                order_type, status, retry_count, queued_at, expires_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (
                entry.entry_id, entry.pattern_id, entry.symbol, entry.side,
                entry.quantity, entry.limit_price, entry.order_type,
                entry.status, entry.retry_count, entry.queued_at, entry.expires_at,
            ),
        )
        await self._db.commit()
        logger.debug("SAF enqueue: %s %s %s qty=%s", entry.entry_id, entry.symbol, entry.side, entry.quantity)
        return entry.entry_id

    async def replay(self, submit_fn: Callable[[SAFEntry], Awaitable[bool]]) -> int:
        """
        Replay all PENDING entries. Calls submit_fn for each; marks SUBMITTED on
        success, increments retry_count on failure, marks EXPIRED if past TTL.

        Returns count of successfully submitted entries.
        """
        now = int(time.time() * 1000)
        submitted = 0

        async with self._db.execute(
            "SELECT * FROM saf_queue WHERE status='PENDING' ORDER BY queued_at ASC"
        ) as cur:
            rows = await cur.fetchall()

        for row in rows:
            entry_id = row["entry_id"]

            if row["expires_at"] < now:
                await self._mark(entry_id, "EXPIRED")
                logger.warning("SAF expired: %s", entry_id)
                continue

            entry = SAFEntry(
                entry_id=entry_id,
                pattern_id=row["pattern_id"],
                symbol=row["symbol"],
                side=row["side"],
                quantity=row["quantity"],
                limit_price=row["limit_price"],
                order_type=row["order_type"],
                retry_count=row["retry_count"],
                queued_at=row["queued_at"],
                expires_at=row["expires_at"],
            )

            try:
                ok = await submit_fn(entry)
                if ok:
                    await self._db.execute(
                        "UPDATE saf_queue SET status='SUBMITTED', submitted_at=? WHERE entry_id=?",
                        (now, entry_id),
                    )
                    submitted += 1
                else:
                    await self._db.execute(
                        "UPDATE saf_queue SET retry_count=retry_count+1 WHERE entry_id=?",
                        (entry_id,),
                    )
            except Exception as exc:
                await self._db.execute(
                    "UPDATE saf_queue SET retry_count=retry_count+1, error_msg=? WHERE entry_id=?",
                    (str(exc), entry_id),
                )
                logger.warning("SAF replay error for %s: %s", entry_id, exc)

        await self._db.commit()
        return submitted

    async def pending_count(self) -> int:
        async with self._db.execute("SELECT COUNT(*) FROM saf_queue WHERE status='PENDING'") as cur:
            row = await cur.fetchone()
            return row[0] if row else 0

    async def _mark(self, entry_id: str, status: str):
        await self._db.execute(
            "UPDATE saf_queue SET status=? WHERE entry_id=?", (status, entry_id)
        )
        await self._db.commit()
