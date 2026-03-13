use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use hmac::{Hmac, Mac};
use reqwest::blocking::Client;
use reqwest::header::{HeaderMap, HeaderValue};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use sthyra_account_state::{AccountBalance, AccountSnapshot, OpenOrderState, PositionState};
use sthyra_domain::{OrderIntent, Symbol};
use sthyra_market_data::{Candle, OrderBookSnapshot};
use tungstenite::{connect, Message};

type HmacSha256 = Hmac<Sha256>;

const DEFAULT_MAX_LEVERAGE: u8 = 20;
const DEFAULT_MIN_NOTIONAL: f64 = 5.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinanceEnvironment {
    Testnet,
    Mainnet,
}

impl BinanceEnvironment {
    pub fn rest_base_url(self) -> &'static str {
        match self {
            Self::Testnet => "https://testnet.binancefuture.com",
            Self::Mainnet => "https://fapi.binance.com",
        }
    }

    pub fn websocket_base_url(self) -> &'static str {
        match self {
            Self::Testnet => "wss://stream.binancefuture.com/ws",
            Self::Mainnet => "wss://fstream.binance.com/ws",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinanceEndpoint {
    ExchangeInfo,
    Account,
    Positions,
    OpenOrders,
    Order,
    UserTrades,
    Klines,
}

impl BinanceEndpoint {
    pub fn path(self) -> &'static str {
        match self {
            Self::ExchangeInfo => "/fapi/v1/exchangeInfo",
            Self::Account => "/fapi/v2/account",
            Self::Positions => "/fapi/v2/positionRisk",
            Self::OpenOrders => "/fapi/v1/openOrders",
            Self::Order => "/fapi/v1/order",
            Self::UserTrades => "/fapi/v1/userTrades",
            Self::Klines => "/fapi/v1/klines",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct BinanceRequest {
    pub method: &'static str,
    pub url: String,
    pub requires_signature: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BinanceCredentials {
    pub api_key: String,
    pub api_secret: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedRequestPreview {
    pub query_string: String,
    pub signature: String,
    pub signing_command_preview: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedRestRequest {
    pub method: &'static str,
    pub url: String,
    pub query_string: String,
    pub signature: String,
    pub api_key_header: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamKind {
    BookTicker,
    AggTrade,
    Kline1m,
    MarkPrice,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OrderSide {
    Buy,
    Sell,
}

impl OrderSide {
    fn as_str(self) -> &'static str {
        match self {
            Self::Buy => "BUY",
            Self::Sell => "SELL",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OrderType {
    Market,
    Limit,
}

impl OrderType {
    fn as_str(self) -> &'static str {
        match self {
            Self::Market => "MARKET",
            Self::Limit => "LIMIT",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct NewOrderRequest {
    pub symbol: String,
    pub side: OrderSide,
    pub order_type: OrderType,
    pub quantity: f64,
    pub price: Option<f64>,
    pub reduce_only: bool,
    pub client_order_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CancelOrderRequest {
    pub symbol: String,
    pub orig_client_order_id: Option<String>,
    pub order_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SubmittedOrder {
    pub symbol: String,
    pub client_order_id: String,
    pub order_id: String,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct UserTrade {
    pub symbol: String,
    pub order_id: i64,
    pub is_buy: bool,
    pub price: f64,
    pub quantity: f64,
    pub realized_pnl: f64,
    pub time_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RemoteKline {
    pub open_time_ms: u64,
    pub close_time_ms: u64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
}

impl RemoteKline {
    pub fn to_candle(&self) -> Candle {
        Candle {
            open: self.open,
            high: self.high,
            low: self.low,
            close: self.close,
            volume: self.volume,
            close_time_ms: self.close_time_ms,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExchangeSymbolRules {
    pub symbol: String,
    pub tick_size: f64,
    pub step_size: f64,
    pub min_qty: f64,
    pub min_notional: f64,
    pub max_leverage: u8,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExchangeValidationInput {
    pub order: OrderIntent,
    pub quantity: f64,
    pub price: f64,
    pub leverage: u8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExchangeValidationError {
    InvalidQuantity,
    InvalidPrice,
    LeverageExceeded,
    MinNotionalViolation,
    QuantityStepViolation,
    TickSizeViolation,
    UnknownSymbol,
}

#[derive(Debug, Clone, PartialEq)]
/// Funding rate fetched from Binance Futures.
#[derive(Debug, Clone, PartialEq)]
pub struct FundingRateSnapshot {
    pub symbol: String,
    pub rate: f64,
    pub next_funding_ms: u64,
}

/// Open interest fetched from Binance Futures.
#[derive(Debug, Clone, PartialEq)]
pub struct OpenInterestSnapshot {
    pub symbol: String,
    pub open_interest: f64,
}

/// Top N bid/ask levels from the order book.
#[derive(Debug, Clone, PartialEq)]
pub struct OrderBookDepth {
    pub symbol: String,
    pub bids: Vec<(f64, f64)>,
    pub asks: Vec<(f64, f64)>,
}

impl OrderBookDepth {
    /// Largest stacked bid wall within `price_range_pct` of mid price (0–1 normalised).
    pub fn bid_wall_strength(&self, price_range_pct: f64) -> f64 {
        let mid = self.mid_price();
        let threshold = mid * (1.0 - price_range_pct);
        let total: f64 = self.bids.iter().filter(|(p, _)| *p >= threshold).map(|(_, q)| q).sum();
        total
    }

    /// Largest stacked ask wall within `price_range_pct` of mid price (0–1 normalised).
    pub fn ask_wall_strength(&self, price_range_pct: f64) -> f64 {
        let mid = self.mid_price();
        let threshold = mid * (1.0 + price_range_pct);
        let total: f64 = self.asks.iter().filter(|(p, _)| *p <= threshold).map(|(_, q)| q).sum();
        total
    }

    /// Bid/ask depth imbalance in range: +1 = all bids, -1 = all asks.
    pub fn depth_imbalance(&self, price_range_pct: f64) -> f64 {
        let bid = self.bid_wall_strength(price_range_pct);
        let ask = self.ask_wall_strength(price_range_pct);
        let total = bid + ask;
        if total <= 0.0 { return 0.0; }
        (bid - ask) / total
    }

    fn mid_price(&self) -> f64 {
        let best_bid = self.bids.first().map(|(p, _)| *p).unwrap_or(0.0);
        let best_ask = self.asks.first().map(|(p, _)| *p).unwrap_or(0.0);
        (best_bid + best_ask) / 2.0
    }
}

pub struct RemoteBookTicker {
    pub symbol: String,
    pub bid_price: f64,
    pub ask_price: f64,
    pub bid_qty: f64,
    pub ask_qty: f64,
    pub event_time_ms: u64,
}

impl RemoteBookTicker {
    pub fn to_order_book_snapshot(&self) -> Result<OrderBookSnapshot, BinanceHttpError> {
        Ok(OrderBookSnapshot {
            symbol: Symbol::new(self.symbol.clone())
                .map_err(|error| BinanceHttpError::InvalidSymbol(error.to_string()))?,
            best_bid: self.bid_price,
            best_ask: self.ask_price,
            bid_depth: self.bid_qty,
            ask_depth: self.ask_qty,
            last_update_ms: self.event_time_ms,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BinanceHttpError {
    Exchange(String),
    Http(String),
    InvalidResponse(&'static str),
    InvalidSymbol(String),
    Json(String),
    MissingCredentials,
    InvalidOrderRequest(&'static str),
    Stream(String),
}

impl std::fmt::Display for BinanceHttpError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Exchange(message) => write!(formatter, "exchange rejected request: {message}"),
            Self::Http(message) => write!(formatter, "http request failed: {message}"),
            Self::InvalidResponse(field) => write!(formatter, "invalid Binance response field: {field}"),
            Self::InvalidSymbol(message) => write!(formatter, "invalid symbol: {message}"),
            Self::Json(message) => write!(formatter, "failed to decode Binance response: {message}"),
            Self::MissingCredentials => write!(formatter, "signed Binance request requires credentials"),
            Self::InvalidOrderRequest(message) => write!(formatter, "invalid order request: {message}"),
            Self::Stream(message) => write!(formatter, "websocket stream failed: {message}"),
        }
    }
}

impl std::error::Error for BinanceHttpError {}

pub struct BinanceHttpClient {
    environment: BinanceEnvironment,
    credentials: Option<BinanceCredentials>,
    http: Client,
    recv_window_ms: u64,
}

impl BinanceHttpClient {
    pub fn new(
        environment: BinanceEnvironment,
        credentials: Option<BinanceCredentials>,
    ) -> Result<Self, BinanceHttpError> {
        let http = Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|error| BinanceHttpError::Http(error.to_string()))?;

        Ok(Self {
            environment,
            credentials,
            http,
            recv_window_ms: 5_000,
        })
    }

    pub fn fetch_exchange_rules(&self, symbols: &[&str]) -> Result<Vec<ExchangeSymbolRules>, BinanceHttpError> {
        let response: ExchangeInfoResponse = self.send_public_get(BinanceEndpoint::ExchangeInfo.path(), &[])?;
        let include_all = symbols.is_empty();

        response
            .symbols
            .iter()
            .filter(|entry| include_all || symbols.iter().any(|symbol| *symbol == entry.symbol))
            .map(ExchangeSymbolRules::try_from)
            .collect()
    }

    pub fn fetch_book_ticker(&self, symbol: &str) -> Result<RemoteBookTicker, BinanceHttpError> {
        let params = [("symbol".to_string(), symbol.to_string())];
        let response: BookTickerResponse = self.send_public_get("/fapi/v1/ticker/bookTicker", &params)?;
        RemoteBookTicker::try_from(response)
    }

    pub fn fetch_book_ticker_from_stream(&self, symbol: &str) -> Result<RemoteBookTicker, BinanceHttpError> {
        let url = build_stream_url(self.environment, symbol, StreamKind::BookTicker);
        let (mut socket, _) = connect(&url).map_err(|error| BinanceHttpError::Stream(error.to_string()))?;

        loop {
            let message = socket
                .read()
                .map_err(|error| BinanceHttpError::Stream(error.to_string()))?;

            match message {
                Message::Text(payload) => {
                    let response = serde_json::from_str::<BookTickerStreamResponse>(&payload)
                        .map_err(|error| BinanceHttpError::Json(error.to_string()))?;
                    return RemoteBookTicker::try_from(response);
                }
                Message::Binary(payload) => {
                    let text = String::from_utf8(payload)
                        .map_err(|error| BinanceHttpError::Stream(error.to_string()))?;
                    let response = serde_json::from_str::<BookTickerStreamResponse>(&text)
                        .map_err(|error| BinanceHttpError::Json(error.to_string()))?;
                    return RemoteBookTicker::try_from(response);
                }
                Message::Ping(payload) => {
                    socket
                        .send(Message::Pong(payload))
                        .map_err(|error| BinanceHttpError::Stream(error.to_string()))?;
                }
                Message::Close(frame) => {
                    return Err(BinanceHttpError::Stream(format!("stream closed: {frame:?}")));
                }
                _ => {}
            }
        }
    }

    pub fn fetch_recent_klines(&self, symbol: &str, limit: usize) -> Result<Vec<RemoteKline>, BinanceHttpError> {
        self.fetch_klines_interval(symbol, "1m", limit)
    }

    /// Fetch klines for any interval: "1m", "5m", "15m", "1h", "4h", "1d".
    pub fn fetch_klines_interval(&self, symbol: &str, interval: &str, limit: usize) -> Result<Vec<RemoteKline>, BinanceHttpError> {
        let params = [
            ("symbol".to_string(), symbol.to_string()),
            ("interval".to_string(), interval.to_string()),
            ("limit".to_string(), limit.clamp(1, 250).to_string()),
        ];
        let response: Vec<Vec<serde_json::Value>> = self.send_public_get(BinanceEndpoint::Klines.path(), &params)?;
        response.into_iter().map(RemoteKline::try_from).collect()
    }

    /// Fetch current funding rate for a symbol.
    pub fn fetch_funding_rate(&self, symbol: &str) -> Result<FundingRateSnapshot, BinanceHttpError> {
        let params = [("symbol".to_string(), symbol.to_string())];
        let response: serde_json::Value = self.send_public_get("/fapi/v1/premiumIndex", &params)?;
        let rate = response["lastFundingRate"]
            .as_str()
            .and_then(|s| s.parse::<f64>().ok())
            .unwrap_or(0.0);
        let next_funding_ms = response["nextFundingTime"]
            .as_u64()
            .unwrap_or(0);
        Ok(FundingRateSnapshot { symbol: symbol.to_string(), rate, next_funding_ms })
    }

    /// Fetch current open interest for a symbol.
    pub fn fetch_open_interest(&self, symbol: &str) -> Result<OpenInterestSnapshot, BinanceHttpError> {
        let params = [("symbol".to_string(), symbol.to_string())];
        let response: serde_json::Value = self.send_public_get("/fapi/v1/openInterest", &params)?;
        let open_interest = response["openInterest"]
            .as_str()
            .and_then(|s| s.parse::<f64>().ok())
            .unwrap_or(0.0);
        Ok(OpenInterestSnapshot { symbol: symbol.to_string(), open_interest })
    }

    /// Fetch L2 order book depth (top `limit` levels, max 20).
    pub fn fetch_order_book_depth(&self, symbol: &str, limit: usize) -> Result<OrderBookDepth, BinanceHttpError> {
        let params = [
            ("symbol".to_string(), symbol.to_string()),
            ("limit".to_string(), limit.clamp(5, 20).to_string()),
        ];
        let response: serde_json::Value = self.send_public_get("/fapi/v1/depth", &params)?;

        let parse_levels = |arr: &serde_json::Value| -> Vec<(f64, f64)> {
            arr.as_array()
                .map(|levels| {
                    levels.iter().filter_map(|level| {
                        let price = level[0].as_str()?.parse::<f64>().ok()?;
                        let qty = level[1].as_str()?.parse::<f64>().ok()?;
                        Some((price, qty))
                    }).collect()
                })
                .unwrap_or_default()
        };

        Ok(OrderBookDepth {
            symbol: symbol.to_string(),
            bids: parse_levels(&response["bids"]),
            asks: parse_levels(&response["asks"]),
        })
    }

    pub fn fetch_account_snapshot(&self) -> Result<AccountSnapshot, BinanceHttpError> {
        let account: AccountResponse = self.send_signed_get(BinanceEndpoint::Account, &[])?;
        let open_orders: Vec<OpenOrderResponse> = self.send_signed_get(BinanceEndpoint::OpenOrders, &[])?;

        let balances = account
            .assets
            .into_iter()
            .filter_map(|asset| {
                let wallet_balance = parse_f64(&asset.wallet_balance).ok()?;
                Some(AccountBalance {
                    asset: asset.asset,
                    wallet_balance,
                })
            })
            .collect();

        let positions = account
            .positions
            .into_iter()
            .filter_map(|position| {
                let quantity = parse_f64(&position.position_amt).ok()?;
                if quantity.abs() < 1e-8 {
                    return None;
                }

                Some(PositionState {
                    symbol: position.symbol,
                    quantity,
                    entry_price: parse_f64(&position.entry_price).ok()?,
                    leverage: parse_u8(&position.leverage).ok()?,
                    unrealized_pnl: parse_f64(&position.unrealized_profit).unwrap_or(0.0),
                })
            })
            .collect();

        let open_orders = open_orders
            .into_iter()
            .map(|order| {
                Ok(OpenOrderState {
                    symbol: order.symbol,
                    client_order_id: order.client_order_id,
                    quantity: parse_f64(&order.orig_qty)?,
                })
            })
            .collect::<Result<Vec<_>, BinanceHttpError>>()?;

        Ok(AccountSnapshot {
            balances,
            positions,
            open_orders,
        })
    }

    pub fn submit_order(&self, request: &NewOrderRequest) -> Result<SubmittedOrder, BinanceHttpError> {
        request.validate()?;

        let mut params = vec![
            ("symbol".to_string(), request.symbol.clone()),
            ("side".to_string(), request.side.as_str().to_string()),
            ("type".to_string(), request.order_type.as_str().to_string()),
            ("quantity".to_string(), format_decimal(request.quantity)),
            ("newClientOrderId".to_string(), request.client_order_id.clone()),
            ("reduceOnly".to_string(), request.reduce_only.to_string()),
        ];
        if let Some(price) = request.price {
            params.push(("price".to_string(), format_decimal(price)));
            params.push(("timeInForce".to_string(), "GTC".to_string()));
        }

        let response: OrderResponse = self.send_signed_request("POST", BinanceEndpoint::Order, &params)?;
        Ok(SubmittedOrder {
            symbol: response.symbol,
            client_order_id: response.client_order_id,
            order_id: response.order_id.to_string(),
            status: response.status,
        })
    }

    pub fn cancel_order(&self, request: &CancelOrderRequest) -> Result<SubmittedOrder, BinanceHttpError> {
        if request.order_id.is_none() && request.orig_client_order_id.is_none() {
            return Err(BinanceHttpError::InvalidOrderRequest(
                "cancel requires either order_id or orig_client_order_id",
            ));
        }

        let mut params = vec![("symbol".to_string(), request.symbol.clone())];
        if let Some(order_id) = request.order_id.as_ref() {
            params.push(("orderId".to_string(), order_id.clone()));
        }
        if let Some(client_order_id) = request.orig_client_order_id.as_ref() {
            params.push(("origClientOrderId".to_string(), client_order_id.clone()));
        }

        let response: OrderResponse = self.send_signed_request("DELETE", BinanceEndpoint::Order, &params)?;
        Ok(SubmittedOrder {
            symbol: response.symbol,
            client_order_id: response.client_order_id,
            order_id: response.order_id.to_string(),
            status: response.status,
        })
    }

    pub fn fetch_user_trades(
        &self,
        symbol: &str,
        start_time_ms: Option<u64>,
        end_time_ms: Option<u64>,
    ) -> Result<Vec<UserTrade>, BinanceHttpError> {
        let mut params = vec![("symbol".to_string(), symbol.to_string())];
        if let Some(start_time_ms) = start_time_ms {
            params.push(("startTime".to_string(), start_time_ms.to_string()));
        }
        if let Some(end_time_ms) = end_time_ms {
            params.push(("endTime".to_string(), end_time_ms.to_string()));
        }
        params.push(("limit".to_string(), "1000".to_string()));

        let response: Vec<UserTradeResponse> = self.send_signed_get(BinanceEndpoint::UserTrades, &params)?;
        response.into_iter().map(UserTrade::try_from).collect()
    }

    fn send_public_get<T: DeserializeOwned>(
        &self,
        path: &str,
        params: &[(String, String)],
    ) -> Result<T, BinanceHttpError> {
        let url = format!("{}{}", self.environment.rest_base_url(), path);
        let response = self
            .http
            .get(url)
            .query(params)
            .send()
            .map_err(|error| BinanceHttpError::Http(error.to_string()))?;

        decode_response(response)
    }

    fn send_signed_get<T: DeserializeOwned>(
        &self,
        endpoint: BinanceEndpoint,
        params: &[(String, String)],
    ) -> Result<T, BinanceHttpError> {
        self.send_signed_request("GET", endpoint, params)
    }

    fn send_signed_request<T: DeserializeOwned>(
        &self,
        method: &'static str,
        endpoint: BinanceEndpoint,
        params: &[(String, String)],
    ) -> Result<T, BinanceHttpError> {
        let credentials = self.credentials.as_ref().ok_or(BinanceHttpError::MissingCredentials)?;
        let signed_request = build_signed_rest_request(
            self.environment,
            endpoint,
            method,
            params,
            self.recv_window_ms,
            credentials,
        )?;

        let mut headers = HeaderMap::new();
        headers.insert(
            "X-MBX-APIKEY",
            HeaderValue::from_str(&signed_request.api_key_header)
                .map_err(|error| BinanceHttpError::Http(error.to_string()))?,
        );

        let url = format!(
            "{}?{}&signature={}",
            signed_request.url, signed_request.query_string, signed_request.signature
        );
        let request_builder = match method {
            "GET" => self.http.get(url),
            "POST" => self.http.post(url),
            "DELETE" => self.http.delete(url),
            _ => return Err(BinanceHttpError::Http("unsupported signed method".to_string())),
        };
        let response = request_builder
            .headers(headers)
            .send()
            .map_err(|error| BinanceHttpError::Http(error.to_string()))?;

        decode_response(response)
    }
}

pub fn build_request(environment: BinanceEnvironment, endpoint: BinanceEndpoint) -> BinanceRequest {
    let requires_signature = !matches!(endpoint, BinanceEndpoint::ExchangeInfo);
    BinanceRequest {
        method: match endpoint {
            BinanceEndpoint::Order => "POST",
            _ => "GET",
        },
        url: format!("{}{}", environment.rest_base_url(), endpoint.path()),
        requires_signature,
    }
}

pub fn validate_order_against_rules(
    rules: &[ExchangeSymbolRules],
    input: &ExchangeValidationInput,
) -> Result<(), ExchangeValidationError> {
    let rule = rules
        .iter()
        .find(|rule| rule.symbol == input.order.symbol.0)
        .ok_or(ExchangeValidationError::UnknownSymbol)?;

    if input.quantity < rule.min_qty || input.quantity <= 0.0 {
        return Err(ExchangeValidationError::InvalidQuantity);
    }
    if input.price <= 0.0 {
        return Err(ExchangeValidationError::InvalidPrice);
    }
    if input.leverage > rule.max_leverage {
        return Err(ExchangeValidationError::LeverageExceeded);
    }
    if !fits_step(input.quantity, rule.step_size) {
        return Err(ExchangeValidationError::QuantityStepViolation);
    }
    if !fits_step(input.price, rule.tick_size) {
        return Err(ExchangeValidationError::TickSizeViolation);
    }
    if input.quantity * input.price < rule.min_notional {
        return Err(ExchangeValidationError::MinNotionalViolation);
    }

    Ok(())
}

pub fn sign_query_string(query_string: &str, secret: &str) -> Result<String, BinanceHttpError> {
    let mut signer =
        HmacSha256::new_from_slice(secret.as_bytes()).map_err(|error| BinanceHttpError::Http(error.to_string()))?;
    signer.update(query_string.as_bytes());
    Ok(hex::encode(signer.finalize().into_bytes()))
}

pub fn build_signed_request_preview(params: &[(&str, &str)], secret: &str) -> Result<SignedRequestPreview, BinanceHttpError> {
    let query_params = params
        .iter()
        .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
        .collect::<Vec<_>>();
    let query_string = build_query_string(&query_params);
    let signature = sign_query_string(&query_string, secret)?;
    let signing_command_preview = format!("{:?}", build_hmac_command(&query_string, secret));

    Ok(SignedRequestPreview {
        query_string,
        signature,
        signing_command_preview,
    })
}

pub fn build_signed_rest_request(
    environment: BinanceEnvironment,
    endpoint: BinanceEndpoint,
    method: &'static str,
    params: &[(String, String)],
    recv_window_ms: u64,
    credentials: &BinanceCredentials,
) -> Result<SignedRestRequest, BinanceHttpError> {
    let mut query_params = params.to_vec();
    query_params.push(("recvWindow".to_string(), recv_window_ms.to_string()));
    query_params.push(("timestamp".to_string(), current_timestamp_ms().to_string()));
    let query_string = build_query_string(&query_params);
    let signature = sign_query_string(&query_string, &credentials.api_secret)?;

    Ok(SignedRestRequest {
        method,
        url: format!("{}{}", environment.rest_base_url(), endpoint.path()),
        query_string,
        signature,
        api_key_header: credentials.api_key.clone(),
    })
}

pub fn build_stream_url(environment: BinanceEnvironment, symbol: &str, stream: StreamKind) -> String {
    let normalized = symbol.to_lowercase();
    let suffix = match stream {
        StreamKind::BookTicker => "@bookTicker",
        StreamKind::AggTrade => "@aggTrade",
        StreamKind::Kline1m => "@kline_1m",
        StreamKind::MarkPrice => "@markPrice",
    };
    format!("{}/{}{}", environment.websocket_base_url(), normalized, suffix)
}

fn decode_response<T: DeserializeOwned>(response: reqwest::blocking::Response) -> Result<T, BinanceHttpError> {
    let status = response.status();
    let body = response
        .text()
        .map_err(|error| BinanceHttpError::Http(error.to_string()))?;

    if !status.is_success() {
        if let Ok(error) = serde_json::from_str::<BinanceErrorResponse>(&body) {
            return Err(BinanceHttpError::Exchange(error.msg));
        }
        return Err(BinanceHttpError::Http(format!("status {status}: {body}")));
    }

    serde_json::from_str(&body).map_err(|error| BinanceHttpError::Json(error.to_string()))
}

fn build_query_string(params: &[(String, String)]) -> String {
    params
        .iter()
        .map(|(key, value)| format!("{}={}", key, value))
        .collect::<Vec<_>>()
        .join("&")
}

fn format_decimal(value: f64) -> String {
    let mut text = format!("{value:.8}");
    while text.contains('.') && text.ends_with('0') {
        text.pop();
    }
    if text.ends_with('.') {
        text.pop();
    }
    text
}

fn current_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn fits_step(value: f64, step: f64) -> bool {
    if step <= 0.0 {
        return false;
    }
    let rounded = (value / step).round() * step;
    (rounded - value).abs() < 1e-8
}

fn build_hmac_command(query_string: &str, secret: &str) -> Command {
    let mut command = Command::new("openssl");
    command
        .arg("dgst")
        .arg("-sha256")
        .arg("-hmac")
        .arg(secret)
        .arg("-binary");
    command.arg(query_string);
    command
}

fn parse_f64(value: &str) -> Result<f64, BinanceHttpError> {
    value
        .parse::<f64>()
        .map_err(|_| BinanceHttpError::InvalidResponse("numeric string"))
}

fn parse_u8(value: &str) -> Result<u8, BinanceHttpError> {
    value
        .parse::<u8>()
        .map_err(|_| BinanceHttpError::InvalidResponse("u8 string"))
}

#[derive(Debug, Deserialize)]
struct BinanceErrorResponse {
    msg: String,
}

#[derive(Debug, Deserialize)]
struct ExchangeInfoResponse {
    symbols: Vec<ExchangeInfoSymbol>,
}

#[derive(Debug, Deserialize)]
struct ExchangeInfoSymbol {
    symbol: String,
    filters: Vec<ExchangeInfoFilter>,
}

#[derive(Debug, Deserialize)]
struct ExchangeInfoFilter {
    #[serde(rename = "filterType")]
    filter_type: String,
    #[serde(rename = "minNotional")]
    min_notional: Option<String>,
    #[serde(rename = "minQty")]
    min_qty: Option<String>,
    notional: Option<String>,
    #[serde(rename = "stepSize")]
    step_size: Option<String>,
    #[serde(rename = "tickSize")]
    tick_size: Option<String>,
}

impl TryFrom<&ExchangeInfoSymbol> for ExchangeSymbolRules {
    type Error = BinanceHttpError;

    fn try_from(value: &ExchangeInfoSymbol) -> Result<Self, Self::Error> {
        let price_filter = value
            .filters
            .iter()
            .find(|filter| filter.filter_type == "PRICE_FILTER")
            .ok_or(BinanceHttpError::InvalidResponse("PRICE_FILTER"))?;
        let lot_size_filter = value
            .filters
            .iter()
            .find(|filter| filter.filter_type == "LOT_SIZE")
            .ok_or(BinanceHttpError::InvalidResponse("LOT_SIZE"))?;
        let notional_filter = value.filters.iter().find(|filter| {
            filter.filter_type == "MIN_NOTIONAL" || filter.filter_type == "NOTIONAL"
        });

        Ok(Self {
            symbol: value.symbol.clone(),
            tick_size: parse_f64(
                price_filter
                    .tick_size
                    .as_deref()
                    .ok_or(BinanceHttpError::InvalidResponse("tickSize"))?,
            )?,
            step_size: parse_f64(
                lot_size_filter
                    .step_size
                    .as_deref()
                    .ok_or(BinanceHttpError::InvalidResponse("stepSize"))?,
            )?,
            min_qty: parse_f64(
                lot_size_filter
                    .min_qty
                    .as_deref()
                    .ok_or(BinanceHttpError::InvalidResponse("minQty"))?,
            )?,
            min_notional: match notional_filter {
                Some(filter) => match filter.notional.as_deref().or(filter.min_notional.as_deref()) {
                    Some(value) => parse_f64(value)?,
                    None => DEFAULT_MIN_NOTIONAL,
                },
                None => DEFAULT_MIN_NOTIONAL,
            },
            max_leverage: DEFAULT_MAX_LEVERAGE,
        })
    }
}

#[derive(Debug, Deserialize)]
struct BookTickerResponse {
    #[serde(rename = "askPrice")]
    ask_price: String,
    #[serde(rename = "askQty")]
    ask_qty: String,
    #[serde(rename = "bidPrice")]
    bid_price: String,
    #[serde(rename = "bidQty")]
    bid_qty: String,
    symbol: String,
    time: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct BookTickerStreamResponse {
    #[serde(rename = "E")]
    event_time_ms: u64,
    #[serde(rename = "a")]
    ask_price: String,
    #[serde(rename = "A")]
    ask_qty: String,
    #[serde(rename = "b")]
    bid_price: String,
    #[serde(rename = "B")]
    bid_qty: String,
    #[serde(rename = "s")]
    symbol: String,
}

impl TryFrom<BookTickerResponse> for RemoteBookTicker {
    type Error = BinanceHttpError;

    fn try_from(value: BookTickerResponse) -> Result<Self, Self::Error> {
        Ok(Self {
            symbol: value.symbol,
            bid_price: parse_f64(&value.bid_price)?,
            ask_price: parse_f64(&value.ask_price)?,
            bid_qty: parse_f64(&value.bid_qty)?,
            ask_qty: parse_f64(&value.ask_qty)?,
            event_time_ms: value.time.unwrap_or_else(current_timestamp_ms),
        })
    }
}

impl TryFrom<BookTickerStreamResponse> for RemoteBookTicker {
    type Error = BinanceHttpError;

    fn try_from(value: BookTickerStreamResponse) -> Result<Self, Self::Error> {
        Ok(Self {
            symbol: value.symbol,
            bid_price: parse_f64(&value.bid_price)?,
            ask_price: parse_f64(&value.ask_price)?,
            bid_qty: parse_f64(&value.bid_qty)?,
            ask_qty: parse_f64(&value.ask_qty)?,
            event_time_ms: value.event_time_ms,
        })
    }
}

#[derive(Debug, Deserialize)]
struct AccountResponse {
    assets: Vec<AccountAsset>,
    positions: Vec<AccountPosition>,
}

#[derive(Debug, Deserialize)]
struct AccountAsset {
    asset: String,
    #[serde(rename = "walletBalance")]
    wallet_balance: String,
}

#[derive(Debug, Deserialize)]
struct AccountPosition {
    #[serde(rename = "entryPrice")]
    entry_price: String,
    leverage: String,
    #[serde(rename = "positionAmt")]
    position_amt: String,
    symbol: String,
    #[serde(rename = "unrealizedProfit", default = "default_zero_string")]
    unrealized_profit: String,
}

fn default_zero_string() -> String {
    "0".to_string()
}

#[derive(Debug, Deserialize)]
struct OpenOrderResponse {
    #[serde(rename = "clientOrderId")]
    client_order_id: String,
    #[serde(rename = "origQty")]
    orig_qty: String,
    symbol: String,
}

#[derive(Debug, Deserialize)]
struct OrderResponse {
    #[serde(rename = "clientOrderId")]
    client_order_id: String,
    #[serde(rename = "orderId")]
    order_id: i64,
    status: String,
    symbol: String,
}

#[derive(Debug, Deserialize)]
struct UserTradeResponse {
    symbol: String,
    #[serde(rename = "orderId")]
    order_id: i64,
    buyer: bool,
    price: String,
    qty: String,
    #[serde(rename = "realizedPnl")]
    realized_pnl: String,
    time: u64,
}

impl TryFrom<UserTradeResponse> for UserTrade {
    type Error = BinanceHttpError;

    fn try_from(value: UserTradeResponse) -> Result<Self, Self::Error> {
        Ok(Self {
            symbol: value.symbol,
            order_id: value.order_id,
            is_buy: value.buyer,
            price: parse_f64(&value.price)?,
            quantity: parse_f64(&value.qty)?,
            realized_pnl: parse_f64(&value.realized_pnl)?,
            time_ms: value.time,
        })
    }
}

impl TryFrom<Vec<serde_json::Value>> for RemoteKline {
    type Error = BinanceHttpError;

    fn try_from(value: Vec<serde_json::Value>) -> Result<Self, Self::Error> {
        if value.len() < 7 {
            return Err(BinanceHttpError::InvalidResponse("kline"));
        }

        Ok(Self {
            open_time_ms: value[0]
                .as_u64()
                .ok_or(BinanceHttpError::InvalidResponse("kline open time"))?,
            open: parse_f64(value[1].as_str().ok_or(BinanceHttpError::InvalidResponse("kline open"))?)?,
            high: parse_f64(value[2].as_str().ok_or(BinanceHttpError::InvalidResponse("kline high"))?)?,
            low: parse_f64(value[3].as_str().ok_or(BinanceHttpError::InvalidResponse("kline low"))?)?,
            close: parse_f64(value[4].as_str().ok_or(BinanceHttpError::InvalidResponse("kline close"))?)?,
            volume: parse_f64(value[5].as_str().ok_or(BinanceHttpError::InvalidResponse("kline volume"))?)?,
            close_time_ms: value[6]
                .as_u64()
                .ok_or(BinanceHttpError::InvalidResponse("kline close time"))?,
        })
    }
}

impl NewOrderRequest {
    fn validate(&self) -> Result<(), BinanceHttpError> {
        if self.symbol.trim().is_empty() {
            return Err(BinanceHttpError::InvalidOrderRequest("symbol cannot be empty"));
        }
        if self.quantity <= 0.0 {
            return Err(BinanceHttpError::InvalidOrderRequest("quantity must be positive"));
        }
        if self.client_order_id.trim().is_empty() {
            return Err(BinanceHttpError::InvalidOrderRequest("client_order_id cannot be empty"));
        }
        if matches!(self.order_type, OrderType::Limit) && self.price.unwrap_or_default() <= 0.0 {
            return Err(BinanceHttpError::InvalidOrderRequest(
                "limit orders require a positive price",
            ));
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sthyra_domain::{RuntimeMode, TradeDecision};

    fn intent() -> OrderIntent {
        OrderIntent {
            symbol: Symbol::new("BTCUSDT").expect("valid symbol"),
            mode: RuntimeMode::SemiAuto,
            decision: TradeDecision::Approve,
            size_usd: 100.0,
        }
    }

    #[test]
    fn builds_exchange_info_request() {
        let request = build_request(BinanceEnvironment::Testnet, BinanceEndpoint::ExchangeInfo);
        assert_eq!(request.method, "GET");
        assert!(!request.requires_signature);
    }

    #[test]
    fn validates_order_rules() {
        let rules = vec![ExchangeSymbolRules {
            symbol: "BTCUSDT".to_string(),
            tick_size: 0.1,
            step_size: 0.001,
            min_qty: 0.001,
            min_notional: 5.0,
            max_leverage: 20,
        }];
        let input = ExchangeValidationInput {
            order: intent(),
            quantity: 0.005,
            price: 100000.0,
            leverage: 5,
        };

        assert!(validate_order_against_rules(&rules, &input).is_ok());
    }

    #[test]
    fn signs_query_string() {
        let signature = sign_query_string("symbol=BTCUSDT&timestamp=12345", "secret")
            .expect("query signing should succeed");

        assert_eq!(signature.len(), 64);
    }

    #[test]
    fn builds_signed_preview() {
        let preview = build_signed_request_preview(
            &[("symbol", "BTCUSDT"), ("timestamp", "12345")],
            "secret",
        )
        .expect("signed preview should build");

        assert!(preview.query_string.contains("symbol=BTCUSDT"));
        assert!(preview.signing_command_preview.contains("openssl"));
        assert_eq!(preview.signature.len(), 64);
    }

    #[test]
    fn builds_signed_rest_request() {
        let signed = build_signed_rest_request(
            BinanceEnvironment::Testnet,
            BinanceEndpoint::Order,
            "POST",
            &[("symbol".to_string(), "BTCUSDT".to_string())],
            5_000,
            &BinanceCredentials {
                api_key: "key".to_string(),
                api_secret: "secret".to_string(),
            },
        )
        .expect("signed request should build");

        assert_eq!(signed.method, "POST");
        assert!(signed.query_string.contains("recvWindow=5000"));
        assert_eq!(signed.signature.len(), 64);
    }

    #[test]
    fn builds_stream_url() {
        let url = build_stream_url(BinanceEnvironment::Testnet, "BTCUSDT", StreamKind::BookTicker);
        assert!(url.contains("btcusdt@bookTicker"));
    }

    #[test]
    fn parses_exchange_rules_from_exchange_info() {
        let response = serde_json::from_str::<ExchangeInfoResponse>(
            r#"{
                "symbols": [
                    {
                        "symbol": "BTCUSDT",
                        "filters": [
                            {"filterType": "PRICE_FILTER", "tickSize": "0.10"},
                            {"filterType": "LOT_SIZE", "stepSize": "0.001", "minQty": "0.001"},
                            {"filterType": "MIN_NOTIONAL", "notional": "5"}
                        ]
                    }
                ]
            }"#,
        )
        .expect("exchange info should parse");

        let rules = ExchangeSymbolRules::try_from(&response.symbols[0]).expect("rules should parse");
        assert_eq!(rules.symbol, "BTCUSDT");
        assert_eq!(rules.tick_size, 0.1);
        assert_eq!(rules.step_size, 0.001);
    }

    #[test]
    fn converts_book_ticker_to_order_book_snapshot() {
        let ticker = RemoteBookTicker {
            symbol: "BTCUSDT".to_string(),
            bid_price: 100000.0,
            ask_price: 100000.1,
            bid_qty: 12.0,
            ask_qty: 8.0,
            event_time_ms: 12345,
        };

        let snapshot = ticker
            .to_order_book_snapshot()
            .expect("book ticker should convert to order book snapshot");
        assert_eq!(snapshot.symbol.0, "BTCUSDT");
        assert!(snapshot.spread_bps() > 0.0);
    }

    #[test]
    fn parses_stream_book_ticker_payload() {
        let response = serde_json::from_str::<BookTickerStreamResponse>(
            r#"{
                "e":"bookTicker",
                "u":400900217,
                "E":1568014460893,
                "T":1568014460891,
                "s":"BTCUSDT",
                "b":"10000.1",
                "B":"5.0",
                "a":"10000.3",
                "A":"4.0"
            }"#,
        )
        .expect("stream payload should parse");

        let ticker = RemoteBookTicker::try_from(response).expect("stream ticker should normalize");
        assert_eq!(ticker.symbol, "BTCUSDT");
        assert_eq!(ticker.event_time_ms, 1_568_014_460_893);
    }

    #[test]
    fn parses_account_snapshot_payloads() {
        let account = serde_json::from_str::<AccountResponse>(
            r#"{
                "assets": [
                    {"asset": "USDT", "walletBalance": "123.45"},
                    {"asset": "BNB", "walletBalance": "0.00000000"}
                ],
                "positions": [
                    {"symbol": "BTCUSDT", "positionAmt": "0.010", "entryPrice": "100000", "leverage": "5", "unrealizedProfit": "12.5"},
                    {"symbol": "ETHUSDT", "positionAmt": "0.000", "entryPrice": "2500", "leverage": "3", "unrealizedProfit": "0"}
                ]
            }"#,
        )
        .expect("account payload should parse");
        let open_orders = serde_json::from_str::<Vec<OpenOrderResponse>>(
            r#"[
                {"symbol": "BTCUSDT", "clientOrderId": "abc", "origQty": "0.001"}
            ]"#,
        )
        .expect("open orders payload should parse");

        let snapshot = AccountSnapshot {
            balances: account
                .assets
                .into_iter()
                .filter_map(|asset| {
                    let wallet_balance = parse_f64(&asset.wallet_balance).ok()?;
                    if wallet_balance.abs() < 1e-8 {
                        return None;
                    }
                    Some(AccountBalance {
                        asset: asset.asset,
                        wallet_balance,
                    })
                })
                .collect(),
            positions: account
                .positions
                .into_iter()
                .filter_map(|position| {
                    let quantity = parse_f64(&position.position_amt).ok()?;
                    if quantity.abs() < 1e-8 {
                        return None;
                    }
                    Some(PositionState {
                        symbol: position.symbol,
                        quantity,
                        entry_price: parse_f64(&position.entry_price).ok()?,
                        leverage: parse_u8(&position.leverage).ok()?,
                        unrealized_pnl: parse_f64(&position.unrealized_profit).unwrap_or(0.0),
                    })
                })
                .collect(),
            open_orders: open_orders
                .into_iter()
                .map(|order| OpenOrderState {
                    symbol: order.symbol,
                    client_order_id: order.client_order_id,
                    quantity: parse_f64(&order.orig_qty).expect("orig qty should parse"),
                })
                .collect(),
        };

        assert_eq!(snapshot.balances.len(), 1);
        assert_eq!(snapshot.positions.len(), 1);
        assert_eq!(snapshot.open_orders.len(), 1);
        assert_eq!(snapshot.positions[0].unrealized_pnl, 12.5);
    }

    #[test]
    fn validates_limit_order_request() {
        let error = NewOrderRequest {
            symbol: "BTCUSDT".to_string(),
            side: OrderSide::Buy,
            order_type: OrderType::Limit,
            quantity: 0.001,
            price: None,
            reduce_only: false,
            client_order_id: "id-1".to_string(),
        }
        .validate()
        .expect_err("limit order without price should fail");

        assert!(matches!(error, BinanceHttpError::InvalidOrderRequest(_)));
    }
}