FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY config/ ./config/
COPY core/ ./core/
COPY services/strategy_runner/ ./services/strategy_runner/
COPY strategies/ ./strategies/

ENV PYTHONPATH=/app
CMD ["python", "-m", "services.strategy_runner.main"]