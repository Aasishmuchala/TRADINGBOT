use std::process::Command;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeychainSecretRef {
    pub service: String,
    pub account: String,
}

impl KeychainSecretRef {
    pub fn build_find_command(&self) -> Command {
        let mut command = Command::new("security");
        command
            .arg("find-generic-password")
            .arg("-s")
            .arg(&self.service)
            .arg("-a")
            .arg(&self.account)
            .arg("-w");
        command
    }

    pub fn build_store_command(&self, secret: &str) -> Command {
        let mut command = Command::new("security");
        command
            .arg("add-generic-password")
            .arg("-U")
            .arg("-s")
            .arg(&self.service)
            .arg("-a")
            .arg(&self.account)
            .arg("-w")
            .arg(secret);
        command
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_find_command() {
        let secret_ref = KeychainSecretRef {
            service: "sthyra.binance".to_string(),
            account: "api-key".to_string(),
        };

        let command = secret_ref.build_find_command();
        let debug = format!("{:?}", command);
        assert!(debug.contains("find-generic-password"));
    }
}
