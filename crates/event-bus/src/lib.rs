use sthyra_domain::RuntimeMode;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineTopic {
    Health,
    MarketData,
    Orders,
    Risk,
    Strategy,
    Supervisor,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeartbeatEvent {
    pub engine_name: &'static str,
    pub mode: RuntimeMode,
    pub sequence: u64,
}

pub trait EventPublisher {
    type Error;

    fn publish(&mut self, topic: EngineTopic, payload: String) -> Result<(), Self::Error>;
}

#[derive(Debug, Default)]
pub struct InMemoryEventBus {
    pub events: Vec<(EngineTopic, String)>,
}

impl EventPublisher for InMemoryEventBus {
    type Error = std::convert::Infallible;

    fn publish(&mut self, topic: EngineTopic, payload: String) -> Result<(), Self::Error> {
        self.events.push((topic, payload));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collects_published_events() {
        let mut bus = InMemoryEventBus::default();
        bus.publish(EngineTopic::Supervisor, "booted".to_string())
            .expect("publish should succeed");

        assert_eq!(bus.events.len(), 1);
    }
}
