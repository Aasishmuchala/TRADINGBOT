use rusqlite::{params, Connection, OptionalExtension};
use sthyra_account_state::{AccountBalance, PositionState};
use sthyra_domain::RuntimeMode;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const ORDER_INTENT_RETENTION_LIMIT: u32 = 500;
const EXECUTION_EVENT_RETENTION_LIMIT: u32 = 1_000;
const ACCOUNT_BALANCE_RETENTION_LIMIT: u32 = 10_000;
const TRADE_OUTCOME_RETENTION_LIMIT: u32 = 5_000;
const ORDER_INTENT_RETENTION_MAX_AGE_MS: u64 = 7 * 24 * 60 * 60 * 1_000;
const EXECUTION_EVENT_RETENTION_MAX_AGE_MS: u64 = 30 * 24 * 60 * 60 * 1_000;
const ACCOUNT_BALANCE_RETENTION_MAX_AGE_MS: u64 = 180 * 24 * 60 * 60 * 1_000;
const TRADE_OUTCOME_RETENTION_MAX_AGE_MS: u64 = 365 * 24 * 60 * 60 * 1_000;
const ACCOUNT_BALANCE_MIN_INTERVAL_MS: u64 = 60 * 60 * 1_000;
const TRADE_FILL_WATERMARK_KEY: &str = "trade_fill_watermark_ms";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Migration {
    pub version: u32,
    pub statement: &'static str,
}

pub fn bootstrap_migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            statement: "create table if not exists incidents (id integer primary key, mode text not null, message text not null);",
        },
        Migration {
            version: 2,
            statement: "create table if not exists order_intents (id integer primary key, symbol text not null, mode text not null, decision text not null, size_usd real not null);",
        },
        Migration {
            version: 3,
            statement: "alter table order_intents add column dedupe_key text;",
        },
        Migration {
            version: 4,
            statement: "create index if not exists idx_order_intents_dedupe_key on order_intents(dedupe_key);",
        },
        Migration {
            version: 5,
            statement: "create table if not exists execution_events (id integer primary key, timestamp_ms integer not null, symbol text not null, mode text not null, decision text not null, event_type text not null, state text not null, detail text not null);",
        },
        Migration {
            version: 6,
            statement: "alter table order_intents add column timestamp_ms integer;",
        },
        Migration {
            version: 7,
            statement: "create table if not exists account_balance_snapshots (id integer primary key, timestamp_ms integer not null, asset text not null, wallet_balance real not null);",
        },
        Migration {
            version: 8,
            statement: "create table if not exists trade_outcomes (id integer primary key, timestamp_ms integer not null, symbol text not null, side text not null, quantity real not null, entry_price real not null, exit_price real not null, realized_pnl real not null, pnl_ratio real not null, close_reason text not null, source text not null);",
        },
        Migration {
            version: 9,
            statement: "create table if not exists runtime_state (key text primary key, value text not null);",
        },
        Migration {
            version: 10,
            statement: "create table if not exists runtime_positions (symbol text primary key, quantity real not null, entry_price real not null, leverage integer not null, unrealized_pnl real not null, updated_at_ms integer not null);",
        },
        Migration {
            version: 11,
            statement: "alter table execution_events add column model_id text not null default 'unknown';",
        },
        Migration {
            version: 12,
            statement: "alter table execution_events add column model_scope text not null default 'Unknown / Unknown / Unknown';",
        },
        Migration {
            version: 13,
            statement: "alter table trade_outcomes add column model_id text not null default 'unknown';",
        },
        Migration {
            version: 14,
            statement: "alter table trade_outcomes add column model_scope text not null default 'Unknown / Unknown / Unknown';",
        },
        Migration {
            version: 15,
            statement: "create table if not exists runtime_position_models (symbol text primary key, model_id text not null, model_scope text not null, updated_at_ms integer not null);",
        },
        Migration {
            version: 16,
            statement: "alter table order_intents add column model_id text not null default 'unknown';",
        },
        Migration {
            version: 17,
            statement: "alter table order_intents add column model_scope text not null default 'Unknown / Unknown / Unknown';",
        },
        Migration {
            version: 18,
            statement: "alter table trade_outcomes add column mode text not null default 'Research';",
        },
        Migration {
            version: 19,
            statement: "alter table trade_outcomes add column entry_timestamp_ms integer;",
        },
        Migration {
            version: 20,
            statement: "create table if not exists runtime_position_entries (symbol text primary key, entry_timestamp_ms integer not null, updated_at_ms integer not null);",
        },
        Migration {
            version: 21,
            statement: "alter table runtime_position_models add column indicator_id text not null default 'none';",
        },
        Migration {
            version: 22,
            statement: "alter table runtime_position_models add column indicator_scope text not null default 'All / All / All';",
        },
        Migration {
            version: 23,
            statement: "alter table order_intents add column indicator_id text not null default 'none';",
        },
        Migration {
            version: 24,
            statement: "alter table order_intents add column indicator_scope text not null default 'All / All / All';",
        },
        Migration {
            version: 25,
            statement: "alter table execution_events add column indicator_id text not null default 'none';",
        },
        Migration {
            version: 26,
            statement: "alter table execution_events add column indicator_scope text not null default 'All / All / All';",
        },
        Migration {
            version: 27,
            statement: "alter table trade_outcomes add column indicator_id text not null default 'none';",
        },
        Migration {
            version: 28,
            statement: "alter table trade_outcomes add column indicator_scope text not null default 'All / All / All';",
        },
    ]
}

#[derive(Debug, Clone, PartialEq)]
pub struct IncidentRecord {
    pub mode: RuntimeMode,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OrderIntentRecord {
    pub symbol: String,
    pub mode: RuntimeMode,
    pub decision: String,
    pub size_usd: f64,
    pub model_id: String,
    pub model_scope: String,
    pub indicator_id: String,
    pub indicator_scope: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutionEventRecord {
    pub symbol: String,
    pub mode: RuntimeMode,
    pub decision: String,
    pub event_type: String,
    pub state: String,
    pub detail: String,
    pub model_id: String,
    pub model_scope: String,
    pub indicator_id: String,
    pub indicator_scope: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PositionModelAttribution {
    pub symbol: String,
    pub model_id: String,
    pub model_scope: String,
    pub indicator_id: String,
    pub indicator_scope: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AccountBalanceSnapshotRecord {
    pub timestamp_ms: u64,
    pub asset: String,
    pub wallet_balance: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ClosedTradeRecord {
    pub timestamp_ms: u64,
    pub entry_timestamp_ms: Option<u64>,
    pub symbol: String,
    pub mode: RuntimeMode,
    pub side: String,
    pub quantity: f64,
    pub entry_price: f64,
    pub exit_price: f64,
    pub realized_pnl: f64,
    pub pnl_ratio: f64,
    pub close_reason: String,
    pub source: String,
    pub model_id: String,
    pub model_scope: String,
    pub indicator_id: String,
    pub indicator_scope: String,
}

#[derive(Debug, Clone)]
pub struct AuditStore {
    path: PathBuf,
}

impl AuditStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StorageError> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }

        let store = Self { path };
        store.bootstrap()?;
        Ok(store)
    }

    pub fn persist_incident(&self, incident: &IncidentRecord) -> Result<(), StorageError> {
        self.with_connection(|connection| {
            connection.execute(
                "insert into incidents (mode, message) values (?1, ?2)",
                params![format!("{:?}", incident.mode), incident.message],
            )?;
            Ok(())
        })
    }

    pub fn persist_order_intent(&self, intent: &OrderIntentRecord) -> Result<(), StorageError> {
        self.with_connection(|connection| {
            let now_ms = current_timestamp_ms();
            let dedupe_key = order_intent_dedupe_key(intent);
            let existing: Option<i64> = connection
                .query_row(
                    "select id from order_intents where dedupe_key = ?1 order by id desc limit 1",
                    params![dedupe_key],
                    |row| row.get(0),
                )
                .optional()?;

            if existing.is_some() {
                return Ok(());
            }

            connection.execute(
                "insert into order_intents (symbol, mode, decision, size_usd, dedupe_key, timestamp_ms, model_id, model_scope, indicator_id, indicator_scope) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    intent.symbol,
                    format!("{:?}", intent.mode),
                    intent.decision,
                    intent.size_usd,
                    dedupe_key,
                    now_ms,
                    intent.model_id,
                    intent.model_scope,
                    intent.indicator_id,
                    intent.indicator_scope,
                ],
            )?;
            prune_table_to_age(connection, "order_intents", "timestamp_ms", ORDER_INTENT_RETENTION_MAX_AGE_MS, now_ms)?;
            prune_table_to_limit(connection, "order_intents", ORDER_INTENT_RETENTION_LIMIT)?;
            Ok(())
        })
    }

    pub fn count_incidents(&self) -> Result<u32, StorageError> {
        self.with_connection(|connection| {
            let count = connection.query_row("select count(*) from incidents", [], |row| row.get(0))?;
            Ok(count)
        })
    }

    pub fn count_order_intents(&self) -> Result<u32, StorageError> {
        self.with_connection(|connection| {
            let count = connection.query_row("select count(*) from order_intents", [], |row| row.get(0))?;
            Ok(count)
        })
    }

    pub fn persist_execution_event(&self, event: &ExecutionEventRecord) -> Result<(), StorageError> {
        self.with_connection(|connection| {
            let now_ms = current_timestamp_ms();
            connection.execute(
                "insert into execution_events (timestamp_ms, symbol, mode, decision, event_type, state, detail, model_id, model_scope, indicator_id, indicator_scope) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    now_ms,
                    event.symbol,
                    format!("{:?}", event.mode),
                    event.decision,
                    event.event_type,
                    event.state,
                    event.detail,
                    event.model_id,
                    event.model_scope,
                    event.indicator_id,
                    event.indicator_scope,
                ],
            )?;
            prune_table_to_age(
                connection,
                "execution_events",
                "timestamp_ms",
                EXECUTION_EVENT_RETENTION_MAX_AGE_MS,
                now_ms,
            )?;
            prune_table_to_limit(connection, "execution_events", EXECUTION_EVENT_RETENTION_LIMIT)?;
            Ok(())
        })
    }

    pub fn count_execution_events(&self) -> Result<u32, StorageError> {
        self.with_connection(|connection| {
            let count = connection.query_row("select count(*) from execution_events", [], |row| row.get(0))?;
            Ok(count)
        })
    }

    pub fn persist_account_balances(&self, balances: &[AccountBalance]) -> Result<(), StorageError> {
        self.with_connection(|connection| {
            let now_ms = current_timestamp_ms();

            for balance in balances {
                let latest: Option<(u64, f64)> = connection
                    .query_row(
                        "select timestamp_ms, wallet_balance from account_balance_snapshots where asset = ?1 order by timestamp_ms desc limit 1",
                        params![balance.asset],
                        |row| Ok((row.get::<_, u64>(0)?, row.get::<_, f64>(1)?)),
                    )
                    .optional()?;

                let should_skip = latest
                    .map(|(timestamp_ms, wallet_balance)| {
                        (wallet_balance - balance.wallet_balance).abs() < 1e-8
                            && now_ms.saturating_sub(timestamp_ms) < ACCOUNT_BALANCE_MIN_INTERVAL_MS
                    })
                    .unwrap_or(false);

                if should_skip {
                    continue;
                }

                connection.execute(
                    "insert into account_balance_snapshots (timestamp_ms, asset, wallet_balance) values (?1, ?2, ?3)",
                    params![now_ms, balance.asset, balance.wallet_balance],
                )?;
            }

            prune_table_to_age(
                connection,
                "account_balance_snapshots",
                "timestamp_ms",
                ACCOUNT_BALANCE_RETENTION_MAX_AGE_MS,
                now_ms,
            )?;
            prune_table_to_limit(connection, "account_balance_snapshots", ACCOUNT_BALANCE_RETENTION_LIMIT)?;
            Ok(())
        })
    }

    pub fn persist_trade_outcome(&self, outcome: &ClosedTradeRecord) -> Result<(), StorageError> {
        self.with_connection(|connection| {
            connection.execute(
                concat!(
                    "insert into trade_outcomes ",
                    "(timestamp_ms, entry_timestamp_ms, symbol, mode, side, quantity, entry_price, exit_price, realized_pnl, pnl_ratio, close_reason, source, model_id, model_scope, indicator_id, indicator_scope) ",
                    "values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)"
                ),
                params![
                    outcome.timestamp_ms,
                    outcome.entry_timestamp_ms,
                    outcome.symbol,
                    format!("{:?}", outcome.mode),
                    outcome.side,
                    outcome.quantity,
                    outcome.entry_price,
                    outcome.exit_price,
                    outcome.realized_pnl,
                    outcome.pnl_ratio,
                    outcome.close_reason,
                    outcome.source,
                    outcome.model_id,
                    outcome.model_scope,
                    outcome.indicator_id,
                    outcome.indicator_scope,
                ],
            )?;
            prune_table_to_age(
                connection,
                "trade_outcomes",
                "timestamp_ms",
                TRADE_OUTCOME_RETENTION_MAX_AGE_MS,
                outcome.timestamp_ms,
            )?;
            prune_table_to_limit(connection, "trade_outcomes", TRADE_OUTCOME_RETENTION_LIMIT)?;
            Ok(())
        })
    }

    pub fn count_trade_outcomes(&self) -> Result<u32, StorageError> {
        self.with_connection(|connection| {
            let count = connection.query_row("select count(*) from trade_outcomes", [], |row| row.get(0))?;
            Ok(count)
        })
    }

    pub fn read_trade_fill_watermark_ms(&self) -> Result<Option<u64>, StorageError> {
        self.with_connection(|connection| {
            let value = connection
                .query_row(
                    "select value from runtime_state where key = ?1",
                    params![TRADE_FILL_WATERMARK_KEY],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;

            value
                .map(|raw| raw.parse::<u64>().map_err(|_| rusqlite::Error::InvalidQuery))
                .transpose()
        })
    }

    pub fn persist_trade_fill_watermark_ms(&self, timestamp_ms: u64) -> Result<(), StorageError> {
        self.with_connection(|connection| {
            connection.execute(
                concat!(
                    "insert into runtime_state (key, value) values (?1, ?2) ",
                    "on conflict(key) do update set value = excluded.value"
                ),
                params![TRADE_FILL_WATERMARK_KEY, timestamp_ms.to_string()],
            )?;
            Ok(())
        })
    }

    pub fn read_position_state_cache(&self) -> Result<Vec<PositionState>, StorageError> {
        self.with_connection(|connection| {
            let mut statement = connection.prepare(
                concat!(
                    "select symbol, quantity, entry_price, leverage, unrealized_pnl ",
                    "from runtime_positions order by symbol asc"
                ),
            )?;
            let rows = statement.query_map([], |row| {
                Ok(PositionState {
                    symbol: row.get(0)?,
                    quantity: row.get(1)?,
                    entry_price: row.get(2)?,
                    leverage: row.get(3)?,
                    unrealized_pnl: row.get(4)?,
                })
            })?;

            rows.collect::<Result<Vec<_>, _>>()
        })
    }

    pub fn read_position_entry_timestamp_ms(&self, symbol: &str) -> Result<Option<u64>, StorageError> {
        self.with_connection(|connection| {
            let entry_timestamp_ms = connection
                .query_row(
                    concat!(
                        "select entry_timestamp_ms ",
                        "from runtime_position_entries where symbol = ?1"
                    ),
                    params![symbol],
                    |row| row.get::<_, u64>(0),
                )
                .optional()?;

            if entry_timestamp_ms.is_some() {
                return Ok(entry_timestamp_ms);
            }

            let fallback_entry_timestamp_ms = connection
                .query_row(
                    concat!(
                        "select updated_at_ms ",
                        "from runtime_positions where symbol = ?1"
                    ),
                    params![symbol],
                    |row| row.get::<_, u64>(0),
                )
                .optional()?;

            Ok(fallback_entry_timestamp_ms)
        })
    }

    pub fn persist_position_entry_timestamp(
        &self,
        symbol: &str,
        entry_timestamp_ms: u64,
    ) -> Result<(), StorageError> {
        self.with_connection(|connection| {
            connection.execute(
                concat!(
                    "insert into runtime_position_entries (symbol, entry_timestamp_ms, updated_at_ms) ",
                    "values (?1, ?2, ?3) ",
                    "on conflict(symbol) do update set ",
                    "entry_timestamp_ms = excluded.entry_timestamp_ms, ",
                    "updated_at_ms = excluded.updated_at_ms"
                ),
                params![symbol, entry_timestamp_ms, current_timestamp_ms()],
            )?;
            Ok(())
        })
    }

    pub fn sync_position_entry_timestamps(
        &self,
        previous_positions: &[PositionState],
        current_positions: &[PositionState],
    ) -> Result<(), StorageError> {
        self.with_connection(|connection| {
            let now_ms = current_timestamp_ms();
            let mut entry_statement = connection.prepare(
                concat!(
                    "select symbol, entry_timestamp_ms ",
                    "from runtime_position_entries"
                ),
            )?;
            let existing_entries = entry_statement
                .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?)))?
                .collect::<Result<HashMap<_, _>, _>>()?;

            let mut fallback_statement = connection.prepare(
                concat!(
                    "select symbol, updated_at_ms ",
                    "from runtime_positions"
                ),
            )?;
            let fallback_entries = fallback_statement
                .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?)))?
                .collect::<Result<HashMap<_, _>, _>>()?;

            let previous_by_symbol = previous_positions
                .iter()
                .filter(|position| position.quantity.abs() > f64::EPSILON)
                .map(|position| (position.symbol.clone(), position.clone()))
                .collect::<HashMap<_, _>>();

            connection.execute("delete from runtime_position_entries", [])?;

            for position in current_positions
                .iter()
                .filter(|position| position.quantity.abs() > f64::EPSILON)
            {
                let entry_timestamp_ms = match previous_by_symbol.get(&position.symbol) {
                    Some(previous_position)
                        if previous_position.quantity.signum() == position.quantity.signum() => existing_entries
                            .get(&position.symbol)
                            .copied()
                            .or_else(|| fallback_entries.get(&position.symbol).copied())
                            .unwrap_or(now_ms),
                    _ => now_ms,
                };

                connection.execute(
                    concat!(
                        "insert into runtime_position_entries ",
                        "(symbol, entry_timestamp_ms, updated_at_ms) values (?1, ?2, ?3)"
                    ),
                    params![position.symbol, entry_timestamp_ms, now_ms],
                )?;
            }

            Ok(())
        })
    }

    pub fn persist_position_state_cache(&self, positions: &[PositionState]) -> Result<(), StorageError> {
        self.with_connection(|connection| {
            let now_ms = current_timestamp_ms();
            connection.execute("delete from runtime_positions", [])?;

            for position in positions.iter().filter(|position| position.quantity.abs() > f64::EPSILON) {
                connection.execute(
                    concat!(
                        "insert into runtime_positions ",
                        "(symbol, quantity, entry_price, leverage, unrealized_pnl, updated_at_ms) ",
                        "values (?1, ?2, ?3, ?4, ?5, ?6)"
                    ),
                    params![
                        position.symbol,
                        position.quantity,
                        position.entry_price,
                        position.leverage,
                        position.unrealized_pnl,
                        now_ms,
                    ],
                )?;
            }

            Ok(())
        })
    }

    pub fn read_position_model_attribution(
        &self,
        symbol: &str,
    ) -> Result<Option<PositionModelAttribution>, StorageError> {
        self.with_connection(|connection| {
            connection
                .query_row(
                    concat!(
                        "select symbol, model_id, model_scope, indicator_id, indicator_scope ",
                        "from runtime_position_models where symbol = ?1"
                    ),
                    params![symbol],
                    |row| {
                        Ok(PositionModelAttribution {
                            symbol: row.get(0)?,
                            model_id: row.get(1)?,
                            model_scope: row.get(2)?,
                            indicator_id: row.get(3)?,
                            indicator_scope: row.get(4)?,
                        })
                    },
                )
                .optional()
        })
    }

    pub fn persist_position_model_attribution(
        &self,
        attribution: &PositionModelAttribution,
    ) -> Result<(), StorageError> {
        self.with_connection(|connection| {
            connection.execute(
                concat!(
                    "insert into runtime_position_models (symbol, model_id, model_scope, indicator_id, indicator_scope, updated_at_ms) ",
                    "values (?1, ?2, ?3, ?4, ?5, ?6) ",
                    "on conflict(symbol) do update set ",
                    "model_id = excluded.model_id, ",
                    "model_scope = excluded.model_scope, ",
                    "indicator_id = excluded.indicator_id, ",
                    "indicator_scope = excluded.indicator_scope, ",
                    "updated_at_ms = excluded.updated_at_ms"
                ),
                params![
                    attribution.symbol,
                    attribution.model_id,
                    attribution.model_scope,
                    attribution.indicator_id,
                    attribution.indicator_scope,
                    current_timestamp_ms(),
                ],
            )?;

            Ok(())
        })
    }

    pub fn delete_position_model_attribution(&self, symbol: &str) -> Result<(), StorageError> {
        self.with_connection(|connection| {
            connection.execute(
                "delete from runtime_position_models where symbol = ?1",
                params![symbol],
            )?;

            Ok(())
        })
    }

    fn bootstrap(&self) -> Result<(), StorageError> {
        self.with_connection(|connection| {
            for migration in bootstrap_migrations() {
                match connection.execute(migration.statement, []) {
                    Ok(_) => {}
                    Err(rusqlite::Error::SqliteFailure(error, message))
                        if error.extended_code == 1
                            && message
                                .as_deref()
                                .map(|value| value.contains("duplicate column name"))
                                .unwrap_or(false) => {}
                    Err(error) => return Err(error.into()),
                }
            }
            connection.execute(
                "update order_intents set timestamp_ms = ?1 where timestamp_ms is null",
                params![current_timestamp_ms()],
            )?;
            Ok(())
        })
    }

    fn with_connection<T>(
        &self,
        operation: impl FnOnce(&Connection) -> Result<T, rusqlite::Error>,
    ) -> Result<T, StorageError> {
        let connection = Connection::open(&self.path)?;
        operation(&connection).map_err(StorageError::Sqlite)
    }
}

fn order_intent_dedupe_key(intent: &OrderIntentRecord) -> String {
    format!(
        "{}|{:?}|{}|{:.2}|{}|{}",
        intent.symbol,
        intent.mode,
        intent.decision,
        intent.size_usd,
        intent.model_id,
        intent.indicator_id,
    )
}

fn prune_table_to_limit(connection: &Connection, table: &str, max_rows: u32) -> Result<(), rusqlite::Error> {
    let statement = format!(
        "delete from {table} where id not in (select id from {table} order by id desc limit ?1)"
    );
    connection.execute(&statement, params![i64::from(max_rows)])?;
    Ok(())
}

fn prune_table_to_age(
    connection: &Connection,
    table: &str,
    timestamp_column: &str,
    max_age_ms: u64,
    now_ms: u64,
) -> Result<(), rusqlite::Error> {
    let minimum_timestamp_ms = now_ms.saturating_sub(max_age_ms);
    let statement = format!("delete from {table} where {timestamp_column} < ?1");
    connection.execute(&statement, params![minimum_timestamp_ms])?;
    Ok(())
}

#[derive(Debug)]
pub enum StorageError {
    Io(std::io::Error),
    Sqlite(rusqlite::Error),
}

impl std::fmt::Display for StorageError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "storage io error: {error}"),
            Self::Sqlite(error) => write!(formatter, "storage sqlite error: {error}"),
        }
    }
}

impl std::error::Error for StorageError {}

impl From<std::io::Error> for StorageError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<rusqlite::Error> for StorageError {
    fn from(value: rusqlite::Error) -> Self {
        Self::Sqlite(value)
    }
}

#[derive(Debug, Default)]
pub struct AuditTrail {
    pub incidents: Vec<IncidentRecord>,
    pub execution_events: Vec<ExecutionEventRecord>,
    pub order_intents: Vec<OrderIntentRecord>,
    pub trade_outcomes: Vec<ClosedTradeRecord>,
    store: Option<AuditStore>,
}

impl AuditTrail {
    pub fn with_store(store: AuditStore) -> Self {
        Self {
            incidents: Vec::new(),
            execution_events: Vec::new(),
            order_intents: Vec::new(),
            trade_outcomes: Vec::new(),
            store: Some(store),
        }
    }

    pub fn record_incident(&mut self, incident: IncidentRecord) {
        if let Some(store) = &self.store {
            if let Err(error) = store.persist_incident(&incident) {
                eprintln!("failed to persist incident: {error}");
            }
        }
        self.incidents.push(incident);
    }

    pub fn record_order_intent(&mut self, intent: OrderIntentRecord) {
        if let Some(store) = &self.store {
            if let Err(error) = store.persist_order_intent(&intent) {
                eprintln!("failed to persist order intent: {error}");
            }
        }
        self.order_intents.push(intent);
    }

    pub fn record_execution_event(&mut self, event: ExecutionEventRecord) {
        if let Some(store) = &self.store {
            if let Err(error) = store.persist_execution_event(&event) {
                eprintln!("failed to persist execution event: {error}");
            }
        }
        self.execution_events.push(event);
    }

    pub fn record_account_balances(&mut self, balances: &[AccountBalance]) {
        if let Some(store) = &self.store {
            if let Err(error) = store.persist_account_balances(balances) {
                eprintln!("failed to persist account balances: {error}");
            }
        }
    }

    pub fn record_trade_outcome(&mut self, outcome: ClosedTradeRecord) {
        if let Some(store) = &self.store {
            if let Err(error) = store.persist_trade_outcome(&outcome) {
                eprintln!("failed to persist trade outcome: {error}");
            }
        }
        self.trade_outcomes.push(outcome);
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SnapshotBalance {
    pub asset: String,
    pub wallet_balance: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SnapshotPosition {
    pub symbol: String,
    pub quantity: f64,
    pub entry_price: f64,
    pub leverage: u8,
    pub unrealized_pnl: f64,
    pub notional_usd: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SnapshotCandlePoint {
    pub symbol: String,
    pub timestamp_ms: u64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotKpi {
    pub label: String,
    pub value: String,
    pub tone: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotOpportunity {
    pub symbol: String,
    pub family: String,
    pub regime: String,
    pub model_id: String,
    pub model_scope: String,
    pub confidence: String,
    pub action: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SnapshotIndicatorPoint {
    pub symbol: String,
    pub timestamp_ms: u64,
    pub price: f64,
    pub ema_fast: f64,
    pub ema_slow: f64,
    pub rsi: f64,
    pub macd_histogram: f64,
    pub signal_consensus: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SnapshotResearchModel {
    pub id: String,
    pub engine: String,
    pub symbol: String,
    pub regime: String,
    pub family: String,
    pub score: f64,
    pub profitability: f64,
    pub robustness: f64,
    pub risk_adjusted_return: f64,
    pub latency_score: f64,
    pub threshold: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SnapshotPromotedIndicator {
    pub id: Option<String>,
    pub overlay_enabled: bool,
    pub leaderboard_count: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SnapshotNewsSentiment {
    pub sentiment_score: f64,
    pub confidence: f64,
    pub catalyst_score: f64,
    pub risk_off: bool,
    pub themes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RuntimeSnapshot {
    pub mode: String,
    pub venue: String,
    pub host: String,
    pub headline: String,
    pub kpis: Vec<SnapshotKpi>,
    pub opportunities: Vec<SnapshotOpportunity>,
    pub risk_notes: Vec<String>,
    pub heal_logs: Vec<String>,
    pub cycle: u64,
    pub updated_at: String,
    pub execution_summary: String,
    pub exchange_gate: String,
    pub balances: Vec<SnapshotBalance>,
    pub positions: Vec<SnapshotPosition>,
    pub candle_points: Vec<SnapshotCandlePoint>,
    pub indicator_points: Vec<SnapshotIndicatorPoint>,
    pub research_models: Vec<SnapshotResearchModel>,
    pub promoted_indicator: SnapshotPromotedIndicator,
    pub news_sentiment: SnapshotNewsSentiment,
}

impl RuntimeSnapshot {
    pub fn to_json(&self) -> String {
        format!(
            concat!(
                "{{",
                "\"mode\":{},",
                "\"venue\":{},",
                "\"host\":{},",
                "\"headline\":{},",
                "\"kpis\":[{}],",
                "\"opportunities\":[{}],",
                "\"risk_notes\":[{}],",
                "\"heal_logs\":[{}],",
                "\"cycle\":{},",
                "\"updated_at\":{},",
                "\"execution_summary\":{},",
                "\"exchange_gate\":{},",
                "\"balances\":[{}],",
                "\"positions\":[{}],",
                "\"candle_points\":[{}],",
                "\"indicator_points\":[{}],",
                "\"research_models\":[{}],",
                "\"promoted_indicator\":{},",
                "\"news_sentiment\":{}",
                "}}"
            ),
            json_string(&self.mode),
            json_string(&self.venue),
            json_string(&self.host),
            json_string(&self.headline),
            self.kpis
                .iter()
                .map(|kpi| {
                    format!(
                        "{{\"label\":{},\"value\":{},\"tone\":{}}}",
                        json_string(&kpi.label),
                        json_string(&kpi.value),
                        json_string(&kpi.tone)
                    )
                })
                .collect::<Vec<_>>()
                .join(","),
            self.opportunities
                .iter()
                .map(|opportunity| {
                    format!(
                        "{{\"symbol\":{},\"family\":{},\"regime\":{},\"model_id\":{},\"model_scope\":{},\"confidence\":{},\"action\":{}}}",
                        json_string(&opportunity.symbol),
                        json_string(&opportunity.family),
                        json_string(&opportunity.regime),
                        json_string(&opportunity.model_id),
                        json_string(&opportunity.model_scope),
                        json_string(&opportunity.confidence),
                        json_string(&opportunity.action)
                    )
                })
                .collect::<Vec<_>>()
                .join(","),
            self.risk_notes
                .iter()
                .map(|value| json_string(value))
                .collect::<Vec<_>>()
                .join(","),
            self.heal_logs
                .iter()
                .map(|value| json_string(value))
                .collect::<Vec<_>>()
                .join(","),
            self.cycle,
            json_string(&self.updated_at),
            json_string(&self.execution_summary),
            json_string(&self.exchange_gate),
            self.balances
                .iter()
                .map(|balance| {
                    format!(
                        "{{\"asset\":{},\"wallet_balance\":{}}}",
                        json_string(&balance.asset),
                        balance.wallet_balance
                    )
                })
                .collect::<Vec<_>>()
                .join(","),
            self.positions
                .iter()
                .map(|position| {
                    format!(
                        concat!(
                            "{{",
                            "\"symbol\":{},",
                            "\"quantity\":{},",
                            "\"entry_price\":{},",
                            "\"leverage\":{},",
                            "\"unrealized_pnl\":{},",
                            "\"notional_usd\":{}",
                            "}}"
                        ),
                        json_string(&position.symbol),
                        position.quantity,
                        position.entry_price,
                        position.leverage,
                        position.unrealized_pnl,
                        position.notional_usd,
                    )
                })
                .collect::<Vec<_>>()
                .join(","),
            self.candle_points
                .iter()
                .map(|point| {
                    format!(
                        concat!(
                            "{{",
                            "\"symbol\":{},",
                            "\"timestamp_ms\":{},",
                            "\"open\":{},",
                            "\"high\":{},",
                            "\"low\":{},",
                            "\"close\":{},",
                            "\"volume\":{}",
                            "}}"
                        ),
                        json_string(&point.symbol),
                        point.timestamp_ms,
                        point.open,
                        point.high,
                        point.low,
                        point.close,
                        point.volume,
                    )
                })
                .collect::<Vec<_>>()
                .join(","),
            self.indicator_points
                .iter()
                .map(|point| {
                    format!(
                        concat!(
                            "{{",
                            "\"symbol\":{},",
                            "\"timestamp_ms\":{},",
                            "\"price\":{},",
                            "\"ema_fast\":{},",
                            "\"ema_slow\":{},",
                            "\"rsi\":{},",
                            "\"macd_histogram\":{},",
                            "\"signal_consensus\":{}",
                            "}}"
                        ),
                        json_string(&point.symbol),
                        point.timestamp_ms,
                        point.price,
                        point.ema_fast,
                        point.ema_slow,
                        point.rsi,
                        point.macd_histogram,
                        point.signal_consensus,
                    )
                })
                .collect::<Vec<_>>()
                .join(","),
            self.research_models
                .iter()
                .map(|model| {
                    format!(
                        concat!(
                            "{{",
                            "\"id\":{},",
                            "\"engine\":{},",
                            "\"symbol\":{},",
                            "\"regime\":{},",
                            "\"family\":{},",
                            "\"score\":{},",
                            "\"profitability\":{},",
                            "\"robustness\":{},",
                            "\"risk_adjusted_return\":{},",
                            "\"latency_score\":{},",
                            "\"threshold\":{}",
                            "}}"
                        ),
                        json_string(&model.id),
                        json_string(&model.engine),
                        json_string(&model.symbol),
                        json_string(&model.regime),
                        json_string(&model.family),
                        model.score,
                        model.profitability,
                        model.robustness,
                        model.risk_adjusted_return,
                        model.latency_score,
                        model.threshold,
                    )
                })
                .collect::<Vec<_>>()
                .join(","),
            format!(
                concat!(
                    "{{",
                    "\"id\":{},",
                    "\"overlay_enabled\":{},",
                    "\"leaderboard_count\":{}",
                    "}}"
                ),
                self.promoted_indicator
                    .id
                    .as_ref()
                    .map(|value| json_string(value))
                    .unwrap_or_else(|| "null".to_string()),
                self.promoted_indicator.overlay_enabled,
                self.promoted_indicator.leaderboard_count,
            ),
            format!(
                concat!(
                    "{{",
                    "\"sentiment_score\":{},",
                    "\"confidence\":{},",
                    "\"catalyst_score\":{},",
                    "\"risk_off\":{},",
                    "\"themes\":[{}]",
                    "}}"
                ),
                self.news_sentiment.sentiment_score,
                self.news_sentiment.confidence,
                self.news_sentiment.catalyst_score,
                self.news_sentiment.risk_off,
                self.news_sentiment
                    .themes
                    .iter()
                    .map(|theme| json_string(theme))
                    .collect::<Vec<_>>()
                    .join(","),
            ),
        )
    }
}

pub fn write_runtime_snapshot(path: impl AsRef<Path>, snapshot: &RuntimeSnapshot) -> std::io::Result<()> {
    let path = path.as_ref();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, snapshot.to_json())
}

fn json_string(value: &str) -> String {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n");
    format!("\"{}\"", escaped)
}

fn current_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn ships_bootstrap_migrations() {
        assert_eq!(bootstrap_migrations().len(), 28);
    }

    #[test]
    fn records_incidents_and_orders() {
        let mut audit = AuditTrail::default();
        audit.record_incident(IncidentRecord {
            mode: RuntimeMode::Protected,
            message: "feed stale".to_string(),
        });
        audit.record_order_intent(OrderIntentRecord {
            symbol: "BTCUSDT".to_string(),
            mode: RuntimeMode::Paper,
            decision: "PaperTest".to_string(),
            size_usd: 50.0,
            model_id: "balanced-core".to_string(),
            model_scope: "BTCUSDT / Trend Pullback / Trending".to_string(),
            indicator_id: "indicator-alpha".to_string(),
            indicator_scope: "BTCUSDT / Trend Pullback / Trending".to_string(),
        });

        assert_eq!(audit.incidents.len(), 1);
        assert_eq!(audit.order_intents.len(), 1);
    }

    #[test]
    fn persists_audit_records_to_sqlite() {
        let database_path = std::env::temp_dir().join(format!(
            "sthyra-audit-{}.sqlite3",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time should move forward")
                .as_nanos()
        ));
        let store = AuditStore::open(&database_path).expect("sqlite store should initialize");
        let mut audit = AuditTrail::with_store(store.clone());

        audit.record_incident(IncidentRecord {
            mode: RuntimeMode::Research,
            message: "booted".to_string(),
        });
        audit.record_order_intent(OrderIntentRecord {
            symbol: "BTCUSDT".to_string(),
            mode: RuntimeMode::Paper,
            decision: "PaperTest".to_string(),
            size_usd: 25.0,
            model_id: "balanced-core".to_string(),
            model_scope: "BTCUSDT / Trend Pullback / Trending".to_string(),
            indicator_id: "indicator-alpha".to_string(),
            indicator_scope: "BTCUSDT / Trend Pullback / Trending".to_string(),
        });
        audit.record_execution_event(ExecutionEventRecord {
            symbol: "BTCUSDT".to_string(),
            mode: RuntimeMode::Paper,
            decision: "PaperTest".to_string(),
            event_type: "intent-created".to_string(),
            state: "IntentCreated".to_string(),
            detail: "paper intent seeded".to_string(),
            model_id: "balanced-core".to_string(),
            model_scope: "BTCUSDT / Trend Pullback / Trending".to_string(),
            indicator_id: "indicator-alpha".to_string(),
            indicator_scope: "BTCUSDT / Trend Pullback / Trending".to_string(),
        });
        audit.record_trade_outcome(ClosedTradeRecord {
            timestamp_ms: current_timestamp_ms(),
            entry_timestamp_ms: Some(current_timestamp_ms().saturating_sub(60_000)),
            symbol: "BTCUSDT".to_string(),
            mode: RuntimeMode::Paper,
            side: "Long".to_string(),
            quantity: 0.01,
            entry_price: 100000.0,
            exit_price: 101000.0,
            realized_pnl: 10.0,
            pnl_ratio: 0.01,
            close_reason: "position-flat".to_string(),
            source: "unit-test".to_string(),
            model_id: "balanced-core".to_string(),
            model_scope: "BTCUSDT / Trend Pullback / Trending".to_string(),
            indicator_id: "indicator-alpha".to_string(),
            indicator_scope: "BTCUSDT / Trend Pullback / Trending".to_string(),
        });

        assert_eq!(store.count_incidents().expect("incident count should query"), 1);
        assert_eq!(store.count_order_intents().expect("order count should query"), 1);
        assert_eq!(store.count_execution_events().expect("execution count should query"), 1);
        assert_eq!(store.count_trade_outcomes().expect("trade outcome count should query"), 1);

        let _ = fs::remove_file(database_path);
    }

    #[test]
    fn retains_recent_trade_outcomes_only() {
        let database_path = std::env::temp_dir().join(format!(
            "sthyra-trade-outcomes-{}.sqlite3",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time should move forward")
                .as_nanos()
        ));
        let store = AuditStore::open(&database_path).expect("sqlite store should initialize");

        for value in 0..(TRADE_OUTCOME_RETENTION_LIMIT + 10) {
            store
                .persist_trade_outcome(&ClosedTradeRecord {
                    timestamp_ms: current_timestamp_ms() + u64::from(value),
                    entry_timestamp_ms: Some(current_timestamp_ms()),
                    symbol: "BTCUSDT".to_string(),
                    mode: RuntimeMode::Paper,
                    side: "Long".to_string(),
                    quantity: 0.01,
                    entry_price: 100000.0,
                    exit_price: 100100.0,
                    realized_pnl: f64::from(value),
                    pnl_ratio: 0.001,
                    close_reason: "position-flat".to_string(),
                    source: "test".to_string(),
                    model_id: "balanced-core".to_string(),
                    model_scope: "BTCUSDT / Trend Pullback / Trending".to_string(),
                    indicator_id: "indicator-alpha".to_string(),
                    indicator_scope: "BTCUSDT / Trend Pullback / Trending".to_string(),
                })
                .expect("trade outcome should persist");
        }

        assert_eq!(
            store.count_trade_outcomes().expect("trade outcome count should query"),
            TRADE_OUTCOME_RETENTION_LIMIT
        );

        let _ = fs::remove_file(database_path);
    }

    #[test]
    fn persists_trade_fill_watermark() {
        let database_path = std::env::temp_dir().join(format!(
            "sthyra-runtime-state-{}.sqlite3",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time should move forward")
                .as_nanos()
        ));
        let store = AuditStore::open(&database_path).expect("sqlite store should initialize");

        assert_eq!(
            store
                .read_trade_fill_watermark_ms()
                .expect("runtime state should query"),
            None
        );

        store
            .persist_trade_fill_watermark_ms(123_456)
            .expect("trade fill watermark should persist");

        assert_eq!(
            store
                .read_trade_fill_watermark_ms()
                .expect("runtime state should query"),
            Some(123_456)
        );

        let _ = fs::remove_file(database_path);
    }

    #[test]
    fn persists_position_state_cache() {
        let database_path = std::env::temp_dir().join(format!(
            "sthyra-position-cache-{}.sqlite3",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time should move forward")
                .as_nanos()
        ));
        let store = AuditStore::open(&database_path).expect("sqlite store should initialize");

        store
            .persist_position_state_cache(&[
                PositionState {
                    symbol: "BTCUSDT".to_string(),
                    quantity: 0.05,
                    entry_price: 100000.0,
                    leverage: 5,
                    unrealized_pnl: 75.0,
                },
                PositionState {
                    symbol: "ETHUSDT".to_string(),
                    quantity: -0.5,
                    entry_price: 4000.0,
                    leverage: 3,
                    unrealized_pnl: -12.0,
                },
            ])
            .expect("position cache should persist");

        let cached_positions = store
            .read_position_state_cache()
            .expect("position cache should query");

        assert_eq!(cached_positions.len(), 2);
        assert_eq!(cached_positions[0].symbol, "BTCUSDT");
        assert_eq!(cached_positions[1].symbol, "ETHUSDT");

        store
            .persist_position_state_cache(&[])
            .expect("position cache should clear");

        assert!(store
            .read_position_state_cache()
            .expect("position cache should query")
            .is_empty());

        let _ = fs::remove_file(database_path);
    }

    #[test]
    fn syncs_position_entry_timestamps_across_reduces_and_flips() {
        let database_path = std::env::temp_dir().join(format!(
            "sthyra-position-entry-cache-{}.sqlite3",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time should move forward")
                .as_nanos()
        ));
        let store = AuditStore::open(&database_path).expect("sqlite store should initialize");

        let initial_position = PositionState {
            symbol: "BTCUSDT".to_string(),
            quantity: 0.05,
            entry_price: 100000.0,
            leverage: 5,
            unrealized_pnl: 75.0,
        };
        store
            .sync_position_entry_timestamps(&[], &[initial_position.clone()])
            .expect("position entry timestamps should initialize");
        let initial_entry_timestamp = store
            .read_position_entry_timestamp_ms("BTCUSDT")
            .expect("position entry timestamp should read")
            .expect("initial timestamp should exist");

        std::thread::sleep(std::time::Duration::from_millis(2));

        let reduced_position = PositionState {
            quantity: 0.02,
            ..initial_position.clone()
        };
        store
            .sync_position_entry_timestamps(&[initial_position.clone()], &[reduced_position.clone()])
            .expect("position entry timestamp should survive reductions");
        let reduced_entry_timestamp = store
            .read_position_entry_timestamp_ms("BTCUSDT")
            .expect("position entry timestamp should read")
            .expect("reduced timestamp should exist");
        assert_eq!(reduced_entry_timestamp, initial_entry_timestamp);

        std::thread::sleep(std::time::Duration::from_millis(2));

        let flipped_position = PositionState {
            quantity: -0.02,
            ..reduced_position.clone()
        };
        store
            .sync_position_entry_timestamps(&[reduced_position], &[flipped_position])
            .expect("position entry timestamp should reset on flips");
        let flipped_entry_timestamp = store
            .read_position_entry_timestamp_ms("BTCUSDT")
            .expect("position entry timestamp should read")
            .expect("flipped timestamp should exist");
        assert!(flipped_entry_timestamp >= reduced_entry_timestamp);
        assert_ne!(flipped_entry_timestamp, reduced_entry_timestamp);

        let _ = fs::remove_file(database_path);
    }

    #[test]
    fn persists_position_model_attribution() {
        let database_path = std::env::temp_dir().join(format!(
            "sthyra-position-models-{}.sqlite3",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time should move forward")
                .as_nanos()
        ));
        let store = AuditStore::open(&database_path).expect("sqlite store should initialize");

        store
            .persist_position_model_attribution(&PositionModelAttribution {
                symbol: "BTCUSDT".to_string(),
                model_id: "balanced-core".to_string(),
                model_scope: "BTCUSDT / Trend Pullback / Trending".to_string(),
                indicator_id: "indicator-alpha".to_string(),
                indicator_scope: "BTCUSDT / Trend Pullback / Trending".to_string(),
            })
            .expect("position model attribution should persist");

        let attribution = store
            .read_position_model_attribution("BTCUSDT")
            .expect("position model attribution should query")
            .expect("position model attribution should exist");

        assert_eq!(attribution.model_id, "balanced-core");
        assert_eq!(attribution.indicator_id, "indicator-alpha");

        store
            .delete_position_model_attribution("BTCUSDT")
            .expect("position model attribution should delete");

        assert!(store
            .read_position_model_attribution("BTCUSDT")
            .expect("position model attribution should query")
            .is_none());

        let _ = fs::remove_file(database_path);
    }

    #[test]
    fn retains_recent_order_intents_only() {
        let database_path = std::env::temp_dir().join(format!(
            "sthyra-order-retention-{}.sqlite3",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time should move forward")
                .as_nanos()
        ));
        let store = AuditStore::open(&database_path).expect("sqlite store should initialize");

        for value in 0..(ORDER_INTENT_RETENTION_LIMIT + 8) {
            store
                .persist_order_intent(&OrderIntentRecord {
                    symbol: "BTCUSDT".to_string(),
                    mode: RuntimeMode::Research,
                    decision: "Approve".to_string(),
                    size_usd: 10.0 + f64::from(value),
                    model_id: format!("model-{}", value % 3),
                    model_scope: "BTCUSDT / Trend Pullback / Trending".to_string(),
                    indicator_id: format!("indicator-{}", value % 2),
                    indicator_scope: "BTCUSDT / Trend Pullback / Trending".to_string(),
                })
                .expect("order intent should persist");
        }

        assert_eq!(
            store.count_order_intents().expect("order count should query"),
            ORDER_INTENT_RETENTION_LIMIT
        );

        let _ = fs::remove_file(database_path);
    }

    #[test]
    fn retains_recent_execution_events_only() {
        let database_path = std::env::temp_dir().join(format!(
            "sthyra-execution-retention-{}.sqlite3",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time should move forward")
                .as_nanos()
        ));
        let store = AuditStore::open(&database_path).expect("sqlite store should initialize");

        for value in 0..(EXECUTION_EVENT_RETENTION_LIMIT + 12) {
            store
                .persist_execution_event(&ExecutionEventRecord {
                    symbol: "BTCUSDT".to_string(),
                    mode: RuntimeMode::Research,
                    decision: "Approve".to_string(),
                    event_type: "risk-rejected".to_string(),
                    state: "IntentCreated".to_string(),
                    detail: format!("event-{value}"),
                    model_id: "balanced-core".to_string(),
                    model_scope: "BTCUSDT / Trend Pullback / Trending".to_string(),
                    indicator_id: "indicator-alpha".to_string(),
                    indicator_scope: "BTCUSDT / Trend Pullback / Trending".to_string(),
                })
                .expect("execution event should persist");
        }

        assert_eq!(
            store.count_execution_events().expect("execution count should query"),
            EXECUTION_EVENT_RETENTION_LIMIT
        );

        let _ = fs::remove_file(database_path);
    }

    #[test]
    fn prunes_order_intents_by_age() {
        let database_path = std::env::temp_dir().join(format!(
            "sthyra-order-age-{}.sqlite3",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time should move forward")
                .as_nanos()
        ));
        let store = AuditStore::open(&database_path).expect("sqlite store should initialize");
        let connection = Connection::open(&database_path).expect("sqlite connection should open");
        let now_ms = current_timestamp_ms();

        connection
            .execute(
                "insert into order_intents (symbol, mode, decision, size_usd, dedupe_key, timestamp_ms, model_id, model_scope, indicator_id, indicator_scope) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params!["BTCUSDT", "Research", "Approve", 10.0_f64, "aged-order", now_ms - ORDER_INTENT_RETENTION_MAX_AGE_MS - 1, "balanced-core", "BTCUSDT / Trend Pullback / Trending", "indicator-alpha", "BTCUSDT / Trend Pullback / Trending"],
            )
            .expect("stale order intent should insert");

        prune_table_to_age(&connection, "order_intents", "timestamp_ms", ORDER_INTENT_RETENTION_MAX_AGE_MS, now_ms)
            .expect("aged rows should prune");

        assert_eq!(store.count_order_intents().expect("order count should query"), 0);

        let _ = fs::remove_file(database_path);
    }

    #[test]
    fn prunes_execution_events_by_age() {
        let database_path = std::env::temp_dir().join(format!(
            "sthyra-execution-age-{}.sqlite3",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time should move forward")
                .as_nanos()
        ));
        let store = AuditStore::open(&database_path).expect("sqlite store should initialize");
        let connection = Connection::open(&database_path).expect("sqlite connection should open");
        let now_ms = current_timestamp_ms();

        connection
            .execute(
                "insert into execution_events (timestamp_ms, symbol, mode, decision, event_type, state, detail, model_id, model_scope) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    now_ms - EXECUTION_EVENT_RETENTION_MAX_AGE_MS - 1,
                    "BTCUSDT",
                    "Research",
                    "Approve",
                    "risk-rejected",
                    "IntentCreated",
                    "aged-event",
                    "balanced-core",
                    "BTCUSDT / Trend Pullback / Trending",
                ],
            )
            .expect("stale execution event should insert");

        prune_table_to_age(
            &connection,
            "execution_events",
            "timestamp_ms",
            EXECUTION_EVENT_RETENTION_MAX_AGE_MS,
            now_ms,
        )
        .expect("aged rows should prune");

        assert_eq!(store.count_execution_events().expect("execution count should query"), 0);

        let _ = fs::remove_file(database_path);
    }

    #[test]
    fn serializes_runtime_snapshot() {
        let snapshot = RuntimeSnapshot {
            mode: "Protected".to_string(),
            venue: "Binance USD-M".to_string(),
            host: "Mac Local Runtime".to_string(),
            headline: "Institutional Local Trading Machine".to_string(),
            cycle: 1,
            updated_at: "1234567890".to_string(),
            kpis: vec![SnapshotKpi {
                label: "System Mode".to_string(),
                value: "Protected".to_string(),
                tone: "warn".to_string(),
            }],
            opportunities: vec![SnapshotOpportunity {
                symbol: "BTCUSDT".to_string(),
                family: "Trend Pullback".to_string(),
                regime: "Trending".to_string(),
                model_id: "balanced-core".to_string(),
                model_scope: "BTCUSDT / Trend Pullback / Trending".to_string(),
                confidence: "0.84".to_string(),
                action: "Approve".to_string(),
            }],
            risk_notes: vec!["Per-trade cap 50 bps".to_string()],
            heal_logs: vec!["Watchdog healthy".to_string()],
            execution_summary: "ReconciliationPending".to_string(),
            exchange_gate: "Rules validated".to_string(),
            balances: vec![SnapshotBalance {
                asset: "USDT".to_string(),
                wallet_balance: 1234.56,
            }],
            positions: vec![SnapshotPosition {
                symbol: "BTCUSDT".to_string(),
                quantity: 0.01,
                entry_price: 100000.0,
                leverage: 5,
                unrealized_pnl: 12.5,
                notional_usd: 1000.0,
            }],
            candle_points: vec![SnapshotCandlePoint {
                symbol: "BTCUSDT".to_string(),
                timestamp_ms: 1,
                open: 99990.0,
                high: 100020.0,
                low: 99980.0,
                close: 100000.0,
                volume: 42.0,
            }],
            indicator_points: vec![SnapshotIndicatorPoint {
                symbol: "BTCUSDT".to_string(),
                timestamp_ms: 1,
                price: 100000.0,
                ema_fast: 99990.0,
                ema_slow: 99980.0,
                rsi: 58.0,
                macd_histogram: 12.0,
                signal_consensus: 0.76,
            }],
            research_models: vec![SnapshotResearchModel {
                id: "balanced-core".to_string(),
                engine: "signal-model".to_string(),
                symbol: "BTCUSDT".to_string(),
                regime: "Trending".to_string(),
                family: "TrendPullbackContinuation".to_string(),
                score: 0.71,
                profitability: 0.2,
                robustness: 0.8,
                risk_adjusted_return: 0.12,
                latency_score: 1.0,
                threshold: 0.61,
            }],
            promoted_indicator: SnapshotPromotedIndicator {
                id: Some("momentum-rsi-macd-g2".to_string()),
                overlay_enabled: true,
                leaderboard_count: 3,
            },
            news_sentiment: SnapshotNewsSentiment {
                sentiment_score: 0.2,
                confidence: 0.5,
                catalyst_score: 0.3,
                risk_off: false,
                themes: vec!["macro".to_string()],
            },
        };

        let json = snapshot.to_json();
        assert!(json.contains("System Mode"));
        assert!(json.contains("BTCUSDT"));
        assert!(json.contains("updated_at"));
        assert!(json.contains("wallet_balance"));
        assert!(json.contains("unrealized_pnl"));
        assert!(json.contains("candle_points"));
        assert!(json.contains("indicator_points"));
        assert!(json.contains("promoted_indicator"));
        assert!(json.contains("news_sentiment"));
    }
}
