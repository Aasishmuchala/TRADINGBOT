use std::env;
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

use reqwest::blocking::Client;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Headline {
    pub text: String,
    pub source: String,
    pub published_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NewsSentimentSnapshot {
    pub sentiment_score: f64,
    pub confidence: f64,
    pub catalyst_score: f64,
    pub risk_off: bool,
    pub themes: Vec<String>,
}

impl Default for NewsSentimentSnapshot {
    fn default() -> Self {
        Self {
            sentiment_score: 0.0,
            confidence: 0.0,
            catalyst_score: 0.0,
            risk_off: false,
            themes: Vec::new(),
        }
    }
}

pub fn score_headlines(headlines: &[Headline]) -> NewsSentimentSnapshot {
    if headlines.is_empty() {
        return NewsSentimentSnapshot::default();
    }

    let positive_terms = [
        "beat",
        "approval",
        "upgrade",
        "surge",
        "growth",
        "breakout",
        "partnership",
        "adoption",
        "bullish",
        "inflow",
    ];
    let negative_terms = [
        "miss",
        "downgrade",
        "hack",
        "lawsuit",
        "liquidation",
        "outflow",
        "recession",
        "ban",
        "crackdown",
        "bearish",
    ];
    let risk_off_terms = [
        "war",
        "emergency",
        "default",
        "bank run",
        "crisis",
        "terror",
        "black swan",
        "sanction",
        "exchange halt",
        "systemic",
    ];
    let catalyst_terms = [
        "fed",
        "cpi",
        "nfp",
        "fomc",
        "etf",
        "earnings",
        "rate cut",
        "rate hike",
        "guidance",
        "launch",
    ];

    let mut sentiment_accumulator = 0.0;
    let mut catalyst_hits = 0.0;
    let mut risk_off = false;
    let mut themes = Vec::new();

    for headline in headlines {
        let lowered = headline.text.to_lowercase();

        let positive_hits = positive_terms.iter().filter(|term| lowered.contains(**term)).count() as f64;
        let negative_hits = negative_terms.iter().filter(|term| lowered.contains(**term)).count() as f64;
        let risk_off_hits = risk_off_terms.iter().filter(|term| lowered.contains(**term)).count() as f64;
        let catalyst_term_hits = catalyst_terms.iter().filter(|term| lowered.contains(**term)).count() as f64;

        sentiment_accumulator += positive_hits * 0.2;
        sentiment_accumulator -= negative_hits * 0.24;
        sentiment_accumulator -= risk_off_hits * 0.35;
        catalyst_hits += catalyst_term_hits;

        if risk_off_hits > 0.0 {
            risk_off = true;
        }

        for theme in ["macro", "crypto", "earnings", "policy", "liquidity"] {
            if lowered.contains(theme) && !themes.iter().any(|existing| existing == theme) {
                themes.push(theme.to_string());
            }
        }
    }

    let headline_count = headlines.len() as f64;
    NewsSentimentSnapshot {
        sentiment_score: (sentiment_accumulator / headline_count).clamp(-1.0, 1.0),
        confidence: (headline_count / 8.0).clamp(0.0, 1.0),
        catalyst_score: (catalyst_hits / headline_count).clamp(0.0, 1.0),
        risk_off,
        themes,
    }
}

pub fn collect_headlines(local_path: &str) -> Vec<Headline> {
    let mut headlines = fetch_external_headlines();
    headlines.extend(load_local_headlines(local_path));
    headlines.sort_by(|left, right| right.published_at_ms.cmp(&left.published_at_ms));
    headlines.truncate(64);
    headlines
}

pub fn fetch_external_headlines() -> Vec<Headline> {
    let client = match Client::builder().timeout(std::time::Duration::from_secs(8)).build() {
        Ok(client) => client,
        Err(_) => return Vec::new(),
    };
    let mut headlines = Vec::new();

    if let Ok(url) = env::var("STHYRA_NEWSAPI_URL") {
        headlines.extend(fetch_json_news(&client, &url));
    }

    if let Ok(urls) = env::var("STHYRA_RSS_URLS") {
        for url in urls.split(',').map(str::trim).filter(|url| !url.is_empty()) {
            headlines.extend(fetch_rss_news(&client, url));
        }
    }

    headlines
}

fn load_local_headlines(path: &str) -> Vec<Headline> {
    fs::read_to_string(path)
        .ok()
        .map(|contents| {
            contents
                .lines()
                .filter(|line| !line.trim().is_empty())
                .take(64)
                .map(|line| Headline {
                    text: line.trim().to_string(),
                    source: "local-file".to_string(),
                    published_at_ms: current_timestamp_ms(),
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn fetch_json_news(client: &Client, url: &str) -> Vec<Headline> {
    let response = match client.get(url).send() {
        Ok(response) => response,
        Err(_) => return Vec::new(),
    };
    let value = match response.json::<Value>() {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };

    let articles = value
        .get("articles")
        .and_then(Value::as_array)
        .or_else(|| value.get("results").and_then(Value::as_array))
        .cloned()
        .unwrap_or_default();

    articles
        .into_iter()
        .filter_map(|article| {
            let title = article.get("title").and_then(Value::as_str)?;
            if title.trim().is_empty() {
                return None;
            }
            let source = article
                .get("source")
                .and_then(|source| source.get("name").or(Some(source)))
                .and_then(Value::as_str)
                .unwrap_or("external-json");

            Some(Headline {
                text: title.to_string(),
                source: source.to_string(),
                published_at_ms: current_timestamp_ms(),
            })
        })
        .collect()
}

fn fetch_rss_news(client: &Client, url: &str) -> Vec<Headline> {
    let response = match client.get(url).send() {
        Ok(response) => response,
        Err(_) => return Vec::new(),
    };
    let text = match response.text() {
        Ok(text) => text,
        Err(_) => return Vec::new(),
    };

    extract_rss_titles(&text)
        .into_iter()
        .map(|title| Headline {
            text: title,
            source: url.to_string(),
            published_at_ms: current_timestamp_ms(),
        })
        .collect()
}

fn extract_rss_titles(xml: &str) -> Vec<String> {
    let mut titles = Vec::new();
    let mut remaining = xml;

    while let Some(start) = remaining.find("<title>") {
        let after_start = &remaining[start + "<title>".len()..];
        let Some(end) = after_start.find("</title>") else {
            break;
        };
        let title = after_start[..end]
            .replace("<![CDATA[", "")
            .replace("]]>", "")
            .trim()
            .to_string();
        if !title.is_empty() && !titles.iter().any(|existing| existing == &title) {
            titles.push(title);
        }
        remaining = &after_start[end + "</title>".len()..];
        if titles.len() >= 32 {
            break;
        }
    }

    titles.into_iter().skip(1).collect()
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

    #[test]
    fn flags_risk_off_headlines() {
        let snapshot = score_headlines(&[Headline {
            text: "Emergency exchange halt after systemic liquidity crisis".to_string(),
            source: "wire".to_string(),
            published_at_ms: 1,
        }]);

        assert!(snapshot.risk_off);
        assert!(snapshot.sentiment_score < 0.0);
    }

    #[test]
    fn scores_positive_catalyst_news() {
        let snapshot = score_headlines(&[Headline {
            text: "ETF approval and strong inflow spark bullish breakout".to_string(),
            source: "wire".to_string(),
            published_at_ms: 1,
        }]);

        assert!(snapshot.sentiment_score > 0.0);
        assert!(snapshot.catalyst_score > 0.0);
    }

    #[test]
    fn parses_rss_titles() {
        let titles = extract_rss_titles(
            "<rss><channel><title>Feed</title><item><title>Headline One</title></item><item><title>Headline Two</title></item></channel></rss>",
        );

        assert_eq!(titles.len(), 2);
        assert_eq!(titles[0], "Headline One");
    }
}