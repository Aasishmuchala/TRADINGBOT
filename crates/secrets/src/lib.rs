use std::process::Command;

/// macOS Keychain secret reference.
/// On macOS this builds `/usr/bin/security` commands.
/// On Windows the credential layer lives in the Next.js API (trading-settings.ts)
/// using cmdkey + PowerShell Get-StoredCredential — not in this Rust crate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeychainSecretRef {
    pub service: String,
    pub account: String,
}

impl KeychainSecretRef {
    pub fn build_find_command(&self) -> Command {
        #[cfg(target_os = "windows")]
        {
            // On Windows: preview command using cmdkey for diagnostic display only.
            // Real reads use PowerShell Get-StoredCredential in the Node.js layer.
            let mut command = Command::new("cmdkey");
            command
                .arg(format!("/list:{}/{}", self.service, self.account));
            command
        }
        #[cfg(not(target_os = "windows"))]
        {
            let mut command = Command::new("/usr/bin/security");
            command
                .arg("find-generic-password")
                .arg("-s")
                .arg(&self.service)
                .arg("-a")
                .arg(&self.account)
                .arg("-w");
            command
        }
    }

    pub fn build_store_command(&self, secret: &str) -> Command {
        #[cfg(target_os = "windows")]
        {
            let mut command = Command::new("cmdkey");
            command
                .arg(format!("/add:{}/{}", self.service, self.account))
                .arg(format!("/user:{}", self.account))
                .arg(format!("/pass:{}", secret));
            command
        }
        #[cfg(not(target_os = "windows"))]
        {
            let mut command = Command::new("/usr/bin/security");
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
        // On macOS: contains "find-generic-password"; on Windows: contains "cmdkey"
        #[cfg(target_os = "windows")]
        assert!(debug.contains("cmdkey"));
        #[cfg(not(target_os = "windows"))]
        assert!(debug.contains("find-generic-password"));
    }
}
