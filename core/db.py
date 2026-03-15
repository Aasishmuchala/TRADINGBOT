import asyncpg
from typing import Optional
from config.settings import Settings

class Database:
    """Async TimescaleDB connection manager."""
    
    def __init__(self, settings: Settings = None):
        self.settings = settings or Settings()
        self._pool: Optional[asyncpg.Pool] = None
    
    async def connect(self):
        self._pool = await asyncpg.create_pool(
            self.settings.DATABASE_URL,
            min_size=2,
            max_size=10
        )
    
    async def close(self):
        if self._pool:
            await self._pool.close()
    
    @property
    def pool(self) -> asyncpg.Pool:
        if not self._pool:
            raise RuntimeError("Database not connected. Call connect() first.")
        return self._pool
    
    async def execute(self, query: str, *args):
        async with self.pool.acquire() as conn:
            return await conn.execute(query, *args)
    
    async def fetch(self, query: str, *args):
        async with self.pool.acquire() as conn:
            return await conn.fetch(query, *args)
    
    async def fetchrow(self, query: str, *args):
        async with self.pool.acquire() as conn:
            return await conn.fetchrow(query, *args)
    
    async def fetchval(self, query: str, *args):
        async with self.pool.acquire() as conn:
            return await conn.fetchval(query, *args)
    
    async def run_migration(self, migration_path: str):
        """Run a SQL migration file."""
        with open(migration_path) as f:
            sql = f.read()
        async with self.pool.acquire() as conn:
            await conn.execute(sql)
