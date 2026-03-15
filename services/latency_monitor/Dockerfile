FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY config/ ./config/
COPY core/ ./core/
COPY services/latency_monitor/ ./services/latency_monitor/

ENV PYTHONPATH=/app
CMD ["python", "-m", "services.latency_monitor.main"]