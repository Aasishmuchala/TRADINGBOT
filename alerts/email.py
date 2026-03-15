"""Email Alert Module — Send alerts via SMTP."""
import asyncio
from typing import Optional
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

import structlog

logger = structlog.get_logger()


class EmailAlerter:
    """Sends formatted alerts via SMTP email."""

    def __init__(
        self,
        smtp_host: str,
        smtp_port: int,
        smtp_user: str,
        smtp_pass: str,
        alert_email: str,
    ):
        self.smtp_host = smtp_host
        self.smtp_port = smtp_port
        self.smtp_user = smtp_user
        self.smtp_pass = smtp_pass
        self.alert_email = alert_email
        self.enabled = bool(smtp_host and smtp_user and alert_email)

    async def send(self, subject: str, body: str, html: bool = False):
        """Send an email alert."""
        if not self.enabled:
            return

        try:
            import aiosmtplib

            msg = MIMEMultipart("alternative")
            msg["From"] = self.smtp_user
            msg["To"] = self.alert_email
            msg["Subject"] = f"[Trading Bot] {subject}"

            content_type = "html" if html else "plain"
            msg.attach(MIMEText(body, content_type))

            await aiosmtplib.send(
                msg,
                hostname=self.smtp_host,
                port=self.smtp_port,
                username=self.smtp_user,
                password=self.smtp_pass,
                use_tls=True,
            )

            logger.info("email.sent", subject=subject, to=self.alert_email)

        except ImportError:
            logger.warning("email.aiosmtplib_not_installed")
        except Exception as e:
            logger.error("email.send_failed", error=str(e))

    async def send_alert(self, alert_type: str, data: dict):
        """Format and send an alert email."""
        subject_map = {
            "degradation_tier_change": f"⚠️ Tier Change: {data.get('new_tier', '?')}",
            "distribution_shift": "⚠️ Distribution Shift Detected",
            "model_retrained": "🔄 Model Retrained",
            "latency_critical": f"🐌 High Latency: {data.get('exchange', '?')}",
            "daily_summary": f"📊 Daily P&L: ${data.get('pnl', 0):.2f}",
        }

        subject = subject_map.get(alert_type, f"Alert: {alert_type}")

        # Build HTML body
        body = f"<h2>{subject}</h2><pre>{self._format_data(data)}</pre>"
        await self.send(subject, body, html=True)

    def _format_data(self, data: dict, indent: int = 0) -> str:
        """Pretty format a dict for email body."""
        lines = []
        prefix = "  " * indent
        for key, value in data.items():
            if isinstance(value, dict):
                lines.append(f"{prefix}{key}:")
                lines.append(self._format_data(value, indent + 1))
            elif isinstance(value, list):
                lines.append(f"{prefix}{key}: [{len(value)} items]")
            else:
                lines.append(f"{prefix}{key}: {value}")
        return "\n".join(lines)