"""Telegram Alert Module — Send alerts via Telegram bot."""
import asyncio
from typing import Optional

import structlog

logger = structlog.get_logger()


class TelegramAlerter:
    """Sends formatted alerts to a Telegram chat."""

    def __init__(self, bot_token: str, chat_id: str):
        self.bot_token = bot_token
        self.chat_id = chat_id
        self.enabled = bool(bot_token and chat_id)
        self._bot = None

    async def _get_bot(self):
        if self._bot is None and self.enabled:
            try:
                from telegram import Bot
                self._bot = Bot(token=self.bot_token)
            except ImportError:
                logger.warning("telegram.library_not_installed")
                self.enabled = False
        return self._bot

    async def send(self, message: str, parse_mode: str = "HTML"):
        """Send a message to the configured chat."""
        if not self.enabled:
            return

        try:
            bot = await self._get_bot()
            if bot:
                await bot.send_message(
                    chat_id=self.chat_id,
                    text=message,
                    parse_mode=parse_mode,
                )
        except Exception as e:
            logger.error("telegram.send_failed", error=str(e))

    async def send_alert(self, alert_type: str, data: dict):
        """Format and send a structured alert."""
        formatters = {
            "degradation_tier_change": self._format_tier_change,
            "distribution_shift": self._format_psi_alert,
            "model_retrained": self._format_retrain_alert,
            "latency_critical": self._format_latency_alert,
            "daily_summary": self._format_daily_summary,
        }

        formatter = formatters.get(alert_type, self._format_generic)
        message = formatter(data)
        await self.send(message)

    def _format_tier_change(self, data: dict) -> str:
        emoji = {"full": "🟢", "reduced": "🟡", "minimal": "🟠", "emergency": "🔴"}
        new_tier = data.get("new_tier", "unknown")
        return (
            f"{emoji.get(new_tier, '⚪')} <b>Degradation Tier Change</b>\n"
            f"Old: {data.get('old_tier', '?')} → New: {new_tier}\n"
            f"Services down: {', '.join(data.get('services_down', []))}"
        )

    def _format_psi_alert(self, data: dict) -> str:
        alerts = data.get("alerts", [])
        lines = ["⚠️ <b>Distribution Shift Detected</b>"]
        for a in alerts:
            lines.append(f"  • {a['feature']}: PSI={a['psi']} ({a['status']})")
        return "\n".join(lines)

    def _format_retrain_alert(self, data: dict) -> str:
        metrics = data.get("metrics", {})
        return (
            f"🔄 <b>Model Retrained</b>\n"
            f"Accuracy: {metrics.get('accuracy', 'N/A')}\n"
            f"Samples: {data.get('samples', 'N/A')}"
        )

    def _format_latency_alert(self, data: dict) -> str:
        return (
            f"🐌 <b>High Latency Alert</b>\n"
            f"Exchange: {data.get('exchange', '?')}\n"
            f"RTT: {data.get('rtt_ms', '?')}ms (threshold: {data.get('threshold_ms', '?')}ms)"
        )

    def _format_daily_summary(self, data: dict) -> str:
        return (
            f"📊 <b>Daily Summary</b>\n"
            f"P&L: ${data.get('pnl', 0):.2f}\n"
            f"Trades: {data.get('trades', 0)}\n"
            f"Win Rate: {data.get('win_rate', 0):.1%}\n"
            f"Regime: {data.get('regime', 'unknown')}"
        )

    def _format_generic(self, data: dict) -> str:
        return f"ℹ️ Alert: {data}"